import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import type { RoleCode } from '@prisma/client';
import ts from 'typescript';
import {
  canEditChecklistItem,
  canEditCommercialOffer,
  canEditDocument,
  canEditService,
  canEditTask,
  canEditTechnicalPractice,
} from '../src/lib/access-control';

const actor = (role: RoleCode, userId = 'user-1') => ({ role, userId });
const client = (id: string, salesOwnerId: string | null = null, consultantId: string | null = null) => ({
  id,
  salesOwnerId,
  consultantId,
});
const project = (clientId: string, consultantId: string | null = null) => ({
  clientId,
  consultantId,
  client: client(clientId, null, consultantId),
});
const service = (clientId: string, assignedToId: string | null = null) => ({
  clientId,
  assignedToId,
  client: client(clientId, null, assignedToId),
  project: project(clientId, assignedToId),
});
const document = (overrides: Record<string, unknown> = {}) => ({
  clientId: 'client-1',
  uploadedById: 'user-1',
  containsSensitiveData: false,
  documentCategory: 'altro',
  type: 'application/pdf',
  client: client('client-1', null, 'user-1'),
  project: null,
  clientService: null,
  ...overrides,
});

test('un offerta con lead e cliente cross-client e negata anche al creatore e ai ruoli globali', () => {
  const inconsistentOffer = {
    createdById: 'user-1',
    leadId: 'lead-1',
    clientId: 'client-2',
    lead: { assignedToId: 'user-1', clientId: 'client-1' },
    client: client('client-2', 'user-1'),
  };

  assert.equal(canEditCommercialOffer(actor('commerciale'), inconsistentOffer), false);
  assert.equal(canEditCommercialOffer(actor('admin'), inconsistentOffer), false);
  assert.equal(canEditCommercialOffer(actor('direzione'), inconsistentOffer), false);
});

test('il permesso ai documenti sensibili non supera mai la separazione tra clienti', () => {
  const sensitiveOwnedDocument = document({ containsSensitiveData: true });
  assert.equal(canEditDocument(actor('consulente'), sensitiveOwnedDocument), false);
  assert.equal(canEditDocument(actor('consulente'), sensitiveOwnedDocument, true), true);

  const crossClientSensitiveDocument = document({
    containsSensitiveData: true,
    project: project('client-2', 'user-1'),
    clientService: service('client-2', 'user-1'),
  });
  assert.equal(canEditDocument(actor('consulente'), crossClientSensitiveDocument, true), false);
  assert.equal(canEditDocument(actor('admin'), crossClientSensitiveDocument, true), false);
  assert.equal(canEditDocument(actor('backoffice'), crossClientSensitiveDocument, true), false);
});

test('servizi, task e checklist rifiutano contesti cross-client prima delle ownership', () => {
  const foreignService = service('client-2', 'user-1');

  assert.equal(canEditService(actor('consulente'), { ...foreignService, clientId: 'client-1' }), false);
  assert.equal(canEditService(actor('backoffice'), { ...foreignService, clientId: 'client-1' }), false);
  assert.equal(canEditTask(actor('consulente'), {
    clientId: 'client-1',
    assignedToId: 'user-1',
    createdById: 'user-1',
    project: project('client-2', 'user-1'),
  }), false);
  assert.equal(canEditChecklistItem(actor('consulente'), {
    clientId: 'client-1',
    createdById: 'user-1',
    updatedById: 'user-1',
    clientService: foreignService,
  }), false);
});

test('la pratica tecnica del consulente resta limitata al titolare tecnico', () => {
  assert.equal(canEditTechnicalPractice(actor('consulente'), { technicalOwnerId: 'user-1' }), true);
  assert.equal(canEditTechnicalPractice(actor('consulente'), { technicalOwnerId: 'user-2' }), false);
  assert.equal(canEditTechnicalPractice(actor('commerciale'), { technicalOwnerId: 'user-1' }), false);
});

const actionsPath = resolve(process.cwd(), 'src/lib/actions.ts');
const actionsSourceText = readFileSync(actionsPath, 'utf8');
const actionsSource = ts.createSourceFile(actionsPath, actionsSourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

function functionBody(name: string, source = actionsSource) {
  let declaration: ts.FunctionDeclaration | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) declaration = node;
    if (!declaration) ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(declaration?.body, `Funzione ${name} non trovata`);
  return declaration.body.getText(source);
}

function assertGuardsBeforeMutation(action: string, guards: readonly string[], mutation: string) {
  const body = functionBody(action);
  const mutationIndex = body.indexOf(mutation);
  assert.notEqual(mutationIndex, -1, `${action}: mutazione ${mutation} non trovata`);
  for (const guard of guards) {
    const guardIndex = body.indexOf(guard);
    assert.notEqual(guardIndex, -1, `${action}: guardia ${guard} assente`);
    assert.ok(guardIndex < mutationIndex, `${action}: guardia ${guard} invocata dopo la mutazione`);
  }
}

