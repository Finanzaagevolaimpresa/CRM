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

const nonAdminRoles = [
  'direzione',
  'commerciale',
  'consulente',
  'revisore',
  'backoffice',
  'amministrazione',
  'collaboratore_limitato',
] as const;

test('PR85 aggiunge la trentesima migration e i quattro record persistenti del gate', () => {
  assert.equal(readdirSync(resolve(root, 'prisma/migrations')).length, 30);
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
  assert.match(migration, /FOR KEY SHARE/);
  assert.match(migration, /^COMMIT;/m);
});

test('decision ledger e grant sono immutabili, hash-chain e monouso', () => {
  assert.match(migration, /AiExecDecision_immutable_v1/);
  assert.match(migration, /AiExecGrant_immutable_v1/);
  assert.match(migration, /previousDecisionHash/);
  assert.match(migration, /AiExecDecision_request_genesis_key/);
  assert.match(migration, /AiExecDecision_approval_once_key/);
  assert.match(migration, /AiExecDecision_consumption_once_key/);
  assert.match(migration, /AiRun_authorizationGrantId_key/);
  assert.match(migration, /"maxAttempts" = 1/);
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
