import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { resolve } from 'node:path';
import { roleHasPermission } from '../src/lib/permissions';

const root = resolve(import.meta.dirname, '..');
const migrationPath = resolve(
  root,
  'prisma/migrations/20260730100000_global_ai_admin_authorization_notification_gate_foundation_v1/migration.sql',
);
const migration = readFileSync(migrationPath, 'utf8');
const schema = readFileSync(resolve(root, 'prisma/schema.prisma'), 'utf8');
const actions = readFileSync(resolve(root, 'src/lib/actions.ts'), 'utf8');
const aiSource = readFileSync(resolve(root, 'src/lib/ai.ts'), 'utf8');
const service = readFileSync(resolve(root, 'src/lib/ai-execution-authorization.ts'), 'utf8');
const authorizationPage = readFileSync(resolve(root, 'src/app/settings/ai-authorizations/page.tsx'), 'utf8');
const authorizationDetailPage = readFileSync(resolve(root, 'src/app/settings/ai-authorizations/[id]/page.tsx'), 'utf8');
const notifications = readFileSync(resolve(root, 'src/lib/internal-notifications.ts'), 'utf8');
const orchestratorContract = readFileSync(resolve(root, 'src/lib/ai-orchestrator/manual-authorization-contract-v1.ts'), 'utf8');
const websiteLeadRoute = readFileSync(resolve(root, 'src/app/api/integrations/website/leads/route.ts'), 'utf8');

const nonAdminRoles = [
  'direzione',
  'commerciale',
  'consulente',
  'revisore',
  'backoffice',
  'amministrazione',
  'collaboratore_limitato',
] as const;

test('PR85 conserva la trentesima migration e i quattro record persistenti del gate', () => {
  assert.equal(readdirSync(resolve(root, 'prisma/migrations')).length, 43);
  for (const model of [
    'AiExecutionRequest',
    'AiExecutionDecision',
    'AiExecutionAuthorizationGrant',
    'AiExecutionAdminNotification',
  ]) {
    assert.match(schema, new RegExp(`model ${model} \\{`));
    assert.match(migration, new RegExp(`CREATE TABLE "${model}"`));
  }
  assert.match(schema, /PENDING_ADMIN_APPROVAL/);
  assert.match(schema, /authorizationGrantId\s+String\?\s+@unique/);
});

test('richiesta, decisione iniziale, audit e notifiche Admin condividono la transazione DB', () => {
  assert.match(migration, /^BEGIN;/m);
  assert.match(migration, /CREATE FUNCTION "ai_execution_request_after_insert_v1"/);
  assert.match(migration, /INSERT INTO "AiExecutionDecision"/);
  assert.match(migration, /INSERT INTO "AuditLog"/);
  assert.match(migration, /INSERT INTO "AiExecutionAdminNotification"/);
  assert.match(migration, /AI execution request denied because no active Admin exists/);
  assert.match(migration, /"expiresAt" <= "createdAt" \+ INTERVAL '30 minutes'/);
  assert.match(migration, /FROM "User"[\s\S]*FOR SHARE/);
  assert.match(migration, /^COMMIT;/m);
});

test('decision ledger e grant sono immutabili, hash-chain e monouso', () => {
  assert.match(migration, /AiExecDecision_immutable_v1/);
  assert.match(migration, /AiExecGrant_immutable_v1/);
  assert.match(migration, /AiExecRequest_deny_truncate_v1/);
  assert.match(migration, /AiExecDecision_deny_truncate_v1/);
  assert.match(migration, /AiExecGrant_deny_truncate_v1/);
  assert.match(migration, /AiExecNotification_deny_delete_v1/);
  assert.match(migration, /AiExecNotification_deny_truncate_v1/);
  assert.match(migration, /notification read state is monotonic/);
  assert.match(migration, /notification decision requires the latest ledger event/);
  assert.match(migration, /previousDecisionHash/);
  assert.match(migration, /AiExecDecision_request_genesis_key/);
  assert.match(migration, /AiExecDecision_approval_once_key/);
  assert.match(migration, /AiExecDecision_consumption_once_key/);
  assert.match(migration, /AiRun_authorizationGrantId_key/);
  assert.match(migration, /"executionInputHash" TEXT NOT NULL/);
  assert.match(migration, /"maxAttempts" = 1/);
  assert.match(migration, /CREATE FUNCTION "ai_execution_decision_after_insert_v1"/);
  assert.match(migration, /NEW\."decisionType" = 'APPROVED'[\s\S]*INSERT INTO "AiExecutionAuthorizationGrant"/);
  assert.match(migration, /Invalid AI execution decision transition/);
  assert.match(migration, /request status and latest decision are inconsistent/);
});

