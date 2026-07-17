import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import {
  AiControlPlaneError,
  assertExternalAiRunAllowed,
  getAllowedExternalModels,
  isExternalModelAllowed,
  isExternalProviderEnvironmentEnabled,
  normalizeExternalDataCategories,
} from '../src/lib/ai-control-plane';
import {
  createExternalAiPayload,
  externalAiDataCategories,
  extractOpenAiUsage,
  minimizeProviderRequestId,
  type ExternalAiPayload,
} from '../src/lib/ai';
import { hasPermission } from '../src/lib/auth';
import { aiAgentConfigUpdateSchema, clientAiRunSchema } from '../src/lib/validation';

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

function testEnv(values: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: 'test', ...values } as NodeJS.ProcessEnv;
}

test('gate ambiente e allowlist sono fail-closed ed exact-match', () => {
  assert.equal(isExternalProviderEnvironmentEnabled(testEnv()), false);
  assert.equal(isExternalProviderEnvironmentEnabled(testEnv({ AI_EXTERNAL_PROVIDERS_ENABLED: 'TRUE' })), false);
  assert.equal(isExternalProviderEnvironmentEnabled(testEnv({ AI_EXTERNAL_PROVIDERS_ENABLED: 'true' })), true);

  const env = testEnv({ AI_ALLOWED_MODELS: 'gpt-approved, gpt-second, gpt-approved, ' });
  assert.deepEqual(getAllowedExternalModels(env), ['gpt-approved', 'gpt-second']);
  assert.equal(isExternalModelAllowed('gpt-approved', env), true);
  assert.equal(isExternalModelAllowed('GPT-APPROVED', env), false);
  assert.equal(isExternalModelAllowed('gpt-approved-extra', env), false);
  assert.equal(isExternalModelAllowed('gpt-approved', testEnv()), false);
});

test('categorie esterne sono codici chiusi, deduplicati e non liberi', () => {
  assert.deepEqual(
    normalizeExternalDataCategories(['client_profile', 'financial_data', 'client_profile']),
    ['client_profile', 'financial_data'],
  );
  assert.throws(() => normalizeExternalDataCategories([]), /categorie minime/i);
  assert.throws(() => normalizeExternalDataCategories(['client_profile', 'raw_document_content']), /non ammessa/i);
});

test('policy esterna nega gate, modello, conferma e rate limit tramite il database', async () => {
  const now = new Date('2026-07-14T12:00:00.000Z');
  const env = testEnv({
    AI_EXTERNAL_PROVIDERS_ENABLED: 'true',
    AI_ALLOWED_MODELS: 'gpt-approved',
  });
  const db = (enabled: boolean, count: number, limit = 2) => ({
    aiControlSetting: {
      findUnique: async () => ({
        externalProvidersEnabled: enabled,
        maxExternalRunsPerUserPerHour: limit,
        updatedById: 'admin-1',
        updatedAt: now,
      }),
    },
    aiRun: { count: async () => count },
  });
  const call = (overrides: Record<string, unknown> = {}) => assertExternalAiRunAllowed({
    userId: 'user-1',
    permissionGranted: true,
    model: 'gpt-approved',
    dataCategories: ['client_profile'],
    confirmedAt: now,
    now,
    env,
    db: db(true, 0) as never,
    ...overrides,
  });
  const rejectsCode = async (promise: Promise<unknown>, code: AiControlPlaneError['code']) => {
    await assert.rejects(promise, (error) => error instanceof AiControlPlaneError && error.code === code);
  };

  await rejectsCode(call({ env: { ...env, AI_EXTERNAL_PROVIDERS_ENABLED: 'false' } }), 'external_providers_disabled');
  await rejectsCode(call({ db: db(false, 0) as never }), 'external_providers_disabled');
  await rejectsCode(call({ env: { ...env, AI_ALLOWED_MODELS: '' } }), 'model_allowlist_empty');
  await rejectsCode(call({ permissionGranted: false }), 'permission_required');
  await rejectsCode(call({ model: 'gpt-not-approved' }), 'model_not_allowed');
  await rejectsCode(call({ confirmedAt: null }), 'confirmation_required');
  await rejectsCode(call({ db: db(true, 2) as never }), 'rate_limit_exceeded');

  const allowed = await call({ db: db(true, 1) as never });
  assert.equal(allowed.externalRunsInCurrentWindow, 1);
  assert.deepEqual(allowed.dataCategories, ['client_profile']);
  assert.equal('permit' in allowed, false, 'il gate di policy non deve emettere una capability prima della reservation');
});

