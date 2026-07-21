import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  AI_ORCHESTRATOR_WORKER_CAPABILITIES,
  AI_ORCHESTRATOR_WORKER_CAPABILITY_HASHES,
} from '../src/lib/ai-orchestrator/worker-runtime-policy-v1';
import {
  FAI_AUDIT_JOB_CODES,
  FAI_AUDIT_JOB_DEFINITION_HASHES,
  FAI_AUDIT_JOB_EXECUTOR_BINDINGS,
} from '../src/lib/ai-orchestrator/job-catalog-v1';
import {
  FAI_AUDIT_WORKFLOW_DEFINITION_HASH,
  FAI_AUDIT_WORKFLOW_ID,
} from '../src/lib/ai-orchestrator/audit-workflow-v1-1';
import {
  AI_ORCHESTRATOR_ADMIN_CONTROL_TARGET_COUNT,
  AI_ORCHESTRATOR_ADMIN_CONTROL_TARGETS,
  AI_ORCHESTRATOR_ADMIN_EMERGENCY_STOP_INTENT_HASH,
  AI_ORCHESTRATOR_ADMIN_FOUNDATION_REASON,
  AI_ORCHESTRATOR_ADMIN_FOUNDATION_REASON_CODE,
  AI_ORCHESTRATOR_ADMIN_GENESIS_GLOBAL_POLICY,
  AI_ORCHESTRATOR_ADMIN_PERMISSIONS,
  AiOrchestratorAdminGlobalPolicySchema,
  AiOrchestratorAdminLimitsSchema,
  AiOrchestratorAdminOperatingWindowSchema,
  AiOrchestratorAdminScopePolicySchema,
  buildAiOrchestratorAdminRequestIdentity,
  buildAiOrchestratorAdminRevisionIdentity,
  createAiOrchestratorAdminGenesisPolicy,
  createAiOrchestratorAdminPolicyHash,
  createAiOrchestratorAdminRequestHash,
  createAiOrchestratorAdminRevisionHash,
  diffAiOrchestratorAdminPolicies,
  engageAiOrchestratorEmergencyStop,
  getAiOrchestratorAdminControlTarget,
  validateAiOrchestratorAdminPolicyForTarget,
} from '../src/lib/ai-orchestrator/admin-control-policy-v1';
import {
  permissionCatalog,
  roleHasPermission,
  rolePermissions,
} from '../src/lib/permissions';

const SHA_A = 'a'.repeat(64);
const REQUEST_ID = '018f47a2-4d12-4abc-8def-0123456789ab';

const GOLDEN_HASHES = Object.freeze({
  emergencyIntent: '8e0e55ec3ff66518ca14a65cc0c5624ecee09d13fa41a6fcfd30027d74b5b4bd',
  genesisGlobalPolicy: 'dc67612700b5740dbf4b3332639a7e5542b1a5d828d0b54aa4cfc1ed1f53f34a',
  genesisGlobalRequest: '2c5152b276febf3be2fc4697cf06cf4dbcce1732509ccdd2bfe5042ea00cc530',
  genesisGlobalRevision: 'e5d6ce436db5e8bf457717227a36314f99d5adf461962359d400ed282c416f00',
  emergencyRequest: 'c3e8a5f72f13ac92107b47fb211419c2db035f24bcde281c8ac656f6722807dc',
});

function globalTarget() {
  const target = getAiOrchestratorAdminControlTarget('GLOBAL', 'global');
  assert.ok(target);
  return target;
}

function genesisRequest() {
  const target = globalTarget();
  const policyHash = createAiOrchestratorAdminPolicyHash(AI_ORCHESTRATOR_ADMIN_GENESIS_GLOBAL_POLICY);
  return buildAiOrchestratorAdminRequestIdentity({
    actorUserId: null,
    requestId: null,
    scopeType: target.scopeType,
    scopeCode: target.scopeCode,
    expectedVersion: null,
    expectedRevisionHash: null,
    operationCode: 'GENESIS',
    requestedPolicyHash: policyHash,
    reasonCode: AI_ORCHESTRATOR_ADMIN_FOUNDATION_REASON_CODE,
    reason: AI_ORCHESTRATOR_ADMIN_FOUNDATION_REASON,
    confirmed: false,
  });
}

