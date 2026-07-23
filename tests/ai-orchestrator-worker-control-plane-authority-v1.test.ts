import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  assertAiOrchestratorAdminPersistedRevisionV1,
  assertPersistedRevision,
  type AiOrchestratorAdminPersistedRevisionRowV1,
} from '../src/lib/ai-orchestrator/admin-control-plane-v1';
import {
  AI_ORCHESTRATOR_ADMIN_CONTROL_TARGET_COUNT,
  AI_ORCHESTRATOR_ADMIN_CONTROL_TARGETS,
  AI_ORCHESTRATOR_ADMIN_FOUNDATION_REASON,
  AI_ORCHESTRATOR_ADMIN_FOUNDATION_REASON_CODE,
  buildAiOrchestratorAdminRequestIdentity,
  buildAiOrchestratorAdminRevisionIdentity,
  createAiOrchestratorAdminGenesisPolicy,
  createAiOrchestratorAdminPolicyHash,
  createAiOrchestratorAdminRequestHash,
  createAiOrchestratorAdminRevisionHash,
  type AiOrchestratorAdminGlobalPolicy,
} from '../src/lib/ai-orchestrator/admin-control-policy-v1';
import {
  AI_ORCHESTRATOR_WORKER_AUTHORITY_BLOCK_REASONS,
  evaluateAiOrchestratorWorkerControlPlaneAuthorityV1,
  type AiOrchestratorWorkerControlPlaneGateRowV1,
} from '../src/lib/ai-orchestrator/worker-control-plane-authority-v1';

const root = resolve(import.meta.dirname, '..');
const source = readFileSync(resolve(
  root,
  'src/lib/ai-orchestrator/worker-control-plane-authority-v1.ts',
), 'utf8');

