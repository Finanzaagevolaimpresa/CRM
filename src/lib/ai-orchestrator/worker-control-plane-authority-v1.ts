import { Prisma, type PrismaClient } from '@prisma/client';
import {
  assertAiOrchestratorAdminPersistedRevisionV1,
  type AiOrchestratorAdminPersistedRevisionRowV1,
  type AiOrchestratorAdminRevisionSnapshot,
} from './admin-control-plane-v1';
import {
  AI_ORCHESTRATOR_ADMIN_ACTIVATION_EPOCH,
  AI_ORCHESTRATOR_ADMIN_CONTROL_TARGET_COUNT,
  AI_ORCHESTRATOR_ADMIN_CONTROL_TARGETS,
  AI_ORCHESTRATOR_ADMIN_GLOBAL_POLICY_CODE,
  type AiOrchestratorAdminGlobalPolicy,
  type AiOrchestratorAdminScopePolicy,
} from './admin-control-policy-v1';
import { AI_ORCHESTRATOR_WORKER_CAPABILITIES } from './worker-runtime-policy-v1';

export const AI_ORCHESTRATOR_WORKER_CONTROL_PLANE_AUTHORITY_VERSION = '1.0' as const;

export const AI_ORCHESTRATOR_WORKER_AUTHORITY_BLOCK_REASONS = Object.freeze([
  'FOUNDATION_LOCKED_V1',
  'LEDGER_INTEGRITY_ERROR',
  'DATABASE_GATE_INTEGRITY_ERROR',
  'DATABASE_STATE_MACHINE_GATE_CLOSED',
  'DATABASE_DISPATCH_GATE_CLOSED',
  'PHYSICAL_DISPATCH_BARRIER',
  'NON_MOCK_PROVIDER',
  'NON_SYNTHETIC_DATA_MODE',
  'EXTERNAL_PROVIDERS_ENABLED',
  'CAPABILITY_CATALOG_INVALID',
  'CAPABILITY_GATE_OPEN',
  'ADMIN_MODE_NOT_READY',
  'ADMIN_EMERGENCY_STOP',
  'ADMIN_GLOBAL_KILL_SWITCH',
  'ADMIN_SCOPE_GATE_CLOSED',
] as const);

export type AiOrchestratorWorkerAuthorityBlockReason =
  typeof AI_ORCHESTRATOR_WORKER_AUTHORITY_BLOCK_REASONS[number];

export interface AiOrchestratorWorkerControlPlaneGateRowV1 {
  readonly stateMachineEnabled: boolean;
  readonly dispatchEnabled: boolean;
  readonly syntheticDataOnly: boolean;
  readonly provider: string;
  readonly externalProvidersEnabled: boolean;
  readonly capabilitySettingCount: number;
  readonly canonicalCapabilityCount: number;
  readonly enabledCapabilityCount: number;
  readonly physicalDispatchBarrierCount: number;
}

export interface AiOrchestratorWorkerControlPlaneAuthorityV1 {
  readonly schemaVersion: 1;
  readonly authorityVersion: typeof AI_ORCHESTRATOR_WORKER_CONTROL_PLANE_AUTHORITY_VERSION;
  readonly activationEpoch: typeof AI_ORCHESTRATOR_ADMIN_ACTIVATION_EPOCH;
  readonly operational: false;
  readonly databaseEligible: false;
  readonly canAdmit: false;
  readonly canClaim: false;
  readonly canHeartbeat: false;
  readonly ledger: Readonly<{
    valid: boolean;
    targetCount: number;
    revisionCount: number;
  }>;
  readonly gates: Readonly<{
    valid: boolean;
    stateMachineEnabled: boolean;
    dispatchEnabled: boolean;
    syntheticDataOnly: boolean;
    providerIsMock: boolean;
    externalProvidersDisabled: boolean;
    capabilitySettingCount: number;
    canonicalCapabilityCount: number;
    enabledCapabilityCount: number;
    physicalDispatchBarrierPresent: boolean;
  }>;
  readonly blockReasons: readonly AiOrchestratorWorkerAuthorityBlockReason[];
}

export interface EvaluateAiOrchestratorWorkerControlPlaneAuthorityInputV1 {
  readonly revisions: readonly AiOrchestratorAdminPersistedRevisionRowV1[];
  readonly gate: AiOrchestratorWorkerControlPlaneGateRowV1 | null;
}

function targetKey(scopeType: string, scopeCode: string) {
  return `${scopeType}\u001f${scopeCode}`;
}