test('DTO egress conserva solo campi approvati, redige PII e guida le categorie', () => {
  const raw = {
    source: 'CRM interno FAI',
    humanReviewRequired: true,
    operationalInstructions: 'Scrivi a mario.rossi@example.it IBAN IT60X0542811101000000123456',
    context: {
      client: { type: 'societa', status: 'attivo', displayName: 'da escludere' },
      companies: [{ annualRevenue: '100000', legalForm: 'SRL', atecoCode: '62.01', region: 'Lazio', employees: 4, durcStatus: 'regolare', name: 'da escludere' }],
      service: { label: 'Servizio mario.rossi@example.it', practiceType: 'bando', status: 'pagato', operationalStatus: 'in_valutazione', requestedAmount: '50000', plannedInvestment: '80000', serviceCatalogId: 'segreto' },
      project: { requestedAmount: '50000', totalInvestment: '80000', status: 'idea', priority: 'alta', startTiming: 'Q4', region: 'Lazio', sector: 'software' },
      checklist: [{ title: 'Documento RSSMRA80A01H501U', status: 'ricevuto', hasLinkedDocument: true, documentId: 'segreto' }],
      documents: [{ documentCategory: 'Bilancio mario.rossi@example.it', status: 'ricevuto', serviceArea: 'bancabilita', storagePath: 'segreto' }],
      tasks: [{ status: 'aperta', priority: 'alta', title: 'segreto' }],
    },
  } as unknown as ExternalAiPayload;
  const dto = createExternalAiPayload(raw);
  const serialized = JSON.stringify(dto);

  assert.match(dto.operationalInstructions ?? '', /\[email rimossa\].*\[IBAN rimosso\]/);
  assert.equal(dto.context.checklist[0]?.hasLinkedDocument, true);
  assert.equal(dto.context.companies[0]?.legalForm, 'SRL');
  assert.equal(dto.context.project?.priority, 'alta');
  assert.doesNotMatch(serialized, /displayName|serviceCatalogId|documentId|storagePath|"title":"segreto"|"name":/);
  assert.deepEqual(externalAiDataCategories(dto), [
    'agent_configuration', 'client_profile', 'company_profile', 'financial_data', 'project_data',
    'service_context', 'document_metadata', 'checklist_status', 'task_metadata', 'operator_instructions',
  ]);
});

test('conferma FormData usa parsing booleano rigoroso e non accetta stringhe truthy arbitrarie', () => {
  const base = { requestKey: '9c36b1af-c0fc-4f81-a3bb-1798ba19dc4d', agentId: 'agent-1', clientId: 'client-1' };
  assert.equal(clientAiRunSchema.parse({ ...base, externalDataConfirmed: 'on' }).externalDataConfirmed, true);
  assert.equal(clientAiRunSchema.parse({ ...base, externalDataConfirmed: 'false' }).externalDataConfirmed, false);
  assert.equal(clientAiRunSchema.parse(base).externalDataConfirmed, false);
  assert.equal(clientAiRunSchema.safeParse({ ...base, externalDataConfirmed: 'yes' }).success, false);

  const configBase = { id: 'agent-1', systemPrompt: 'Prompt interno', active: 'false', expectedConfigVersion: '1' };
  assert.equal(aiAgentConfigUpdateSchema.parse({ ...configBase, provider: 'mock' }).active, false);
  assert.equal(aiAgentConfigUpdateSchema.safeParse({ ...configBase, provider: 'openai' }).success, false);
  assert.equal(aiAgentConfigUpdateSchema.safeParse({ ...configBase, provider: 'mock', futureModel: 'gpt-approved' }).success, false);
});

