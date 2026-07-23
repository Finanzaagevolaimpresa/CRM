import {
  AI_ORCHESTRATOR_WORKER_WIRING_ACTIVATION_EPOCH,
  AI_ORCHESTRATOR_WORKER_WIRING_PRODUCTION_CAN_ACCEPT_LEASE,
  createAiOrchestratorWorkerAdmissionClaimLeaseWiringV1,
  type AiOrchestratorWorkerWiringAuthorityDecision,
  type AiOrchestratorWorkerWiringEnvironmentInput,
  type AiOrchestratorWorkerWiringProcessV1,
} from './worker-admission-claim-lease-wiring-v1';
import type {
  AiOrchestratorWorkerRuntimeAdapterV1,
  AiOrchestratorWorkerRuntimeLeaseHandleV1,
  CreateAiOrchestratorWorkerRuntimeAdapterInputV1,
} from './worker-runtime-adapter-v1';
import type {
  AiOrchestratorWorkerAuthorityBlockReason,
  AiOrchestratorWorkerControlPlaneAuthorityV1,
} from './worker-control-plane-authority-v1';

export const AI_ORCHESTRATOR_WORKER_PRODUCTION_COMPOSITION_VERSION = '1.0' as const;

const INTEGRITY_BLOCK_REASONS = Object.freeze([
  'LEDGER_INTEGRITY_ERROR',
  'DATABASE_GATE_INTEGRITY_ERROR',
  'CAPABILITY_CATALOG_INVALID',
] as const satisfies readonly AiOrchestratorWorkerAuthorityBlockReason[]);

const CAPABILITY_BLOCK_REASONS = Object.freeze([
  'CAPABILITY_GATE_OPEN',
] as const satisfies readonly AiOrchestratorWorkerAuthorityBlockReason[]);

const POLICY_BLOCK_REASONS = Object.freeze([
  'ADMIN_MODE_NOT_READY',
  'ADMIN_EMERGENCY_STOP',
  'ADMIN_GLOBAL_KILL_SWITCH',
  'ADMIN_SCOPE_GATE_CLOSED',
] as const satisfies readonly AiOrchestratorWorkerAuthorityBlockReason[]);

const CONFIGURATION_BLOCK_REASONS = Object.freeze([
  'DATABASE_STATE_MACHINE_GATE_CLOSED',
  'DATABASE_DISPATCH_GATE_CLOSED',
  'PHYSICAL_DISPATCH_BARRIER',
  'NON_MOCK_PROVIDER',
  'NON_SYNTHETIC_DATA_MODE',
  'EXTERNAL_PROVIDERS_ENABLED',
] as const satisfies readonly AiOrchestratorWorkerAuthorityBlockReason[]);

function includesAny(
  reasons: readonly AiOrchestratorWorkerAuthorityBlockReason[],
  candidates: readonly AiOrchestratorWorkerAuthorityBlockReason[],
) {
  return candidates.some((candidate) => reasons.includes(candidate));
}

export function mapAiOrchestratorWorkerAuthorityDecisionV1(
  authority: Readonly<AiOrchestratorWorkerControlPlaneAuthorityV1>,
): AiOrchestratorWorkerWiringAuthorityDecision {
  if (
    authority.activationEpoch !== AI_ORCHESTRATOR_WORKER_WIRING_ACTIVATION_EPOCH
    || !authority.ledger.valid
    || !authority.gates.valid
    || includesAny(authority.blockReasons, INTEGRITY_BLOCK_REASONS)
  ) return Object.freeze({ allowed: false, code: 'AUTHORITY_UNAVAILABLE' });

  if (authority.blockReasons.includes('FOUNDATION_LOCKED_V1')) {
    return Object.freeze({ allowed: false, code: 'FOUNDATION_LOCKED' });
  }
  if (includesAny(authority.blockReasons, CAPABILITY_BLOCK_REASONS)) {
    return Object.freeze({ allowed: false, code: 'CAPABILITY_DENIED' });
  }
  if (includesAny(authority.blockReasons, POLICY_BLOCK_REASONS)) {
    return Object.freeze({ allowed: false, code: 'POLICY_DENIED' });
  }
  if (includesAny(authority.blockReasons, CONFIGURATION_BLOCK_REASONS)) {
    return Object.freeze({ allowed: false, code: 'CONFIGURATION_DENIED' });
  }

  return Object.freeze({ allowed: false, code: 'AUTHORITY_UNAVAILABLE' });
}

