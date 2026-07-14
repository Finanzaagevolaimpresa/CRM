import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';

const root = process.cwd();
const actionsPath = resolve(root, 'src/lib/actions.ts');
const actionsText = readFileSync(actionsPath, 'utf8');
const actionsSource = ts.createSourceFile(actionsPath, actionsText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

function functionBody(name: string) {
  let declaration: ts.FunctionDeclaration | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) declaration = node;
    if (!declaration) ts.forEachChild(node, visit);
  };
  visit(actionsSource);
  assert.ok(declaration?.body, `Funzione ${name} non trovata`);
  return declaration.body.getText(actionsSource);
}

test('la conversione lead è idempotente e protetta da vincolo DB e compare-and-swap', () => {
  const schema = readFileSync(resolve(root, 'prisma/schema.prisma'), 'utf8');
  const migration = readFileSync(resolve(root, 'prisma/migrations/20260714123000_harden_ai_runs_and_lead_conversion/migration.sql'), 'utf8');
  const body = functionBody('convertLeadToClient');

  assert.match(schema, /leadId\s+String\?\s+@unique/);
  assert.match(migration, /GROUP BY "leadId"[\s\S]*HAVING COUNT\(\*\) > 1/);
  assert.match(migration, /CREATE UNIQUE INDEX "Client_leadId_key"/);
  assert.match(body, /prisma\.\$transaction/);
  assert.match(body, /tx\.client\.create/);
  assert.match(body, /tx\.lead\.updateMany/);
  assert.match(body, /clientId: null, updatedAt: lead\.updatedAt/);
  assert.match(body, /isUniqueConstraintError/);
  assert.match(actionsText, /error\.code === 'P2002'/);
});

test('modifica e archiviazione dossier usano CAS e audit nella stessa transazione', () => {
  for (const action of ['updateClientDossier', 'archiveClientDossier']) {
    const body = functionBody(action);
    assert.match(body, /prisma\.\$transaction/);
    assert.match(body, /tx\.clientDossier\.updateMany/);
    assert.match(body, /updatedAt: before\.updatedAt/);
    assert.match(body, /result\.count !== 1/);
    assert.match(body, /tx\.auditLog\.create/);
    assert.doesNotMatch(body, /after: \{ before, after: dossier \}/);
  }
});

test('la revisione dossier è separata dalla modifica e conserva prova del revisore', () => {
  const schema = readFileSync(resolve(root, 'prisma/schema.prisma'), 'utf8');
  const migration = readFileSync(resolve(root, 'prisma/migrations/20260714133000_add_client_dossier_review_proof/migration.sql'), 'utf8');
  const approval = functionBody('approveClientDossier');
  const update = functionBody('updateClientDossier');

  assert.match(schema, /reviewedById\s+String\?/);
  assert.match(schema, /reviewedAt\s+DateTime\?/);
  assert.match(migration, /ADD COLUMN "reviewedById" TEXT/);
  assert.match(approval, /requirePermission\('dossier\.approve'\)/);
  assert.match(approval, /before\.createdById === s\.userId \|\| before\.updatedById === s\.userId/);
  assert.match(approval, /tx\.clientDossier\.updateMany/);
  assert.match(approval, /reviewedById: s\.userId, reviewedAt: now/);
  assert.match(approval, /tx\.auditLog\.create/);
  assert.match(update, /azione di approvazione separata/);
  assert.match(update, /reviewedById: data\.status === 'bozza' \? null/);
});

test('review e approval fissano la versione letta e rendono mutazione e audit atomici', () => {
  const review = functionBody('reviewAiOutput');
  const approval = functionBody('approveAiOutput');

  for (const body of [review, approval]) {
    assert.match(body, /prisma\.\$transaction/);
    assert.match(body, /tx\.aiOutput\.updateMany/);
    assert.match(body, /updatedAt: current\.updatedAt/);
    assert.match(body, /tx\.auditLog\.(?:create|createMany)/);
  }
  assert.match(review, /reviewedById: null/);
  assert.match(review, /approvedById: null/);
  assert.match(approval, /reviewedById: current\.reviewedById/);
  assert.match(approval, /reviewedAt: current\.reviewedAt/);
  assert.match(approval, /approvedById: null/);
  assert.match(approval, /NOT: \{ reviewedById: s\.userId \}/);
  assert.match(approval, /NOT: \{ reviewedById: s\.userId \}/);
});

