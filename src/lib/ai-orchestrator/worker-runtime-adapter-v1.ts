import { setTimeout as retryTimeout } from 'node:timers/promises';
import { canonicalSha256 } from '../canonical-json';
import type { AiWorkflowJobLease } from './worker-runtime';
import type { AiOrchestratorWorkerControlPlaneAuthorityV1 } from './worker-control-plane-authority-v1';

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export const AI_ORCHESTRATOR_WORKER_RUNTIME_ADAPTER_VERSION = '1.0' as const;

export const AI_ORCHESTRATOR_WORKER_RUNTIME_ADAPTER_RETRY_LIMITS = Object.freeze({
  maxAttempts: 3,
  baseDelayMs: 25,
  maxJitterMs: 25,
} as const);

const RUNTIME_ADAPTER_OPERATIONS = Object.freeze([
  'READ_AUTHORITY',
  'RECOVER',
  'SUPERSEDE',
  'ADMIT',
  'CLAIM',
  'HEARTBEAT',
  'SURRENDER',
] as const);

type RuntimeAdapterOperation = typeof RUNTIME_ADAPTER_OPERATIONS[number];

export function calculateAiOrchestratorWorkerRuntimeAdapterRetryDelayMsV1(input: {
  readonly workerInstanceId: string;
  readonly workerBuildHash: string;
  readonly operation: RuntimeAdapterOperation;
  readonly failedAttempt: number;
}) {
  if (
    !UUID_V4_PATTERN.test(input.workerInstanceId)
    || !SHA256_PATTERN.test(input.workerBuildHash)
    || !(RUNTIME_ADAPTER_OPERATIONS as readonly string[]).includes(input.operation)
    || !Number.isSafeInteger(input.failedAttempt)
    || input.failedAttempt < 1
    || input.failedAttempt >= AI_ORCHESTRATOR_WORKER_RUNTIME_ADAPTER_RETRY_LIMITS.maxAttempts
  ) throw new TypeError('AI_WORKER_RUNTIME_ADAPTER_RETRY_INPUT_INVALID');

  const exponential = AI_ORCHESTRATOR_WORKER_RUNTIME_ADAPTER_RETRY_LIMITS.baseDelayMs
    * (2 ** (input.failedAttempt - 1));
  const entropy = canonicalSha256({
    domain: 'ai.workerRuntimeAdapterTransientRetry.v1',
    workerInstanceId: input.workerInstanceId,
    workerBuildHash: input.workerBuildHash,
    operation: input.operation,
    failedAttempt: input.failedAttempt,
  });
  const jitter = Number.parseInt(entropy.slice(0, 8), 16)
    % (AI_ORCHESTRATOR_WORKER_RUNTIME_ADAPTER_RETRY_LIMITS.maxJitterMs + 1);
  return exponential + jitter;
}

export const AI_ORCHESTRATOR_WORKER_RUNTIME_ADAPTER_ERROR_CODES = Object.freeze([
  'AI_WORKER_RUNTIME_ADAPTER_CONFIG_INVALID',
  'AI_WORKER_RUNTIME_ADAPTER_GATE_DENIED',
  'AI_WORKER_RUNTIME_ADAPTER_CLOSED',
  'AI_WORKER_RUNTIME_ADAPTER_RUNTIME_DENIED',
  'AI_WORKER_RUNTIME_ADAPTER_LEASE_STALE',
  'AI_WORKER_RUNTIME_ADAPTER_DB_TRANSIENT',
  'AI_WORKER_RUNTIME_ADAPTER_DB_UNAVAILABLE',
  'AI_WORKER_RUNTIME_ADAPTER_INVARIANT_VIOLATION',
] as const);

export type AiOrchestratorWorkerRuntimeAdapterErrorCode =
  typeof AI_ORCHESTRATOR_WORKER_RUNTIME_ADAPTER_ERROR_CODES[number];