test('RBAC esterno è ristretto ad admin e direzione', () => {
  assert.equal(hasPermission({ role: 'admin', active: true, permissionOverrides: [] }, 'ai.external.run'), true);
  assert.equal(hasPermission({ role: 'direzione', active: true, permissionOverrides: [] }, 'ai.external.run'), true);
  for (const role of ['consulente', 'revisore', 'backoffice', 'commerciale', 'amministrazione', 'collaboratore_limitato'] as const) {
    assert.equal(hasPermission({ role, active: true, permissionOverrides: [] }, 'ai.external.run'), false, `${role} non deve eseguire provider esterni`);
  }
});

test('Responses API disabilita sempre lo storage e minimizza usage e request id', () => {
  const aiSource = readFileSync(resolve(root, 'src/lib/ai.ts'), 'utf8');
  assert.ok((aiSource.match(/store:\s*false/g) ?? []).length >= 3, 'tipo e body di run e diagnostica devono fissare store:false');

  assert.deepEqual(extractOpenAiUsage({ usage: { input_tokens: 12, output_tokens: 4 } }, ' req_abc-123 '), {
    inputTokens: 12,
    outputTokens: 4,
    totalTokens: 16,
    providerRequestId: 'req_abc-123',
  });
  assert.deepEqual(extractOpenAiUsage({ usage: { input_tokens: -1, output_tokens: '4', total_tokens: 99.5 } }, 'bad id with spaces'), {
    inputTokens: undefined,
    outputTokens: undefined,
    totalTokens: undefined,
    providerRequestId: undefined,
  });
  assert.equal(minimizeProviderRequestId('x'.repeat(256)), undefined);
});

test('run esterno richiede doppio permesso, conferma, gate e rate reservation atomica prima del provider', () => {
  const body = functionBody('runClientAiAgent');
  const guardPermission = body.indexOf("hasPermission(s, 'ai.external.run')");
  const guardConfirmation = body.indexOf('data.externalDataConfirmed');
  const controlPlane = body.indexOf('assertExternalAiRunAllowed');
  const createRun = body.indexOf('tx.aiRun.create');
  const providerCall = body.indexOf('agentRuntime.adapter.run');

  assert.match(body, /requirePermission\('ai\.run'\)/);
  assert.ok(guardPermission >= 0 && guardPermission < providerCall);
  assert.ok(guardConfirmation >= 0 && guardConfirmation < providerCall);
  assert.ok(controlPlane >= 0 && controlPlane < createRun && createRun < providerCall);
  assert.match(body.slice(controlPlane, createRun), /db: tx/);
  assert.match(body.slice(controlPlane, createRun), /permissionGranted: hasPermission\(s, 'ai\.external\.run'\)/);
  assert.match(body, /withSerializableAiTransaction/);
  assert.match(functionBody('withSerializableAiTransaction'), /isolationLevel: 'Serializable'/);
  assert.match(functionBody('withSerializableAiTransaction'), /attempt <= 3/);
  assert.match(functionBody('isSerializableConflict'), /P2034/);
  assert.match(body, /externalConfirmedAt:/);
  assert.match(body, /externalDataCategories:/);
  assert.match(body, /providerRequestId: providerMetadata\.providerRequestId/);
  assert.match(body, /inputTokens: providerMetadata\.inputTokens/);
  assert.match(body, /reservation\.externalPermit/);
  assert.doesNotMatch(functionBody('resolveAiAgentRuntime'), /getAiProviderDiagnostics/);
  assert.match(functionBody('resolveAiAgentRuntime'), /if \(!model\) throw new UserFacingActionError/);
});

test('mock resta disponibile con ai.run senza conferma e non marca il run come esterno', () => {
  const body = functionBody('runClientAiAgent');
  assert.match(body, /if \(currentRuntime\.provider === 'openai'\)/);
  assert.match(body, /externalConfirmedAt: currentRuntime\.provider === 'openai' \? externalConfirmedAt : null/);
  assert.match(body, /externalDataCategories: currentRuntime\.provider === 'openai'/);
  assert.match(functionBody('resolveAiAgentRuntime'), /provider === 'mock'[\s\S]*mock-template-v1/);
});