test('RBAC espone nove permessi dedicati, admin-only per default', () => {
  const catalogEntries = permissionCatalog.filter(({ code }) => code.startsWith('ai.orchestrator.'));
  assert.deepEqual(catalogEntries.map(({ code }) => code), [...AI_ORCHESTRATOR_ADMIN_PERMISSIONS]);
  assert.ok(catalogEntries.every(({ group }) => group === 'AI Orchestrator'));
  assert.deepEqual(rolePermissions.admin, ['*']);

  for (const permission of AI_ORCHESTRATOR_ADMIN_PERMISSIONS) {
    assert.equal(roleHasPermission('admin', permission), true);
    for (const [role, granted] of Object.entries(rolePermissions)) {
      if (role === 'admin') continue;
      assert.equal(granted.includes(permission), false, `${role} non deve ereditare ${permission}`);
    }
  }
});

test('catalogo target canonico copre 1+1+7+13+13+1 senza duplicati', () => {
  assert.equal(AI_ORCHESTRATOR_ADMIN_CONTROL_TARGETS.length, AI_ORCHESTRATOR_ADMIN_CONTROL_TARGET_COUNT);
  assert.equal(new Set(AI_ORCHESTRATOR_ADMIN_CONTROL_TARGETS.map(({ scopeType, scopeCode }) => `${scopeType}:${scopeCode}`)).size, 36);
  assert.deepEqual(
    Object.fromEntries(['GLOBAL', 'PROVIDER', 'AGENT', 'CAPABILITY', 'JOB', 'WORKFLOW'].map((scopeType) => [
      scopeType,
      AI_ORCHESTRATOR_ADMIN_CONTROL_TARGETS.filter((target) => target.scopeType === scopeType).length,
    ])),
    { GLOBAL: 1, PROVIDER: 1, AGENT: 7, CAPABILITY: 13, JOB: 13, WORKFLOW: 1 },
  );

  const executorHashes = new Map(FAI_AUDIT_JOB_EXECUTOR_BINDINGS.map((binding) => [
    binding.executorAgentCode,
    binding.executorAgentConfigHash,
  ]));
  assert.equal(executorHashes.size, 7);
  for (const [code, hash] of executorHashes) {
    assert.equal(getAiOrchestratorAdminControlTarget('AGENT', code)?.targetDefinitionHash, hash);
  }
  for (const jobCode of FAI_AUDIT_JOB_CODES) {
    assert.equal(getAiOrchestratorAdminControlTarget('JOB', jobCode)?.targetDefinitionHash, FAI_AUDIT_JOB_DEFINITION_HASHES[jobCode]);
  }
  for (const capability of AI_ORCHESTRATOR_WORKER_CAPABILITIES) {
    assert.equal(
      getAiOrchestratorAdminControlTarget('CAPABILITY', capability.capabilityCode)?.targetDefinitionHash,
      AI_ORCHESTRATOR_WORKER_CAPABILITY_HASHES[capability.jobCode],
    );
  }
  assert.equal(getAiOrchestratorAdminControlTarget('WORKFLOW', FAI_AUDIT_WORKFLOW_ID)?.targetDefinitionHash, FAI_AUDIT_WORKFLOW_DEFINITION_HASH);
});

test('genesis è interamente fail-closed e legata a ogni target canonico', () => {
  assert.deepEqual(AI_ORCHESTRATOR_ADMIN_GENESIS_GLOBAL_POLICY, {
    schemaVersion: 1,
    policyCode: 'AI_ORCHESTRATOR_ADMIN_GLOBAL_POLICY',
    policyVersion: '1.0',
    activationEpoch: 'FOUNDATION_LOCKED_V1',
    foundationLocked: true,
    desiredMode: 'STOPPED',
    desiredStateMachineEnabled: false,
    desiredDispatchEnabled: false,
    emergencyStopEngaged: true,
    globalKillSwitch: true,
    provider: 'mock',
    syntheticDataOnly: true,
    limits: {
      maxConcurrentGlobal: 0,
      maxConcurrentPerWorkflow: 0,
      maxConcurrentPerAgent: 0,
      maxRetryableFailures: 0,
      leaseDurationMs: 120_000,
      heartbeatIntervalMs: 30_000,
      maxAttemptDurationMs: 600_000,
      dailyJobLimit: 0,
    },
    operatingWindow: { enabled: false, timezone: 'UTC', startMinuteUtc: null, endMinuteUtc: null },
  });
  assert.ok(Object.isFrozen(AI_ORCHESTRATOR_ADMIN_GENESIS_GLOBAL_POLICY));
  assert.ok(Object.isFrozen(AI_ORCHESTRATOR_ADMIN_GENESIS_GLOBAL_POLICY.limits));

  for (const target of AI_ORCHESTRATOR_ADMIN_CONTROL_TARGETS) {
    const policy = createAiOrchestratorAdminGenesisPolicy(target);
    assert.deepEqual(validateAiOrchestratorAdminPolicyForTarget(target, policy), policy);
    if (target.scopeType === 'GLOBAL') continue;
    assert.equal(policy.policyCode, 'AI_ORCHESTRATOR_ADMIN_SCOPE_POLICY');
    assert.equal(policy.desiredEnabled, false);
    assert.equal(policy.killSwitch, true);
  }
});