export class AiOrchestratorWorkerRuntimeAdapterError extends Error {
  readonly code: AiOrchestratorWorkerRuntimeAdapterErrorCode;

  constructor(code: AiOrchestratorWorkerRuntimeAdapterErrorCode) {
    super(code);
    this.name = 'AiOrchestratorWorkerRuntimeAdapterError';
    this.code = code;
  }
}

declare const workerRuntimeLeaseHandleBrand: unique symbol;
export type AiOrchestratorWorkerRuntimeLeaseHandleV1 = Readonly<{
  readonly [workerRuntimeLeaseHandleBrand]: true;
}>;

export interface AiOrchestratorWorkerRuntimeClaimV1 {
  readonly lease: AiOrchestratorWorkerRuntimeLeaseHandleV1;
}

export interface AiOrchestratorWorkerRuntimeAdapterV1 {
  readonly adapterVersion: typeof AI_ORCHESTRATOR_WORKER_RUNTIME_ADAPTER_VERSION;
  readAuthority(): Promise<Readonly<AiOrchestratorWorkerControlPlaneAuthorityV1>>;
  recover(): Promise<Readonly<{ recovered: number }>>;
  supersede(): Promise<Readonly<{ superseded: number }>>;
  admit(): Promise<Readonly<{ admitted: number }>>;
  claim(): Promise<Readonly<AiOrchestratorWorkerRuntimeClaimV1> | null>;
  heartbeat(lease: AiOrchestratorWorkerRuntimeLeaseHandleV1): Promise<void>;
  surrender(lease: AiOrchestratorWorkerRuntimeLeaseHandleV1): Promise<void>;
  disconnect(): Promise<void>;
}

export interface CreateAiOrchestratorWorkerRuntimeAdapterInputV1 {
  readonly workerInstanceId: string;
  readonly workerBuildHash: string;
  readonly workerEnabled?: string;
}

type WorkerRuntimeModuleV1 = Pick<
  typeof import('./worker-runtime'),
  | 'AiOrchestratorLeaseLostError'
  | 'AiOrchestratorWorkerDisabledError'
  | 'admitAiWorkflowJobOutbox'
  | 'claimNextAiWorkflowJob'
  | 'heartbeatAiWorkflowJobLease'
  | 'recoverExpiredAiWorkflowJobLeases'
  | 'surrenderAiWorkflowJobLease'
  | 'supersedeIneligibleAiWorkflowJobRuntimes'
>;

type LeaseEntry = {
  readonly runtimeLease: AiWorkflowJobLease;
  heartbeatPromise: Promise<void> | null;
  surrenderPromise: Promise<void> | null;
};

function fail(code: AiOrchestratorWorkerRuntimeAdapterErrorCode): never {
  throw new AiOrchestratorWorkerRuntimeAdapterError(code);
}

function prismaErrorCode(error: unknown) {
  if (!error || typeof error !== 'object') return null;
  const candidate = error as { code?: unknown; errorCode?: unknown };
  if (typeof candidate.code === 'string') return candidate.code;
  return typeof candidate.errorCode === 'string' ? candidate.errorCode : null;
}

function mapRuntimeError(error: unknown, runtime: WorkerRuntimeModuleV1) {
  if (error instanceof AiOrchestratorWorkerRuntimeAdapterError) return error;
  if (error instanceof runtime.AiOrchestratorLeaseLostError) {
    return new AiOrchestratorWorkerRuntimeAdapterError(
      'AI_WORKER_RUNTIME_ADAPTER_LEASE_STALE',
    );
  }
  if (error instanceof runtime.AiOrchestratorWorkerDisabledError) {
    return new AiOrchestratorWorkerRuntimeAdapterError(
      'AI_WORKER_RUNTIME_ADAPTER_RUNTIME_DENIED',
    );
  }
  if (error instanceof TypeError) {
    return new AiOrchestratorWorkerRuntimeAdapterError(
      'AI_WORKER_RUNTIME_ADAPTER_CONFIG_INVALID',
    );
  }
  const code = prismaErrorCode(error);
  if (code === 'P2024' || code === 'P2034') {
    return new AiOrchestratorWorkerRuntimeAdapterError(
      'AI_WORKER_RUNTIME_ADAPTER_DB_TRANSIENT',
    );
  }
  if (code === 'P1001' || code === 'P1002' || code === 'P1008' || code === 'P1017') {
    return new AiOrchestratorWorkerRuntimeAdapterError(
      'AI_WORKER_RUNTIME_ADAPTER_DB_UNAVAILABLE',
    );
  }
  return new AiOrchestratorWorkerRuntimeAdapterError(
    'AI_WORKER_RUNTIME_ADAPTER_INVARIANT_VIOLATION',
  );
}