test('lead e offerte invocano le guardie ABAC prima di ogni mutazione critica', () => {
  assertGuardsBeforeMutation('updateLeadCommercial', ['requireLeadEditAccess'], 'prisma.lead.update');
  assertGuardsBeforeMutation('convertLeadToClient', ['requireLeadEditAccess'], 'tx.client.create');
  assertGuardsBeforeMutation('createCommercialOffer', ['requireCommercialOfferTargetAccess'], 'prisma.commercialOffer.create');
  assertGuardsBeforeMutation(
    'updateCommercialOffer',
    ['requireCommercialOfferEditAccess', 'requireCommercialOfferTargetAccess'],
    'prisma.commercialOffer.update',
  );
  assert.match(functionBody('auditCommercialOfferExport'), /requireCommercialOfferEditAccess/);
});

test('documenti e checklist invocano le guardie ABAC prima delle scritture', () => {
  assertGuardsBeforeMutation('uploadDocument', ['requireClientContextWriteAccess'], 'prisma.document.create');
  assertGuardsBeforeMutation(
    'linkDocumentToService',
    ['requireDocumentEditAccess', 'requireServiceEditAccess'],
    'prisma.document.update',
  );
  assert.match(
    functionBody('linkDocumentToService'),
    /currentDocument\.clientServiceId[\s\S]*requireServiceEditAccess\(s, currentDocument\.clientServiceId\)/,
    'linkDocumentToService: manca la guardia sul servizio sorgente',
  );
  assertGuardsBeforeMutation('updateDocumentSection', ['requireDocumentEditAccess'], 'prisma.document.update');
  assertGuardsBeforeMutation('createDocumentChecklistItem', ['assertChecklistContext'], 'prisma.documentChecklistItem.create');
  assertGuardsBeforeMutation('createStandardDocumentChecklist', ['assertChecklistContext'], 'prisma.$transaction');
  assertGuardsBeforeMutation('updateDocumentChecklistItemStatus', ['requireChecklistEditAccess'], 'prisma.documentChecklistItem.update');
  assertGuardsBeforeMutation(
    'linkDocumentToChecklistItem',
    ['requireChecklistEditAccess', 'assertChecklistContext'],
    'prisma.documentChecklistItem.update',
  );
  assertGuardsBeforeMutation('unlinkDocumentFromChecklistItem', ['requireChecklistEditAccess'], 'prisma.documentChecklistItem.update');
  assertGuardsBeforeMutation('deactivateDocumentChecklistItem', ['requireChecklistEditAccess'], 'prisma.documentChecklistItem.update');
  assert.match(functionBody('assertChecklistContext'), /requireClientContextWriteAccess/);
  assert.match(functionBody('assertChecklistContext'), /requireDocumentEditAccess/);

  const legacyRegistration = functionBody('registerDocument');
  assert.match(legacyRegistration, /legacy disabilitata/);
  assert.doesNotMatch(legacyRegistration, /prisma\.document\.(?:create|update|upsert)/);
});

test('task e servizi invocano le guardie ABAC prima delle scritture', () => {
  assertGuardsBeforeMutation('createClientTask', ['assertTaskContext'], 'prisma.task.create');
  assertGuardsBeforeMutation('updateClientTask', ['requireTaskEditAccess'], 'prisma.task.update');
  assertGuardsBeforeMutation('completeClientTask', ['requireTaskEditAccess'], 'prisma.task.update');
  assert.match(functionBody('assertTaskContext'), /requireClientContextWriteAccess/);

  assertGuardsBeforeMutation('createClientService', ['requireClientContextWriteAccess'], 'prisma.clientService.create');
  assertGuardsBeforeMutation('updateClientServiceStatus', ['requireServiceEditAccess'], 'prisma.clientService.update');
  assertGuardsBeforeMutation('assignClientService', ['requireServiceAssignAccess'], 'prisma.clientService.update');
  assertGuardsBeforeMutation('updateClientServicePipeline', ['requireServiceEditAccess'], 'prisma.clientService.update');
});

test('gli stati finali dei servizi richiedono service.close prima della mutazione', () => {
  for (const [action, mutation] of [
    ['createClientService', 'prisma.clientService.create'],
    ['updateClientServiceStatus', 'prisma.clientService.update'],
    ['updateClientServicePipeline', 'prisma.clientService.update'],
  ] as const) {
    const body = functionBody(action);
    const permissionIndex = body.indexOf("hasPermission(s, 'service.close')");
    const mutationIndex = body.indexOf(mutation);
    assert.notEqual(permissionIndex, -1, `${action}: controllo service.close assente`);
    assert.ok(permissionIndex < mutationIndex, `${action}: service.close verificato dopo la mutazione`);
  }
});