test('schema strict e limiti conservativi rifiutano bypass e configurazioni incoerenti', () => {
  const global = structuredClone(AI_ORCHESTRATOR_ADMIN_GENESIS_GLOBAL_POLICY);
  assert.throws(() => AiOrchestratorAdminGlobalPolicySchema.parse({ ...global, desiredDispatchEnabled: true }));
  assert.throws(() => AiOrchestratorAdminGlobalPolicySchema.parse({ ...global, provider: 'openai' }));
  assert.throws(() => AiOrchestratorAdminGlobalPolicySchema.parse({ ...global, syntheticDataOnly: false }));
  assert.throws(() => AiOrchestratorAdminGlobalPolicySchema.parse({ ...global, foundationLocked: false }));
  assert.throws(() => AiOrchestratorAdminGlobalPolicySchema.parse({ ...global, humanApprovalBypass: true }));
  assert.throws(() => AiOrchestratorAdminGlobalPolicySchema.parse({ ...global, desiredStateMachineEnabled: true }));

  const limits = global.limits;
  assert.throws(() => AiOrchestratorAdminLimitsSchema.parse({ ...limits, maxConcurrentGlobal: 2 }));
  assert.throws(() => AiOrchestratorAdminLimitsSchema.parse({ ...limits, maxRetryableFailures: 4 }));
  assert.throws(() => AiOrchestratorAdminLimitsSchema.parse({ ...limits, dailyJobLimit: 1_001 }));
  assert.throws(() => AiOrchestratorAdminLimitsSchema.parse({ ...limits, leaseDurationMs: 30_000, heartbeatIntervalMs: 20_000 }));
  assert.throws(() => AiOrchestratorAdminLimitsSchema.parse({ ...limits, maxAttemptDurationMs: 60_000 }));
  assert.throws(() => AiOrchestratorAdminOperatingWindowSchema.parse({ enabled: false, timezone: 'UTC', startMinuteUtc: 0, endMinuteUtc: null }));
  assert.throws(() => AiOrchestratorAdminOperatingWindowSchema.parse({ enabled: true, timezone: 'UTC', startMinuteUtc: null, endMinuteUtc: 60 }));
  assert.throws(() => AiOrchestratorAdminOperatingWindowSchema.parse({ enabled: true, timezone: 'UTC', startMinuteUtc: 60, endMinuteUtc: 60 }));

  const jobTarget = AI_ORCHESTRATOR_ADMIN_CONTROL_TARGETS.find(({ scopeType }) => scopeType === 'JOB');
  const otherJobTarget = AI_ORCHESTRATOR_ADMIN_CONTROL_TARGETS.find(({ scopeType, scopeCode }) => scopeType === 'JOB' && scopeCode !== jobTarget?.scopeCode);
  assert.ok(jobTarget && otherJobTarget);
  const policy = createAiOrchestratorAdminGenesisPolicy(jobTarget);
  assert.throws(() => validateAiOrchestratorAdminPolicyForTarget(otherJobTarget, policy));
  assert.throws(() => AiOrchestratorAdminScopePolicySchema.parse({ ...policy, arbitrary: true }));
});