test('diagnostica OpenAI non aggira permessi, kill switch, allowlist o rate limit', () => {
  const body = functionBody('runAiProviderDiagnosticTest');
  const diagnosticPage = readFileSync(resolve(root, 'src/app/settings/ai-diagnostics/page.tsx'), 'utf8');
  const assertion = body.indexOf('assertExternalAiRunAllowed');
  const reservation = body.indexOf('tx.aiRun.create');
  const providerCall = body.indexOf('testAiProviderDiagnostic(reservation.permit)', assertion);

  assert.match(body, /hasPermission\(s, 'ai\.run'\)/);
  assert.match(body, /hasPermission\(s, 'ai\.external\.run'\)/);
  assert.match(body, /form\.get\('externalDiagnosticConfirmed'\) === 'on'/);
  assert.doesNotMatch(body, /form\.has\('externalDiagnosticConfirmed'\)/);
  assert.match(diagnosticPage, /name="externalDiagnosticConfirmed" required/);
  assert.ok(assertion >= 0 && assertion < reservation && reservation < providerCall);
  assert.match(body.slice(assertion, reservation), /dataCategories: \['agent_configuration'\]/);
  assert.match(body.slice(assertion, reservation), /db: tx/);
  assert.match(body, /status: result\.success \? 'completed' : 'failed'/);
  assert.doesNotMatch(body, /systemPrompt|operationalInstructions|clientId:/);
});

test('permit single-use chiude ogni fetch OpenAI importato fuori dalle action autorizzate', () => {
  const aiSource = readFileSync(resolve(root, 'src/lib/ai.ts'), 'utf8');
  const adapterStart = aiSource.indexOf('export class OpenAiAdapter');
  const adapterPermit = aiSource.indexOf('await consumeExternalAiPermit(permit, this.model, requestBody)', adapterStart);
  const adapterFetch = aiSource.indexOf("fetch('https://api.openai.com/v1/responses'", adapterStart);
  const diagnosticStart = aiSource.indexOf('export async function testAiProviderDiagnostic');
  const diagnosticPermit = aiSource.indexOf('await consumeExternalAiPermit(permit, diagnostics.model, requestBody)', diagnosticStart);
  const diagnosticFetch = aiSource.indexOf("fetch('https://api.openai.com/v1/responses'", diagnosticStart);

  assert.ok(adapterStart >= 0 && adapterPermit > adapterStart && adapterPermit < adapterFetch);
  assert.ok(diagnosticStart >= 0 && diagnosticPermit > diagnosticStart && diagnosticPermit < diagnosticFetch);
});

test('OpenAI non persiste payload o istruzioni e recupera gli errori post-provider con telemetria', () => {
  const body = functionBody('runClientAiAgent');
  const createRun = body.slice(body.indexOf('const run = await tx.aiRun.create'), body.indexOf('await tx.auditLog.create', body.indexOf('const run = await tx.aiRun.create')));
  const externalDto = body.slice(body.indexOf('const externalPayload'), body.indexOf('const externalDataCategories'));
  const failureHelper = functionBody('markAiRunFailedBestEffort');

  assert.match(createRun, /input: currentRuntime\.provider === 'openai' \? Prisma\.DbNull/);
  assert.match(createRun, /operationalInstructions: currentRuntime\.provider === 'openai' \? null/);
  assert.match(body, /externalAiDataCategories\(externalPayload\)/);
  assert.doesNotMatch(externalDto, /serviceCatalogId/);
  for (const field of ['legalForm', 'atecoCode', 'employees', 'durcStatus', 'priority', 'startTiming', 'sector', 'hasLinkedDocument']) {
    assert.ok(externalDto.includes(field), `campo DTO ${field} assente`);
  }
  assert.match(body, /aiEligibleDocuments = visibleDocuments\.filter\(\(document\) => !isSensitiveDocument\(document\)\)/);
  assert.match(body, /isSensitiveDocument\([\s\S]*item\.title[\s\S]*\)\) return false/);
  assert.match(body, /markAiRunFailedBestEffort/);
  assert.match(body, /AI_OUTPUT_PERSISTENCE_FAILURE/);
  assert.match(failureHelper, /failAiRunWithLease\(tx, options\.lease/);
  assert.match(failureHelper, /failureCode: options\.errorCode/);
  assert.match(failureHelper, /telemetry,/);
});