test('pratiche tecniche invocano le guardie ABAC prima delle scritture', () => {
  assertGuardsBeforeMutation('createTechnicalPractice', ['requireClientContextWriteAccess'], 'prisma.technicalPractice.create');
  assertGuardsBeforeMutation(
    'updateTechnicalPractice',
    ['requireTechnicalPracticeEditAccess', 'requireClientContextWriteAccess'],
    'prisma.technicalPractice.update',
  );
  assertGuardsBeforeMutation('updateTechnicalPracticeStatus', ['requireTechnicalPracticeEditAccess'], 'prisma.technicalPractice.update');
  assertGuardsBeforeMutation('assignTechnicalPractice', ['requireTechnicalPracticeEditAccess'], 'prisma.technicalPractice.update');
  assertGuardsBeforeMutation('archiveTechnicalPractice', ['requireTechnicalPracticeEditAccess'], 'prisma.technicalPractice.update');
});

test('la route DOCX verifica l offerta prima di generare il documento', () => {
  const routePath = resolve(process.cwd(), 'src/app/commercial-offers/[id]/export/docx/route.ts');
  const routeText = readFileSync(routePath, 'utf8');
  const routeSource = ts.createSourceFile(routePath, routeText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const body = functionBody('GET', routeSource);
  const guardIndex = body.indexOf('canEditCommercialOffer');
  const exportIndex = body.indexOf('buildCommercialOfferDocx');
  assert.notEqual(guardIndex, -1);
  assert.notEqual(exportIndex, -1);
  assert.ok(guardIndex < exportIndex, 'GET: il controllo ABAC deve precedere la generazione DOCX');
});

test('esecuzione AI applica contesto, filtro documenti e allowlist prima del provider', () => {
  const body = functionBody('runClientAiAgent');
  const contextIndex = body.indexOf('requireClientContextReadAccess');
  const documentPolicyIndex = body.indexOf('canViewDocument');
  const inputIndex = body.indexOf('const input');
  const providerIndex = body.indexOf('agentRuntime.adapter.run');
  assert.ok(contextIndex >= 0 && contextIndex < providerIndex, 'guardia contesto AI assente o tardiva');
  assert.ok(documentPolicyIndex >= 0 && documentPolicyIndex < inputIndex, 'documenti non filtrati prima del payload AI');
  assert.ok(inputIndex >= 0 && inputIndex < providerIndex, 'payload AI costruito dopo il provider');
  assert.doesNotMatch(body.slice(inputIndex, providerIndex), /storagePath|checksum|fileName|clientDossiers|legacyDossiers/);
  assert.match(body, /isPrimaryOperationalAiAgent/);
  assert.match(body, /prisma\.\$transaction/);
});

test('quick-run mock e forzatamente locale e riservato alla configurazione AI', () => {
  const body = functionBody('runMockAgent');
  assert.match(body, /requirePermission\('ai_agents\.write'\)/);
  assert.match(body, /new MockAiAdapter\(\)\.run/);
  assert.doesNotMatch(body, /getAiAdapter\(\)/);
  assert.match(body, /prompt\.length > 2000/);
});

test('review e approval AI usano guardia oggetto, compliance e aggiornamento atomico', () => {
  assertGuardsBeforeMutation(
    'reviewAiOutput',
    ['requireAiOutputReadAccess', 'canReviewAiOutput', 'scanForbiddenPhrases'],
    'tx.aiOutput.updateMany',
  );
  assertGuardsBeforeMutation(
    'approveAiOutput',
    ['requireAiOutputReadAccess', 'canApproveAiOutput', 'scanForbiddenPhrases'],
    'tx.aiOutput.updateMany',
  );
  const approval = functionBody('approveAiOutput');
  assert.match(approval, /status: 'needs_review'/);
  assert.match(approval, /reviewedById: current\.reviewedById/);
  assert.match(approval, /reviewedAt: current\.reviewedAt/);
  assert.match(approval, /updatedAt: current\.updatedAt/);
  assert.match(approval, /approvedById: null/);
  assert.match(approval, /NOT: \{ reviewedById: s\.userId \}/);
});

test('conversione AI-dossier e idempotente a livello database e l export ricontrolla il contesto', () => {
  assertGuardsBeforeMutation('createClientDossierFromAiOutput', ['requireAiOutputReadAccess', 'scanForbiddenPhrases'], 'tx.clientDossier.create');
  assert.match(functionBody('createClientDossierFromAiOutput'), /sourceAiOutputId: output\.id/);
  assert.match(functionBody('auditClientDossierExport'), /requireClientContextReadAccess/);
  const schema = readFileSync(resolve(process.cwd(), 'prisma/schema.prisma'), 'utf8');
  assert.match(schema, /sourceAiOutputId\s+String\?\s+@unique/);
});

test('le pagine di dettaglio sensibili usano loader di lettura autorevoli', () => {
  const expectations = [
    ['src/app/companies/[id]/page.tsx', 'getCompanyReadAccess'],
    ['src/app/projects/[id]/page.tsx', 'getProjectReadAccess'],
    ['src/app/commercial-offers/[id]/page.tsx', 'getCommercialOfferReadAccess'],
    ['src/app/contracts/[id]/page.tsx', 'getContractReadAccess'],
    ['src/app/preanalyses/[id]/page.tsx', 'getPreAnalysisReadAccess'],
    ['src/app/dossiers/[id]/page.tsx', 'getLegacyDossierReadAccess'],
    ['src/app/client-dossiers/[id]/page.tsx', 'getClientDossierReadAccess'],
    ['src/app/ai/outputs/[id]/page.tsx', 'getAiOutputReadAccess'],
  ] as const;
  for (const [path, guard] of expectations) {
    const source = readFileSync(resolve(process.cwd(), path), 'utf8');
    assert.match(source, /requirePermission\(/, `${path}: permission guard assente`);
    assert.ok(source.includes(guard), `${path}: loader ${guard} assente`);
  }
});

test('il fascicolo cliente autorizza il parent prima di interrogare le sezioni figlie', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/app/clients/[id]/page.tsx'), 'utf8');
  const parentLoad = source.indexOf('const client = await prisma.client.findFirst');
  const parentGuard = source.indexOf('if (!client || !canViewClient');
  const childQueries = source.indexOf('const [companyContextRows, companies, projectRows');
  assert.ok(parentLoad >= 0 && parentLoad < parentGuard);
  assert.ok(parentGuard < childQueries, 'le query figlie devono avvenire dopo la guardia cliente');
  for (const permission of ['company.read', 'project.read', 'service.read', 'document.download', 'dossier.read', 'contract.read', 'payment.read', 'technical.read', 'practice_communications.read', 'ai.review', 'audit.read']) {
    assert.ok(source.includes(`hasPermission(session, '${permission}')`), `fascicolo: permission ${permission} assente`);
  }
  assert.match(source, /visibleDocuments\.flatMap/);
  for (const guardedCollection of [
    'projectRows.filter',
    'clientServiceRows.filter',
    'contractRows.filter',
    'paymentRows.filter',
    'preAnalysisRows.filter',
    'dossierRows.filter',
    'clientDossierRows.filter',
    'technicalPracticeRows.filter',
    'practiceCommunicationRows.filter',
  ]) {
    assert.ok(source.includes(guardedCollection), `fascicolo: filtro strutturale ${guardedCollection} assente`);
  }
  assert.match(source, /canViewClientContext\(session,/);
  assert.match(source, /communication\.technicalPracticeId/);
  assert.match(source, /communication\.projectId[\s\S]*practice\.projectId/);
  assert.match(source, /communication\.clientServiceId[\s\S]*practice\.clientServiceId/);
});

test('liste e code AI applicano permission e resolver ABAC centralizzato', () => {
  for (const path of ['src/app/ai/outputs/page.tsx', 'src/app/ai/outputs-to-review/page.tsx']) {
    const source = readFileSync(resolve(process.cwd(), path), 'utf8');
    assert.match(source, /requirePermission\('ai\.review'\)/);
    assert.match(source, /listAccessibleAiOutputs/);
  }
  const runs = readFileSync(resolve(process.cwd(), 'src/app/ai/runs/page.tsx'), 'utf8');
  assert.match(runs, /requirePermission\('ai\.review'\)/);
  assert.match(runs, /listAccessibleAiRuns/);
});

test('le viste ufficio tecnico filtrano le pratiche e autorizzano il parent prima dei figli', () => {
  for (const path of ['src/app/technical-office/page.tsx', 'src/app/technical-office/practices/page.tsx']) {
    const source = readFileSync(resolve(process.cwd(), path), 'utf8');
    assert.match(source, /canViewTechnicalPractice/);
    assert.match(source, /visiblePractices/);
  }

  const detail = readFileSync(resolve(process.cwd(), 'src/app/technical-office/practices/[id]/page.tsx'), 'utf8');
  const clientLoad = detail.indexOf('const client = await prisma.client.findFirst');
  const parentGuard = detail.indexOf('if (!client || !canViewTechnicalPractice');
  const childQueries = detail.indexOf('const [users, documentRows');
  assert.ok(clientLoad >= 0 && clientLoad < parentGuard);
  assert.ok(parentGuard < childQueries, 'la pratica deve essere autorizzata prima delle query figlie');
  assert.match(detail, /canViewDocument/);
  assert.match(detail, /canViewTask/);
  assert.match(detail, /canViewChecklistItem/);
});