export type LoadAiOrchestratorWorkerRuntimeAdapterV1 = (
  input: CreateAiOrchestratorWorkerRuntimeAdapterInputV1,
) => Promise<Readonly<AiOrchestratorWorkerRuntimeAdapterV1>>;

export interface CreateAiOrchestratorWorkerProductionProcessInputV1 {
  readonly environment: AiOrchestratorWorkerWiringEnvironmentInput;
  readonly loadRuntimeAdapter?: LoadAiOrchestratorWorkerRuntimeAdapterV1;
}

function isLeaseStaleError(error: unknown) {
  return Boolean(
    error
    && typeof error === 'object'
    && (error as { code?: unknown }).code === 'AI_WORKER_RUNTIME_ADAPTER_LEASE_STALE',
  );
}

async function loadProductionRuntimeAdapter(
  input: CreateAiOrchestratorWorkerRuntimeAdapterInputV1,
) {
  const runtimeAdapterModule = await import('./worker-runtime-adapter-v1');
  return runtimeAdapterModule.createAiOrchestratorWorkerRuntimeAdapterV1(input);
}

export function createAiOrchestratorWorkerProductionProcessV1(
  input: CreateAiOrchestratorWorkerProductionProcessInputV1,
): AiOrchestratorWorkerWiringProcessV1 {
  let identity: Readonly<{
    workerInstanceId: string;
    workerBuildHash: string;
  }> | null = null;
  let runtimeAdapterPromise: Promise<Readonly<AiOrchestratorWorkerRuntimeAdapterV1>> | null = null;
  const loadRuntimeAdapter = input.loadRuntimeAdapter ?? loadProductionRuntimeAdapter;

  const getRuntimeAdapter = () => {
    if (!identity) throw new Error('AI_WORKER_PRODUCTION_IDENTITY_UNAVAILABLE');
    runtimeAdapterPromise ??= loadRuntimeAdapter({
      workerInstanceId: identity.workerInstanceId,
      workerBuildHash: identity.workerBuildHash,
      workerEnabled: input.environment.workerEnabled,
    });
    return runtimeAdapterPromise;
  };

  const worker = createAiOrchestratorWorkerAdmissionClaimLeaseWiringV1<
    AiOrchestratorWorkerRuntimeLeaseHandleV1
  >({
    environment: input.environment,
    adapters: {
      readAuthority: async () => (
        mapAiOrchestratorWorkerAuthorityDecisionV1(
          await (await getRuntimeAdapter()).readAuthority(),
        )
      ),
      canAcceptLease: () => AI_ORCHESTRATOR_WORKER_WIRING_PRODUCTION_CAN_ACCEPT_LEASE,
      recover: async () => (await (await getRuntimeAdapter()).recover()).recovered,
      supersede: async () => (await (await getRuntimeAdapter()).supersede()).superseded,
      admit: async () => (await (await getRuntimeAdapter()).admit()).admitted,
      claim: async (requestedIdentity) => {
        if (
          !identity
          || requestedIdentity.workerInstanceId !== identity.workerInstanceId
          || requestedIdentity.workerBuildHash !== identity.workerBuildHash
        ) throw new Error('AI_WORKER_PRODUCTION_IDENTITY_MISMATCH');
        const claim = await (await getRuntimeAdapter()).claim();
        return claim?.lease ?? null;
      },
      heartbeat: async (lease) => {
        try {
          await (await getRuntimeAdapter()).heartbeat(lease);
          return 'LEASE_CURRENT';
        } catch (error) {
          if (isLeaseStaleError(error)) return 'LEASE_STALE';
          throw error;
        }
      },
      surrender: async (lease) => {
        await (await getRuntimeAdapter()).surrender(lease);
      },
      disconnect: async () => {
        if (!runtimeAdapterPromise) return;
        await (await runtimeAdapterPromise).disconnect();
      },
    },
  });

  identity = Object.freeze({
    workerInstanceId: worker.workerInstanceId,
    workerBuildHash: worker.workerBuildHash,
  });
  return worker;
}