test('config agente usa CAS, versioni append-only e audit minimizzato nella stessa transazione', () => {
  const body = functionBody('updateAiAgentConfig');
  const update = body.indexOf('tx.aiAgent.updateMany');
  const snapshot = body.indexOf('tx.aiAgentConfigVersion.create');
  const audit = body.indexOf('tx.auditLog.createMany');
  const summary = body.slice(body.indexOf('const summary'), audit);

  assert.match(body, /isExternalModelAllowed\(data\.futureModel\)/);
  assert.match(body, /before\.configVersion !== data\.expectedConfigVersion/);
  assert.match(body, /configVersion: data\.expectedConfigVersion/);
  assert.match(body, /configVersion: nextConfigVersion/);
  assert.match(body, /promptVersion = `v\$\{nextConfigVersion\}`/);
  assert.ok(update >= 0 && update < snapshot && snapshot < audit);
  assert.match(body, /systemPrompt: next\.systemPrompt/);
  assert.match(summary, /previousPromptLength/);
  assert.doesNotMatch(summary, /systemPrompt\s*:/);
});

test('switch globale usa CAS e audit atomico senza segreti', () => {
  const body = functionBody('updateAiControlSetting');
  const update = body.indexOf('tx.aiControlSetting.updateMany');
  const audit = body.indexOf('tx.auditLog.create');

  assert.match(body, /requirePermission\('settings\.manage'\)/);
  assert.match(body, /before\.updatedAt\.getTime\(\) !== data\.expectedUpdatedAt\.getTime\(\)/);
  assert.match(body, /id: AI_CONTROL_SETTING_ID, updatedAt: before\.updatedAt/);
  assert.ok(update >= 0 && update < audit);
  assert.match(body, /event: 'ai_control_setting_update'/);
  assert.doesNotMatch(body, /AI_API_KEY|systemPrompt/);
});

test('migrazione crea singleton fail-closed, storico immutabile e vincoli telemetria', () => {
  const migration = readFileSync(resolve(root, 'prisma/migrations/20260714140000_ai_control_plane_v1/migration.sql'), 'utf8');
  assert.match(migration, /^--[\s\S]*?\nBEGIN;/);
  assert.match(migration, /WHERE "futureModel" = 'openai-server-side';/);
  assert.doesNotMatch(migration, /LOWER\(BTRIM\("provider"\)\)/);
  assert.match(migration, /INSERT INTO "AiControlSetting"[\s\S]*VALUES \('global', false, 10/);
  assert.match(migration, /AiControlSetting_singleton_check/);
  assert.match(migration, /AiAgentConfigVersion_immutable_update/);
  assert.match(migration, /AiAgentConfigVersion_immutable_delete/);
  assert.match(migration, /ON DELETE RESTRICT ON UPDATE RESTRICT/);
  assert.match(migration, /CHECK \("inputTokens" IS NULL OR "inputTokens" >= 0\)/);
  assert.match(migration, /WHERE "externalConfirmedAt" IS NOT NULL/);
  assert.match(migration, /COMMIT;\s*$/);
});

test('seed AI preserva le configurazioni esistenti e registra provenienza e audit nella transazione', () => {
  const seed = readFileSync(resolve(root, 'prisma/seed-ai-agent.ts'), 'utf8');
  const transactionStart = seed.indexOf('return prisma.$transaction');
  const audit = seed.indexOf('await tx.auditLog.create');
  const transactionEnd = seed.lastIndexOf('isolationLevel: Prisma.TransactionIsolationLevel.Serializable');

  assert.ok(transactionStart >= 0 && transactionStart < audit && audit < transactionEnd);
  assert.match(seed, /source = createdById \? 'development_seed' : 'production_seed'/);
  assert.match(seed, /Existing agent configuration is never overwritten/);
  assert.match(seed, /if \(configurationChanged\) \{[\s\S]*event: 'ai_agent_config_seed'/);
});