test('PostgreSQL rifiuta decisioni amministrative con attore non Admin', () => {
  assert.match(
    migration,
    /NEW\."decisionType" IN \('NEEDS_INFORMATION', 'APPROVED', 'REJECTED', 'REVOKED'\)[\s\S]*actor_role IS DISTINCT FROM 'admin'/,
  );
  assert.match(migration, /AI execution Admin decision requires an active Admin actor/);
  assert.match(migration, /AI execution grant approver must be an active Admin/);
});

test('collaboratori possono solo richiedere e non ereditano esecuzione o decisione Admin', () => {
  for (const role of nonAdminRoles) {
    assert.equal(roleHasPermission(role, 'ai.execution.request'), true, role);
    assert.equal(roleHasPermission(role, 'ai.run'), false, role);
    assert.equal(roleHasPermission(role, 'ai.external.run'), false, role);
    assert.equal(roleHasPermission(role, 'ai.execution.approve'), false, role);
    assert.equal(roleHasPermission(role, 'ai.execution.reject'), false, role);
    assert.equal(roleHasPermission(role, 'ai.execution.revoke'), false, role);
    assert.equal(roleHasPermission(role, 'ai.execution.audit'), false, role);
    assert.equal(roleHasPermission(role, 'ai.execution.consume'), false, role);
  }
  assert.equal(roleHasPermission('admin', 'ai.execution.consume'), false);
  assert.equal(roleHasPermission('direzione', 'ai.approve'), false);
  assert.equal(roleHasPermission('revisore', 'ai.approve'), false);
});

test('tutti gli ingressi esistenti sono request-only e non costruiscono adapter', () => {
  for (const functionName of ['runAiProviderDiagnosticTest', 'runClientAiAgent', 'runMockAgent']) {
    const start = actions.indexOf(`export async function ${functionName}`);
    const next = actions.indexOf('\nexport async function ', start + 1);
    const body = actions.slice(start, next < 0 ? actions.length : next);
    assert.ok(start >= 0, functionName);
    assert.match(body, /requirePermission\('ai\.execution\.request'\)/);
    assert.match(body, /createAiExecutionRequest/);
    assert.doesNotMatch(body, /aiRun\.create|adapter\.run|testAiProviderDiagnostic|new (?:MockAiAdapter|OpenAiAdapter)/);
  }
  assert.doesNotMatch(actions, /new (?:MockAiAdapter|OpenAiAdapter)/);
});

