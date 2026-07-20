import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  AI_ORCHESTRATOR_ADMIN_CONTROL_TARGETS,
  AI_ORCHESTRATOR_ADMIN_GENESIS_GLOBAL_POLICY,
  createAiOrchestratorAdminGenesisPolicy,
} from '../src/lib/ai-orchestrator/admin-control-policy-v1';
import {
  AiOrchestratorAdminControlCommandSchema,
  AiOrchestratorAdminEmergencyStopCommandSchema,
  AiOrchestratorAdminSetGlobalPolicyCommandSchema,
  AiOrchestratorAdminSetScopePolicyCommandSchema,
} from '../src/lib/ai-orchestrator/admin-control-plane-v1';

const root = resolve(import.meta.dirname, '..');
const requestId = '018f47a0-7b2c-4d1e-8a90-1234567890ab';
const hash = 'a'.repeat(64);
const reason = 'Manutenzione programmata e verificata internamente.';

test('i comandi global e scope sono strict, confermati e CAS-fenced', () => {
  assert.equal(AiOrchestratorAdminSetGlobalPolicyCommandSchema.parse({
    actorUserId: 'synthetic-admin',
    requestId,
    operationCode: 'SET_GLOBAL_POLICY',
    expectedVersion: 1,
    expectedRevisionHash: hash,
    policy: AI_ORCHESTRATOR_ADMIN_GENESIS_GLOBAL_POLICY,
    reasonCode: 'MAINTENANCE',
    reason,
    confirmed: true,
  }).expectedVersion, 1);

  const scopeTarget = AI_ORCHESTRATOR_ADMIN_CONTROL_TARGETS.find(({ scopeType }) => scopeType === 'JOB');
  assert.ok(scopeTarget);
  assert.equal(AiOrchestratorAdminSetScopePolicyCommandSchema.parse({
    actorUserId: 'synthetic-admin',
    requestId,
    operationCode: 'SET_SCOPE_POLICY',
    expectedVersion: 1,
    expectedRevisionHash: hash,
    policy: createAiOrchestratorAdminGenesisPolicy(scopeTarget),
    reasonCode: 'DISABLEMENT_CHANGE',
    reason,
    confirmed: true,
  }).policy.scopeType, 'JOB');

  assert.throws(() => AiOrchestratorAdminControlCommandSchema.parse({
    actorUserId: 'synthetic-admin',
    requestId,
    operationCode: 'SET_GLOBAL_POLICY',
    expectedVersion: 1,
    expectedRevisionHash: hash,
    policy: AI_ORCHESTRATOR_ADMIN_GENESIS_GLOBAL_POLICY,
    reasonCode: 'MAINTENANCE',
    reason,
    confirmed: true,
    permissionGranted: true,
  }));
  assert.throws(() => AiOrchestratorAdminSetGlobalPolicyCommandSchema.parse({
    actorUserId: 'synthetic-admin',
    requestId,
    operationCode: 'SET_GLOBAL_POLICY',
    expectedVersion: 1,
    expectedRevisionHash: hash,
    policy: AI_ORCHESTRATOR_ADMIN_GENESIS_GLOBAL_POLICY,
    reasonCode: 'MAINTENANCE',
    reason,
    confirmed: false,
  }));
});

test('emergency stop non accetta CAS client e minimizza la motivazione', () => {
  assert.equal(AiOrchestratorAdminEmergencyStopCommandSchema.parse({
    actorUserId: 'synthetic-admin',
    requestId,
    operationCode: 'EMERGENCY_STOP',
    reasonCode: 'EMERGENCY_STOP',
    reason: 'Arresto immediato per anomalia operativa confermata.',
    confirmed: true,
  }).operationCode, 'EMERGENCY_STOP');

  assert.throws(() => AiOrchestratorAdminEmergencyStopCommandSchema.parse({
    actorUserId: 'synthetic-admin',
    requestId,
    operationCode: 'EMERGENCY_STOP',
    expectedVersion: 99,
    expectedRevisionHash: hash,
    reasonCode: 'EMERGENCY_STOP',
    reason: 'Arresto immediato per anomalia operativa confermata.',
    confirmed: true,
  }));
  for (const unsafeReason of [
    'Consultare https://example.test/segreto prima di procedere.',
    'Usare password amministrativa temporanea per questa operazione.',
    'Contattare nome@example.test per confermare questa operazione.',
  ]) {
    assert.throws(() => AiOrchestratorAdminEmergencyStopCommandSchema.parse({
      actorUserId: 'synthetic-admin',
      requestId,
      operationCode: 'EMERGENCY_STOP',
      reasonCode: 'SECURITY_RESPONSE',
      reason: unsafeReason,
      confirmed: true,
    }));
  }
});

test('il servizio rilegge RBAC nel DB, usa serializable/CAS e non è collegato a esecuzione', () => {
  const source = readFileSync(resolve(root, 'src/lib/ai-orchestrator/admin-control-plane-v1.ts'), 'utf8');
  assert.match(source, /FROM "User"[\s\S]*FOR SHARE/);
  assert.match(source, /FROM "UserPermissionOverride"[\s\S]*FOR SHARE/);
  assert.match(source, /withSerializableTransaction/);
  assert.match(source, /PG_ADVISORY_XACT_LOCK/);
  assert.match(source, /expectedRevisionHash[\s\S]*latest\.revisionHash/);
  assert.match(source, /ai_orchestrator_control_policy_changed/);
  assert.match(source, /ai_orchestrator_emergency_stop_activated/);
  assert.doesNotMatch(source, /from ['"].*worker-runtime['"]/);
  assert.doesNotMatch(source, /mock-handler-registry/);
  assert.doesNotMatch(source, /workflow-service/);
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /child_process|worker_threads|setInterval|setTimeout/);
});

test('lo stato effective v1 è sempre fail-closed e HUMAN_APPROVAL non è configurabile', () => {
  const source = readFileSync(resolve(root, 'src/lib/ai-orchestrator/admin-control-plane-v1.ts'), 'utf8');
  assert.match(source, /operational: false/);
  assert.match(source, /databaseEligible: false/);
  assert.match(source, /workerEnabled: false/);
  assert.match(source, /dispatchEnabled: false/);
  assert.match(source, /humanApprovalBypassAllowed: false/);
  assert.match(source, /FOUNDATION_LOCKED_V1/);
  assert.match(source, /HUMAN_APPROVAL_BARRIER/);
  assert.doesNotMatch(JSON.stringify(AI_ORCHESTRATOR_ADMIN_GENESIS_GLOBAL_POLICY), /humanApproval|bypass/i);
});