function validateCompleteLedgerChain(
  rows: readonly AiOrchestratorAdminPersistedRevisionRowV1[],
) {
  const revisions = rows.map(assertAiOrchestratorAdminPersistedRevisionV1);
  const grouped = new Map<string, AiOrchestratorAdminRevisionSnapshot[]>();
  for (const revision of revisions) {
    if (!(revision.createdAt instanceof Date) || Number.isNaN(revision.createdAt.getTime())) {
      throw new Error('AI_ORCHESTRATOR_WORKER_AUTHORITY_LEDGER_TIMESTAMP_INVALID');
    }
    const key = targetKey(revision.scopeType, revision.scopeCode);
    const chain = grouped.get(key) ?? [];
    chain.push(revision);
    grouped.set(key, chain);
  }

  if (
    grouped.size !== AI_ORCHESTRATOR_ADMIN_CONTROL_TARGET_COUNT
    || AI_ORCHESTRATOR_ADMIN_CONTROL_TARGETS.some(
      (target) => !grouped.has(targetKey(target.scopeType, target.scopeCode)),
    )
  ) throw new Error('AI_ORCHESTRATOR_WORKER_AUTHORITY_LEDGER_TARGETS_INCOMPLETE');

  const latest = new Map<string, AiOrchestratorAdminRevisionSnapshot>();
  for (const target of AI_ORCHESTRATOR_ADMIN_CONTROL_TARGETS) {
    const key = targetKey(target.scopeType, target.scopeCode);
    const chain = [...(grouped.get(key) ?? [])].sort((left, right) => left.version - right.version);
    if (chain.length === 0) {
      throw new Error('AI_ORCHESTRATOR_WORKER_AUTHORITY_LEDGER_TARGET_EMPTY');
    }
    for (const [index, revision] of chain.entries()) {
      const expectedVersion = index + 1;
      const expectedPreviousHash = index === 0 ? null : chain[index - 1]?.revisionHash ?? null;
      if (
        revision.version !== expectedVersion
        || revision.previousRevisionHash !== expectedPreviousHash
      ) throw new Error('AI_ORCHESTRATOR_WORKER_AUTHORITY_LEDGER_CHAIN_INVALID');
    }
    latest.set(key, chain[chain.length - 1]);
  }
  return { latest, revisionCount: revisions.length };
}

function addReason(
  reasons: AiOrchestratorWorkerAuthorityBlockReason[],
  reason: AiOrchestratorWorkerAuthorityBlockReason,
) {
  if (!reasons.includes(reason)) reasons.push(reason);
}

export function evaluateAiOrchestratorWorkerControlPlaneAuthorityV1(
  input: EvaluateAiOrchestratorWorkerControlPlaneAuthorityInputV1,
): Readonly<AiOrchestratorWorkerControlPlaneAuthorityV1> {
  const blockReasons: AiOrchestratorWorkerAuthorityBlockReason[] = ['FOUNDATION_LOCKED_V1'];
  let ledgerValid = false;
  let targetCount = 0;
  let revisionCount = input.revisions.length;
  let latest = new Map<string, AiOrchestratorAdminRevisionSnapshot>();

  try {
    const validated = validateCompleteLedgerChain(input.revisions);
    latest = validated.latest;
    revisionCount = validated.revisionCount;
    targetCount = latest.size;
    ledgerValid = true;
  } catch {
    addReason(blockReasons, 'LEDGER_INTEGRITY_ERROR');
  }

  if (ledgerValid) {
    const global = latest.get(targetKey('GLOBAL', 'global'));
    if (!global || global.policy.policyCode !== AI_ORCHESTRATOR_ADMIN_GLOBAL_POLICY_CODE) {
      ledgerValid = false;
      addReason(blockReasons, 'LEDGER_INTEGRITY_ERROR');
    } else {
      const globalPolicy = global.policy as AiOrchestratorAdminGlobalPolicy;
      if (globalPolicy.desiredMode !== 'READY') addReason(blockReasons, 'ADMIN_MODE_NOT_READY');
      if (globalPolicy.emergencyStopEngaged) addReason(blockReasons, 'ADMIN_EMERGENCY_STOP');
      if (globalPolicy.globalKillSwitch) addReason(blockReasons, 'ADMIN_GLOBAL_KILL_SWITCH');
      const scopeClosed = [...latest.values()].some((revision) => {
        if (revision.scopeType === 'GLOBAL') return false;
        const policy = revision.policy as AiOrchestratorAdminScopePolicy;
        return policy.desiredEnabled !== true || policy.killSwitch !== false;
      });
      if (scopeClosed) addReason(blockReasons, 'ADMIN_SCOPE_GATE_CLOSED');
    }
  }

  const gate = input.gate;
  const capabilityCount = AI_ORCHESTRATOR_WORKER_CAPABILITIES.length;
  const gateValid = Boolean(
    gate
    && Number.isSafeInteger(gate.capabilitySettingCount)
    && Number.isSafeInteger(gate.canonicalCapabilityCount)
    && Number.isSafeInteger(gate.enabledCapabilityCount)
    && gate.capabilitySettingCount === capabilityCount
    && gate.canonicalCapabilityCount === capabilityCount
    && gate.enabledCapabilityCount === 0
    && gate.physicalDispatchBarrierCount === 1
    && gate.stateMachineEnabled === false
    && gate.dispatchEnabled === false
    && gate.syntheticDataOnly === true
    && gate.provider === 'mock'
    && gate.externalProvidersEnabled === false,
  );
  if (!gateValid) addReason(blockReasons, 'DATABASE_GATE_INTEGRITY_ERROR');
  if (!gate?.stateMachineEnabled) addReason(blockReasons, 'DATABASE_STATE_MACHINE_GATE_CLOSED');
  if (!gate?.dispatchEnabled) addReason(blockReasons, 'DATABASE_DISPATCH_GATE_CLOSED');
  if (gate?.physicalDispatchBarrierCount === 1) addReason(blockReasons, 'PHYSICAL_DISPATCH_BARRIER');
  if (gate?.provider !== 'mock') addReason(blockReasons, 'NON_MOCK_PROVIDER');
  if (gate?.syntheticDataOnly !== true) addReason(blockReasons, 'NON_SYNTHETIC_DATA_MODE');
  if (gate?.externalProvidersEnabled !== false) addReason(blockReasons, 'EXTERNAL_PROVIDERS_ENABLED');
  if (
    !gate
    || gate.capabilitySettingCount !== capabilityCount
    || gate.canonicalCapabilityCount !== capabilityCount
  ) addReason(blockReasons, 'CAPABILITY_CATALOG_INVALID');
  if ((gate?.enabledCapabilityCount ?? 0) !== 0) addReason(blockReasons, 'CAPABILITY_GATE_OPEN');

  return Object.freeze({
    schemaVersion: 1,
    authorityVersion: AI_ORCHESTRATOR_WORKER_CONTROL_PLANE_AUTHORITY_VERSION,
    activationEpoch: AI_ORCHESTRATOR_ADMIN_ACTIVATION_EPOCH,
    operational: false,
    databaseEligible: false,
    canAdmit: false,
    canClaim: false,
    canHeartbeat: false,
    ledger: Object.freeze({
      valid: ledgerValid,
      targetCount,
      revisionCount,
    }),
    gates: Object.freeze({
      valid: gateValid,
      stateMachineEnabled: gate?.stateMachineEnabled ?? false,
      dispatchEnabled: gate?.dispatchEnabled ?? false,
      syntheticDataOnly: gate?.syntheticDataOnly ?? false,
      providerIsMock: gate?.provider === 'mock',
      externalProvidersDisabled: gate?.externalProvidersEnabled === false,
      capabilitySettingCount: gate?.capabilitySettingCount ?? 0,
      canonicalCapabilityCount: gate?.canonicalCapabilityCount ?? 0,
      enabledCapabilityCount: gate?.enabledCapabilityCount ?? 0,
      physicalDispatchBarrierPresent: gate?.physicalDispatchBarrierCount === 1,
    }),
    blockReasons: Object.freeze(blockReasons),
  });
}