test('request identity impone CAS, UUID v4, scope e intent di emergenza', () => {
  const target = globalTarget();
  const emergency = buildAiOrchestratorAdminRequestIdentity({
    actorUserId: 'admin-1',
    requestId: REQUEST_ID,
    scopeType: 'GLOBAL',
    scopeCode: 'global',
    expectedVersion: null,
    expectedRevisionHash: null,
    operationCode: 'EMERGENCY_STOP',
    requestedPolicyHash: AI_ORCHESTRATOR_ADMIN_EMERGENCY_STOP_INTENT_HASH,
    reasonCode: 'OPERATOR_EMERGENCY_STOP',
    reason: 'Arresto immediato confermato dall’amministratore.',
    confirmed: true,
  });
  assert.equal(emergency.scopeCode, target.scopeCode);

  assert.throws(() => buildAiOrchestratorAdminRequestIdentity({ ...emergency, requestId: '018f47a2-4d12-1abc-8def-0123456789ab' }));
  assert.throws(() => buildAiOrchestratorAdminRequestIdentity({ ...emergency, expectedVersion: 1, expectedRevisionHash: SHA_A }));
  assert.throws(() => buildAiOrchestratorAdminRequestIdentity({ ...emergency, requestedPolicyHash: SHA_A }));
  assert.throws(() => buildAiOrchestratorAdminRequestIdentity({
    ...emergency,
    reason: 'Arresto immediato con\ncarattere di controllo.',
  }));
  assert.throws(() => buildAiOrchestratorAdminRequestIdentity({
    ...emergency,
    operationCode: 'SET_GLOBAL_POLICY',
    requestedPolicyHash: createAiOrchestratorAdminPolicyHash(AI_ORCHESTRATOR_ADMIN_GENESIS_GLOBAL_POLICY),
  }));
});

test('diff deriva permessi minimi e reducer emergency stop è monotono', () => {
  const next = AiOrchestratorAdminGlobalPolicySchema.parse(
    structuredClone(AI_ORCHESTRATOR_ADMIN_GENESIS_GLOBAL_POLICY),
  );
  next.desiredMode = 'READY';
  next.desiredStateMachineEnabled = true;
  next.emergencyStopEngaged = false;
  next.globalKillSwitch = false;
  next.limits.maxRetryableFailures = 1;
  assert.deepEqual(
    diffAiOrchestratorAdminPolicies(AI_ORCHESTRATOR_ADMIN_GENESIS_GLOBAL_POLICY, next, 'SET_GLOBAL_POLICY').requiredPermissions,
    ['ai.orchestrator.configure', 'ai.orchestrator.enable', 'ai.orchestrator.kill', 'ai.orchestrator.retry', 'ai.orchestrator.limits'],
  );

  const agentTarget = AI_ORCHESTRATOR_ADMIN_CONTROL_TARGETS.find(({ scopeType }) => scopeType === 'AGENT');
  assert.ok(agentTarget);
  const agentBefore = createAiOrchestratorAdminGenesisPolicy(agentTarget);
  assert.equal(agentBefore.policyCode, 'AI_ORCHESTRATOR_ADMIN_SCOPE_POLICY');
  const agentAfter = { ...agentBefore, desiredEnabled: true, killSwitch: false };
  assert.deepEqual(
    diffAiOrchestratorAdminPolicies(agentBefore, agentAfter, 'SET_SCOPE_POLICY').requiredPermissions,
    ['ai.orchestrator.configure', 'ai.orchestrator.enable', 'ai.orchestrator.kill', 'ai.orchestrator.agents'],
  );

  const ready = AiOrchestratorAdminGlobalPolicySchema.parse(next);
  const stopped = engageAiOrchestratorEmergencyStop(ready);
  assert.equal(stopped.desiredMode, 'STOPPED');
  assert.equal(stopped.desiredStateMachineEnabled, false);
  assert.equal(stopped.desiredDispatchEnabled, false);
  assert.equal(stopped.emergencyStopEngaged, true);
  assert.equal(stopped.globalKillSwitch, true);
  assert.deepEqual(stopped.limits, ready.limits);
  assert.deepEqual(stopped.operatingWindow, ready.operatingWindow);
  assert.deepEqual(diffAiOrchestratorAdminPolicies(ready, stopped, 'EMERGENCY_STOP').requiredPermissions, ['ai.orchestrator.kill']);
});