test('barriera AiRun verifica binding e consuma il grant nello stesso inserimento', () => {
  assert.match(migration, /CREATE FUNCTION "ai_execution_run_before_insert_v1"/);
  assert.match(migration, /Every new AiRun requires a manual Admin authorization grant/);
  for (const field of [
    'requestFingerprint',
    'executionInputHash',
    'agentId',
    'agentConfigVersion',
    'promptVersion',
    'provider',
    'model',
    'clientId',
    'clientServiceId',
    'projectId',
    'createdById',
  ]) assert.ok(migration.includes(`NEW."${field}"`), field);
  assert.match(migration, /NEW\."reliabilityVersion" IS DISTINCT FROM 1/);
  assert.match(migration, /NEW\."status" <> 'running'/);
  assert.match(migration, /NEW\."requestKey" IS DISTINCT FROM request_row\."idempotencyKey"/);
  assert.match(migration, /canonicalize_ai_workflow_jsonb"\(COALESCE\(NEW\."input", 'null'::JSONB\)\)/);
  assert.match(migration, /'CONSUMED'/);
  assert.match(migration, /Consumed AI execution request requires exactly one bound AiRun/);
  assert.match(migration, /Authorized AiRun is append-only and cannot be deleted/);
  assert.match(service, /export async function reserveAuthorizedAiRun/);
  assert.match(service, /inputFingerprint: string/);
  assert.match(service, /input\.inputFingerprint !== request\.inputFingerprint/);
  assert.match(service, /input\.inputFingerprint !== request\.authorizationGrant\.inputFingerprint/);
  assert.match(service, /request\.hashCanonicalizationVersion === 2[\s\S]*aiExecutionCanonicalSha256V2\(input\.input \?\? null\)[\s\S]*canonicalSha256\(input\.input \?\? null\)/);
  assert.match(service, /executionInputHash !== request\.executionInputHash/);
  assert.match(service, /executionInputHash !== request\.authorizationGrant\.executionInputHash/);
  assert.match(service, /export function consumeAiExecutionRuntimePermit/);
  assert.match(service, /claims\.hashCanonicalizationVersion === 2[\s\S]*aiExecutionCanonicalSha256V2\(expected\.input \?\? null\)[\s\S]*canonicalSha256\(expected\.input \?\? null\)/);
  assert.match(service, /export async function expireAiExecutionRequestsOnRead/);
  assert.match(service, /decisionType: 'EXPIRED'/);
  assert.match(service, /tx\.aiRun\.create/);
  assert.doesNotMatch(service, /fetch\(|new (?:OpenAiAdapter|MockAiAdapter)|\.adapter\.run/);
  assert.match(aiSource, /class MockAiAdapter[\s\S]*consumeAiExecutionRuntimePermit/);
  assert.match(aiSource, /class OpenAiAdapter[\s\S]*consumeAiExecutionRuntimePermit/);
  assert.match(aiSource, /testAiProviderDiagnostic\([\s\S]*runtimePermit: AiExecutionRuntimePermit/);
});

test('UI privata, notifiche e Orchestrator espongono il contratto senza consumo', () => {
  assert.match(authorizationPage, /Autorizzazioni AI/);
  assert.match(authorizationDetailPage, /approveAiExecutionRequestAndRefresh/);
  assert.match(authorizationDetailPage, /Approvare crea soltanto un grant monouso/);
  assert.doesNotMatch(authorizationDetailPage, /reserveAuthorizedAiRun|ai\.execution\.consume/);
  assert.match(notifications, /aiExecutionAdminNotification\.findMany/);
  assert.match(notifications, /Autorizzazione AI da decidere/);
  assert.match(orchestratorContract, /requiresAuthorizationAt:[\s\S]*'ADMISSION'[\s\S]*'CLAIM'[\s\S]*'EXECUTION'/);
  assert.match(orchestratorContract, /'executionInputHash'/);
  assert.match(orchestratorContract, /productionConsumer: 'NONE'/);
  assert.match(orchestratorContract, /canAcceptLease: false/);
  assert.doesNotMatch(websiteLeadRoute, /AiRun|AiExecutionRequest|adapter|provider|agent/i);
});

test('la foundation non apre Orchestrator, capability o provider esterni', () => {
  assert.match(migration, /stateMachineEnabled" = false/);
  assert.match(migration, /dispatchEnabled" = false/);
  assert.match(migration, /syntheticDataOnly" = true/);
  assert.match(migration, /provider" = 'mock'/);
  assert.match(migration, /externalProvidersEnabled" = false/);
  assert.doesNotMatch(migration, /UPDATE "AiOrchestratorSetting"/);
  assert.doesNotMatch(migration, /UPDATE "AiOrchestratorWorkerCapabilitySetting"/);
  assert.doesNotMatch(migration, /INSERT INTO "AiWorkflowJob"/);
  assert.doesNotMatch(migration, /INSERT INTO "AiRun"/);
});