export async function readAiOrchestratorWorkerControlPlaneAuthorityV1(
  prisma: PrismaClient,
): Promise<Readonly<AiOrchestratorWorkerControlPlaneAuthorityV1>> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    const revisions = await tx.$queryRaw<AiOrchestratorAdminPersistedRevisionRowV1[]>(Prisma.sql`
      SELECT *
      FROM "AiOrchestratorAdminPolicyRevision"
      ORDER BY "scopeType" COLLATE "C", "scopeCode" COLLATE "C", "version"
    `);
    const gates = await tx.$queryRaw<AiOrchestratorWorkerControlPlaneGateRowV1[]>(Prisma.sql`
      SELECT
        orchestrator."stateMachineEnabled",
        orchestrator."dispatchEnabled",
        orchestrator."syntheticDataOnly",
        orchestrator."provider",
        control."externalProvidersEnabled",
        (
          SELECT COUNT(*)::INTEGER
          FROM "AiOrchestratorWorkerCapabilitySetting"
        ) AS "capabilitySettingCount",
        (
          SELECT COUNT(*)::INTEGER
          FROM "AiOrchestratorWorkerCapabilitySetting" setting
          CROSS JOIN LATERAL "expected_ai_workflow_worker_capability"(setting."jobCode") expected
          WHERE setting."capabilityCode" = expected."capabilityCode"
            AND setting."capabilityVersion" = '1.0'
            AND setting."capabilityHash" = expected."capabilityHash"
        ) AS "canonicalCapabilityCount",
        (
          SELECT COUNT(*)::INTEGER
          FROM "AiOrchestratorWorkerCapabilitySetting"
          WHERE "enabled" = true
        ) AS "enabledCapabilityCount",
        (
          SELECT COUNT(*)::INTEGER
          FROM pg_constraint constraint_row
          WHERE constraint_row.conrelid = '"AiOrchestratorSetting"'::REGCLASS
            AND constraint_row.conname = 'AiOrchestratorSetting_dispatch_disabled_check'
            AND constraint_row.convalidated = true
            AND PG_GET_CONSTRAINTDEF(constraint_row.oid) = 'CHECK (("dispatchEnabled" = false))'
        ) AS "physicalDispatchBarrierCount"
      FROM "AiOrchestratorSetting" orchestrator
      CROSS JOIN "AiControlSetting" control
      WHERE orchestrator."id" = 'global' AND control."id" = 'global'
    `);
    return evaluateAiOrchestratorWorkerControlPlaneAuthorityV1({
      revisions,
      gate: gates[0] ?? null,
    });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}