test('la conversione output AI richiede prova umana completa ed è idempotente anche nelle race', () => {
  const body = functionBody('createClientDossierFromAiOutput');

  assert.match(body, /output\.status === 'approved'/);
  assert.match(body, /output\.requiresHumanReview === true/);
  for (const field of ['reviewedById', 'reviewedAt', 'approvedById', 'approvedAt']) {
    assert.ok(body.includes(`output.${field}`), `Prova ${field} assente`);
  }
  assert.match(body, /run\.createdById !== output\.reviewedById/);
  assert.match(body, /run\.createdById !== output\.approvedById/);
  assert.match(body, /output\.reviewedById !== output\.approvedById/);
  assert.match(body, /sourceAiOutputId: output\.id/);
  assert.match(body, /isUniqueConstraintError/);
  assert.match(body, /getClientDossierReadAccess/);
});

test('il run cliente usa il provider configurato sull agente e persiste il lifecycle prima della chiamata', () => {
  const body = functionBody('runClientAiAgent');
  const createRun = body.indexOf('prisma.aiRun.create');
  const providerCall = body.indexOf('agentRuntime.adapter.run');

  assert.match(body, /resolveAiAgentRuntime\(agent\.provider, agent\.futureModel\)/);
  assert.match(functionBody('resolveAiAgentRuntime'), /new MockAiAdapter/);
  assert.match(functionBody('resolveAiAgentRuntime'), /new OpenAiAdapter/);
  assert.match(functionBody('resolveAiAgentRuntime'), /configuredModel\?\.trim\(\)/);
  assert.ok(createRun >= 0 && createRun < providerCall, 'AiRun running deve esistere prima della chiamata al provider');
  assert.match(body.slice(createRun, providerCall), /status: 'running'/);
  assert.match(body.slice(createRun, providerCall), /provider: agentRuntime\.provider/);
  assert.match(body.slice(createRun, providerCall), /promptVersion: agent\.promptVersion/);
  assert.match(body, /status: 'failed'/);
  assert.match(body, /status: 'completed'/);
  assert.doesNotMatch(body, /getAiAdapter|normalizeAiProvider/);
});

test('il payload AI usa task accessibili e non inoltra campi liberi o identificativi non necessari', () => {
  const body = functionBody('runClientAiAgent');
  const inputStart = body.indexOf('const input');
  const inputEnd = body.indexOf('const providerInput');
  assert.ok(inputStart >= 0 && inputEnd > inputStart);
  const payload = body.slice(inputStart, inputEnd);

  assert.match(body, /listAccessibleTasks\(s,/);
  assert.match(body, /canViewChecklistItem\(s,/);
  assert.doesNotMatch(payload, /displayName|client\.notes|company\.name|operationalNotes|scenarioA|scenarioB/);
  assert.doesNotMatch(payload, /task\.title|task\.description|document\.title/);
  assert.doesNotMatch(payload, /documentId: item\.documentId/);
  assert.match(payload, /hasLinkedDocument: Boolean\(item\.documentId\)/);
  assert.match(functionBody('buildClientDossierContent'), /listAccessibleTasks\(session,/);
  assert.match(functionBody('assertClientDossierContext'), /canViewClient\(session, access\.client\)/);
  assert.match(body, /linkedCompanyId \|\| canViewWholeClient/);
});

test('output completo e messaggi di errore non vengono duplicati in AiRun o audit', () => {
  const runBody = functionBody('runClientAiAgent');
  const summary = functionBody('aiRunOutputSummary');

  assert.doesNotMatch(runBody, /output: draft/);
  assert.match(runBody, /output: aiRunOutputSummary\(draft\)/);
  assert.match(summary, /contentLength/);
  assert.doesNotMatch(summary, /content:\s*draft\.content/);
  assert.doesNotMatch(runBody, /error\.message/);
  assert.match(runBody, /errorCode:/);
});