function genesisRows() {
  return AI_ORCHESTRATOR_ADMIN_CONTROL_TARGETS.map((target, index) => {
    const policy = createAiOrchestratorAdminGenesisPolicy(target);
    const policyHash = createAiOrchestratorAdminPolicyHash(policy);
    const requestIdentity = buildAiOrchestratorAdminRequestIdentity({
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
    const requestHash = createAiOrchestratorAdminRequestHash(requestIdentity);
    const revisionIdentity = buildAiOrchestratorAdminRevisionIdentity({
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
    return {
      id: `synthetic-genesis-${index}`,
      scopeType: target.scopeType,
      scopeCode: target.scopeCode,
      targetDefinitionHash: target.targetDefinitionHash,
      version: 1,
      policy,
      policyHash,
      previousRevisionHash: null,
      revisionHash: createAiOrchestratorAdminRevisionHash(revisionIdentity),
      requestId: null,
      requestHash,
      requestedPolicyHash: policyHash,
      expectedVersion: null,
      expectedRevisionHash: null,
      operationCode: 'GENESIS',
      requiredPermissions: [],
      permissionDecisions: [],
      actorUserId: null,
      actorRole: null,
      reasonCode: AI_ORCHESTRATOR_ADMIN_FOUNDATION_REASON_CODE,
      reason: AI_ORCHESTRATOR_ADMIN_FOUNDATION_REASON,
      confirmed: false,
      createdAt: new Date(1_700_000_000_000 + index),
    } satisfies AiOrchestratorAdminPersistedRevisionRowV1;
  });
}

function safeFoundationGate(): AiOrchestratorWorkerControlPlaneGateRowV1 {
  return {
    stateMachineEnabled: false,
    dispatchEnabled: false,
    syntheticDataOnly: true,
    provider: 'mock',
    externalProvidersEnabled: false,
    capabilitySettingCount: 13,
    canonicalCapabilityCount: 13,
    enabledCapabilityCount: 0,
    physicalDispatchBarrierCount: 1,
  };
}

function secondGlobalRevision(
  previous: AiOrchestratorAdminPersistedRevisionRowV1,
  previousRevisionHash = previous.revisionHash,
) {
  const previousPolicy = previous.policy as AiOrchestratorAdminGlobalPolicy;
  const policy: AiOrchestratorAdminGlobalPolicy = {
    ...previousPolicy,
    desiredMode: 'PAUSED',
    desiredStateMachineEnabled: true,
    emergencyStopEngaged: false,
    globalKillSwitch: false,
  };
  const policyHash = createAiOrchestratorAdminPolicyHash(policy);
  const requestId = '12345678-1234-4123-8123-123456789abc';
  const requestIdentity = buildAiOrchestratorAdminRequestIdentity({
    actorUserId: 'synthetic-authority-actor',
    requestId,
    scopeType: 'GLOBAL',
    scopeCode: 'global',
    expectedVersion: 1,
    expectedRevisionHash: previous.revisionHash,
    operationCode: 'SET_GLOBAL_POLICY',
    requestedPolicyHash: policyHash,
    reasonCode: 'CONFIGURATION_CHANGE',
    reason: 'Synthetic authority chain validation.',
    confirmed: true,
  });
  const requestHash = createAiOrchestratorAdminRequestHash(requestIdentity);
  const revisionIdentity = buildAiOrchestratorAdminRevisionIdentity({
    scopeType: 'GLOBAL',
    scopeCode: 'global',
    targetDefinitionHash: previous.targetDefinitionHash,
    version: 2,
    policyHash,
    previousRevisionHash,
    requestId,
    requestHash,
    operationCode: 'SET_GLOBAL_POLICY',
    requiredPermissions: ['ai.orchestrator.enable'],
    permissionDecisions: [{
      permission: 'ai.orchestrator.enable',
      allowed: true,
      source: 'ADMIN',
    }],
    actorUserId: 'synthetic-authority-actor',
    actorRole: 'admin',
    reasonCode: 'CONFIGURATION_CHANGE',
    reason: 'Synthetic authority chain validation.',
    confirmed: true,
  });
  return {
    id: 'synthetic-global-v2',
    scopeType: 'GLOBAL',
    scopeCode: 'global',
    targetDefinitionHash: previous.targetDefinitionHash,
    version: 2,
    policy,
    policyHash,
    previousRevisionHash,
    revisionHash: createAiOrchestratorAdminRevisionHash(revisionIdentity),
    requestId,
    requestHash,
    requestedPolicyHash: policyHash,
    expectedVersion: 1,
    expectedRevisionHash: previous.revisionHash,
    operationCode: 'SET_GLOBAL_POLICY',
    requiredPermissions: ['ai.orchestrator.enable'],
    permissionDecisions: [{
      permission: 'ai.orchestrator.enable',
      allowed: true,
      source: 'ADMIN',
    }],
    actorUserId: 'synthetic-authority-actor',
    actorRole: 'admin',
    reasonCode: 'CONFIGURATION_CHANGE',
    reason: 'Synthetic authority chain validation.',
    confirmed: true,
    createdAt: new Date(previous.createdAt.getTime() + 1_000),
  } satisfies AiOrchestratorAdminPersistedRevisionRowV1;
}

test('validator ledger machine-safe v1 è esportato con alias retrocompatibile', () => {
  const row = genesisRows()[0];
  assert.ok(row);
  assert.equal(assertPersistedRevision, assertAiOrchestratorAdminPersistedRevisionV1);
  assert.deepEqual(
    assertPersistedRevision(row),
    assertAiOrchestratorAdminPersistedRevisionV1(row),
  );
});

test('authority valida tutti i 36 target ma resta sempre foundation-locked', () => {
  const revisions = genesisRows();
  assert.equal(revisions.length, AI_ORCHESTRATOR_ADMIN_CONTROL_TARGET_COUNT);
  const authority = evaluateAiOrchestratorWorkerControlPlaneAuthorityV1({
    revisions,
    gate: safeFoundationGate(),
  });
  assert.equal(authority.ledger.valid, true);
  assert.equal(authority.ledger.targetCount, 36);
  assert.equal(authority.ledger.revisionCount, 36);
  assert.equal(authority.gates.valid, true);
  assert.equal(authority.gates.physicalDispatchBarrierPresent, true);
  assert.equal(authority.operational, false);
  assert.equal(authority.databaseEligible, false);
  assert.equal(authority.canAdmit, false);
  assert.equal(authority.canClaim, false);
  assert.equal(authority.canHeartbeat, false);
  assert.equal(authority.blockReasons[0], 'FOUNDATION_LOCKED_V1');
  assert.ok(authority.blockReasons.includes('PHYSICAL_DISPATCH_BARRIER'));
});

test('authority verifica la chain completa e nega target mancanti o predecessor falsi', () => {
  const revisions = genesisRows();
  const global = revisions.find((revision) => revision.scopeType === 'GLOBAL');
  assert.ok(global);
  const validSecond = secondGlobalRevision(global);
  const valid = evaluateAiOrchestratorWorkerControlPlaneAuthorityV1({
    revisions: [...revisions, validSecond],
    gate: safeFoundationGate(),
  });
  assert.equal(valid.ledger.valid, true);
  assert.equal(valid.ledger.revisionCount, 37);

  const brokenSecond = secondGlobalRevision(global, 'f'.repeat(64));
  const broken = evaluateAiOrchestratorWorkerControlPlaneAuthorityV1({
    revisions: [...revisions, brokenSecond],
    gate: safeFoundationGate(),
  });
  assert.equal(broken.ledger.valid, false);
  assert.ok(broken.blockReasons.includes('LEDGER_INTEGRITY_ERROR'));

  const missing = evaluateAiOrchestratorWorkerControlPlaneAuthorityV1({
    revisions: revisions.slice(1),
    gate: safeFoundationGate(),
  });
  assert.equal(missing.ledger.valid, false);
  assert.ok(missing.blockReasons.includes('LEDGER_INTEGRITY_ERROR'));
});

test('authority nega gate o barriera incoerenti senza esporre policy o reason', () => {
  const authority = evaluateAiOrchestratorWorkerControlPlaneAuthorityV1({
    revisions: genesisRows(),
    gate: {
      ...safeFoundationGate(),
      dispatchEnabled: true,
      externalProvidersEnabled: true,
      enabledCapabilityCount: 1,
      physicalDispatchBarrierCount: 0,
    },
  });
  assert.equal(authority.operational, false);
  assert.equal(authority.gates.valid, false);
  assert.ok(authority.blockReasons.includes('DATABASE_GATE_INTEGRITY_ERROR'));
  assert.ok(authority.blockReasons.includes('EXTERNAL_PROVIDERS_ENABLED'));
  assert.ok(authority.blockReasons.includes('CAPABILITY_GATE_OPEN'));
  assert.doesNotMatch(JSON.stringify(authority), /reasonCode|requestedPolicyHash|actorUserId/);
});

test('reader DB è esclusivamente read-only e non richiede un attore UI', () => {
  assert.match(source, /SET TRANSACTION READ ONLY/);
  assert.match(source, /ORDER BY "scopeType" COLLATE "C", "scopeCode" COLLATE "C", "version"/);
  assert.match(source, /expected_ai_workflow_worker_capability/);
  assert.match(source, /AiOrchestratorSetting_dispatch_disabled_check/);
  assert.doesNotMatch(source, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/);
  assert.doesNotMatch(source, /actorUserId|requireCurrentPermission|evaluatePermission/);
  assert.deepEqual(
    new Set(AI_ORCHESTRATOR_WORKER_AUTHORITY_BLOCK_REASONS).size,
    AI_ORCHESTRATOR_WORKER_AUTHORITY_BLOCK_REASONS.length,
  );
});