test('golden vectors fissano policy, request e revision hash TS/SQL', () => {
  const target = globalTarget();
  const policyHash = createAiOrchestratorAdminPolicyHash(AI_ORCHESTRATOR_ADMIN_GENESIS_GLOBAL_POLICY);
  const request = genesisRequest();
  const requestHash = createAiOrchestratorAdminRequestHash(request);
  const revision = buildAiOrchestratorAdminRevisionIdentity({
    scopeType: target.scopeType,
    scopeCode: target.scopeCode,
    targetDefinitionHash: target.targetDefinitionHash,
    version: 1,
    policyHash,
    previousRevisionHash: null,
    requestId: null,
    requestHash,
    operationCode: 'GENESIS',
    requiredPermissions: [],
    permissionDecisions: [],
    actorUserId: null,
    actorRole: null,
    reasonCode: AI_ORCHESTRATOR_ADMIN_FOUNDATION_REASON_CODE,
    reason: AI_ORCHESTRATOR_ADMIN_FOUNDATION_REASON,
    confirmed: false,
  });
  const emergency = buildAiOrchestratorAdminRequestIdentity({
    actorUserId: 'admin-1',
    requestId: REQUEST_ID,
    scopeType: 'GLOBAL',
    scopeCode: 'global',
    expectedVersion: null,
    expectedRevisionHash: null,
    operationCode: 'EMERGENCY_STOP',
    requestedPolicyHash: AI_ORCHESTRATOR_ADMIN_EMERGENCY_STOP_INTENT_HASH,
    reasonCode: 'OPERATOR_EMERGENCY_STOP',
    reason: 'Arresto immediato confermato dall’amministratore.',
    confirmed: true,
  });

  assert.equal(AI_ORCHESTRATOR_ADMIN_EMERGENCY_STOP_INTENT_HASH, GOLDEN_HASHES.emergencyIntent);
  assert.equal(policyHash, GOLDEN_HASHES.genesisGlobalPolicy);
  assert.equal(requestHash, GOLDEN_HASHES.genesisGlobalRequest);
  assert.equal(createAiOrchestratorAdminRevisionHash(revision), GOLDEN_HASHES.genesisGlobalRevision);
  assert.equal(createAiOrchestratorAdminRequestHash(emergency), GOLDEN_HASHES.emergencyRequest);
});

test('revision identity ordina snapshot RBAC e rifiuta source ROLE', () => {
  const target = globalTarget();
  const input = {
    scopeType: target.scopeType,
    scopeCode: target.scopeCode,
    targetDefinitionHash: target.targetDefinitionHash,
    version: 2,
    policyHash: SHA_A,
    previousRevisionHash: 'b'.repeat(64),
    requestId: REQUEST_ID,
    requestHash: 'c'.repeat(64),
    operationCode: 'SET_GLOBAL_POLICY' as const,
    requiredPermissions: [
      'ai.orchestrator.limits' as const,
      'ai.orchestrator.configure' as const,
    ],
    permissionDecisions: [
      { permission: 'ai.orchestrator.limits' as const, allowed: true, source: 'ADMIN' as const },
      { permission: 'ai.orchestrator.configure' as const, allowed: true, source: 'ADMIN' as const },
    ],
    actorUserId: 'admin-1',
    actorRole: 'admin' as const,
    reasonCode: 'OPERATOR_POLICY_CHANGE',
    reason: 'Aggiornamento controllato dei limiti operativi.',
    confirmed: true,
  };
  const revision = buildAiOrchestratorAdminRevisionIdentity(input);
  assert.deepEqual(revision.requiredPermissions, ['ai.orchestrator.configure', 'ai.orchestrator.limits']);
  assert.deepEqual(revision.permissionDecisions.map(({ permission }) => permission), revision.requiredPermissions);
  assert.equal(createAiOrchestratorAdminRevisionHash(input), createAiOrchestratorAdminRevisionHash(revision));
  assert.throws(() => buildAiOrchestratorAdminRevisionIdentity({
    ...input,
    permissionDecisions: [
      { permission: 'ai.orchestrator.limits', allowed: true, source: 'ROLE' },
      { permission: 'ai.orchestrator.configure', allowed: true, source: 'ADMIN' },
    ] as never,
  }));
  assert.throws(() => buildAiOrchestratorAdminRevisionIdentity({
    ...input,
    reason: 'Aggiornamento con\ncarattere di controllo.',
  }));
});

test('il modulo policy resta puro e non rende eseguibile il worker', () => {
  const source = readFileSync(resolve(import.meta.dirname, '../src/lib/ai-orchestrator/admin-control-policy-v1.ts'), 'utf8');
  assert.doesNotMatch(source, /from ['"]\.\/worker-runtime['"]/);
  assert.doesNotMatch(source, /mock-handler-registry/);
  assert.doesNotMatch(source, /@prisma\/client|\.\.\/prisma/);
  assert.doesNotMatch(source, /\bfetch\s*\(|\bOpenAI\b|https?:\/\//);
});