function createLeaseHandle() {
  return Object.freeze(Object.create(null)) as AiOrchestratorWorkerRuntimeLeaseHandleV1;
}

export async function createAiOrchestratorWorkerRuntimeAdapterV1(
  input: CreateAiOrchestratorWorkerRuntimeAdapterInputV1,
): Promise<Readonly<AiOrchestratorWorkerRuntimeAdapterV1>> {
  if (
    !UUID_V4_PATTERN.test(input.workerInstanceId)
    || !SHA256_PATTERN.test(input.workerBuildHash)
  ) fail('AI_WORKER_RUNTIME_ADAPTER_CONFIG_INVALID');
  if ((input.workerEnabled ?? process.env.AI_ORCHESTRATOR_WORKER_ENABLED) !== '1') {
    fail('AI_WORKER_RUNTIME_ADAPTER_GATE_DENIED');
  }

  const [runtime, prismaModule, authority] = await (async () => {
    try {
      return await Promise.all([
        import('./worker-runtime'),
        import('../prisma'),
        import('./worker-control-plane-authority-v1'),
      ]);
    } catch {
      fail('AI_WORKER_RUNTIME_ADAPTER_INVARIANT_VIOLATION');
    }
  })();
  const restrictedRuntime: WorkerRuntimeModuleV1 = runtime;
  const leases = new WeakMap<object, LeaseEntry>();
  let closed = false;
  let disconnectPromise: Promise<void> | null = null;

  const assertOpen = () => {
    if (closed) fail('AI_WORKER_RUNTIME_ADAPTER_CLOSED');
  };
  const execute = async <T>(
    operationCode: RuntimeAdapterOperation,
    operation: () => Promise<T>,
  ) => {
    assertOpen();
    for (
      let attempt = 1;
      attempt <= AI_ORCHESTRATOR_WORKER_RUNTIME_ADAPTER_RETRY_LIMITS.maxAttempts;
      attempt += 1
    ) {
      try {
        return await operation();
      } catch (error) {
        const mapped = mapRuntimeError(error, restrictedRuntime);
        if (
          mapped.code !== 'AI_WORKER_RUNTIME_ADAPTER_DB_TRANSIENT'
          || attempt >= AI_ORCHESTRATOR_WORKER_RUNTIME_ADAPTER_RETRY_LIMITS.maxAttempts
        ) throw mapped;
        await retryTimeout(calculateAiOrchestratorWorkerRuntimeAdapterRetryDelayMsV1({
          workerInstanceId: input.workerInstanceId,
          workerBuildHash: input.workerBuildHash,
          operation: operationCode,
          failedAttempt: attempt,
        }));
        assertOpen();
      }
    }
    return fail('AI_WORKER_RUNTIME_ADAPTER_INVARIANT_VIOLATION');
  };
  const getLeaseEntry = (lease: AiOrchestratorWorkerRuntimeLeaseHandleV1) => {
    if (!lease || typeof lease !== 'object') {
      fail('AI_WORKER_RUNTIME_ADAPTER_LEASE_STALE');
    }
    const entry = leases.get(lease);
    if (!entry) fail('AI_WORKER_RUNTIME_ADAPTER_LEASE_STALE');
    return entry;
  };

  const adapter: AiOrchestratorWorkerRuntimeAdapterV1 = {
    adapterVersion: AI_ORCHESTRATOR_WORKER_RUNTIME_ADAPTER_VERSION,

    readAuthority: () => execute(
      'READ_AUTHORITY',
      () => authority.readAiOrchestratorWorkerControlPlaneAuthorityV1(prismaModule.prisma),
    ),

    recover: async () => Object.freeze({
      recovered: await execute(
        'RECOVER',
        () => restrictedRuntime.recoverExpiredAiWorkflowJobLeases(),
      ),
    }),

    supersede: async () => Object.freeze({
      superseded: await execute(
        'SUPERSEDE',
        () => restrictedRuntime.supersedeIneligibleAiWorkflowJobRuntimes(),
      ),
    }),

    admit: async () => Object.freeze({
      admitted: await execute(
        'ADMIT',
        () => restrictedRuntime.admitAiWorkflowJobOutbox(),
      ),
    }),

    claim: async () => {
      const claimed = await execute(
        'CLAIM',
        () => restrictedRuntime.claimNextAiWorkflowJob({
          workerInstanceId: input.workerInstanceId,
          workerBuildHash: input.workerBuildHash,
        }),
      );
      if (!claimed) return null;
      const lease = createLeaseHandle();
      leases.set(lease, {
        runtimeLease: claimed.lease,
        heartbeatPromise: null,
        surrenderPromise: null,
      });
      return Object.freeze({ lease });
    },

    heartbeat: async (lease) => {
      assertOpen();
      const entry = getLeaseEntry(lease);
      if (entry.surrenderPromise) fail('AI_WORKER_RUNTIME_ADAPTER_LEASE_STALE');
      if (entry.heartbeatPromise) return entry.heartbeatPromise;
      const heartbeatPromise = execute('HEARTBEAT', async () => {
        await restrictedRuntime.heartbeatAiWorkflowJobLease(entry.runtimeLease);
      });
      entry.heartbeatPromise = heartbeatPromise;
      try {
        return await heartbeatPromise;
      } catch (error) {
        if (
          error instanceof AiOrchestratorWorkerRuntimeAdapterError
          && error.code === 'AI_WORKER_RUNTIME_ADAPTER_LEASE_STALE'
        ) leases.delete(lease);
        throw error;
      } finally {
        if (entry.heartbeatPromise === heartbeatPromise) entry.heartbeatPromise = null;
      }
    },

    surrender: async (lease) => {
      assertOpen();
      const entry = getLeaseEntry(lease);
      if (entry.surrenderPromise) return entry.surrenderPromise;
      const surrenderPromise = (async () => {
        if (entry.heartbeatPromise) {
          try {
            await entry.heartbeatPromise;
          } catch {
            // A gate denial must not prevent the risk-reduction surrender path.
          }
        }
        await execute('SURRENDER', async () => {
          await restrictedRuntime.surrenderAiWorkflowJobLease(entry.runtimeLease);
        });
      })();
      entry.surrenderPromise = surrenderPromise;
      try {
        const surrendered = await surrenderPromise;
        leases.delete(lease);
        return surrendered;
      } catch (error) {
        if (
          error instanceof AiOrchestratorWorkerRuntimeAdapterError
          && error.code === 'AI_WORKER_RUNTIME_ADAPTER_LEASE_STALE'
        ) leases.delete(lease);
        throw error;
      } finally {
        if (entry.surrenderPromise === surrenderPromise) entry.surrenderPromise = null;
      }
    },

    disconnect: () => {
      if (disconnectPromise) return disconnectPromise;
      closed = true;
      disconnectPromise = prismaModule.prisma.$disconnect().catch((error: unknown) => {
        throw mapRuntimeError(error, restrictedRuntime);
      });
      return disconnectPromise;
    },
  };

  return Object.freeze(adapter);
}
