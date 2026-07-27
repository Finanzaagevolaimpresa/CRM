import { prisma } from '../prisma';
import { setTimeout as retryTimeout } from 'node:timers/promises';
import { canonicalSha256 } from '../canonical-json';
import {
  AiOrchestratorExecutionCapabilityDeniedError,
  AiOrchestratorExecutionGateDeniedError,
  AiOrchestratorLeaseLostError,
  AiOrchestratorPersistedJobPolicyMismatchError,
  admitAiWorkflowJobOutbox,
  claimNextAiWorkflowJob,
  completeAiWorkflowJobExecution,
  failAiWorkflowJob,
  heartbeatAiWorkflowJobLease,
  preflightAiWorkflowJobExecution,
  recoverExpiredAiWorkflowJobLeases,
  surrenderAiWorkflowJobLease,
  supersedeIneligibleAiWorkflowJobRuntimes,
  type AiWorkflowJobExecutionPreflight,
  type AiWorkflowJobLease,
  type ClaimedAiWorkflowJob,
} from './worker-runtime';
import {
  AI_ORCHESTRATOR_WORKER_RUNTIME_ADAPTER_VERSION,
  AiOrchestratorWorkerRuntimeAdapterError,
  type AiOrchestratorWorkerRuntimeAdapterV1,
  type AiOrchestratorWorkerRuntimeLeaseHandleV1,
  type CreateAiOrchestratorWorkerRuntimeAdapterInputV1,
} from './worker-runtime-adapter-v1';
import { readAiOrchestratorWorkerControlPlaneAuthorityV1 } from './worker-control-plane-authority-v1';
import { AiMockExecutionError, createAiMockExecutionOperationV1, type AiMockExecutionOutcome } from './mock-execution-result-wiring-v1';
import type { AiResultArtifactDraft } from './result-artifact-contract-v1';

type ExecutionDatabaseOperation = 'AUTHORITY' | 'PREFLIGHT_BEFORE' | 'PREFLIGHT_AFTER' | 'COMPLETE' | 'FAIL' | 'SURRENDER';
export function calculateAiMockExecutionRetryDelayMsV1(input: {
  workerInstanceId: string; workerBuildHash: string; operation: ExecutionDatabaseOperation; failedAttempt: number;
}) {
  if (input.failedAttempt < 1 || input.failedAttempt > 2) throw new TypeError('AI_MOCK_EXECUTION_RETRY_INPUT_INVALID');
  const entropy = canonicalSha256({ domain: 'ai.mockExecutionDatabaseRetry.v1', ...input });
  return 10 * (2 ** (input.failedAttempt - 1)) + (Number.parseInt(entropy.slice(0, 8), 16) % 11);
}

type Entry = {
  readonly claim: Readonly<ClaimedAiWorkflowJob>;
  readonly runtimeLease: AiWorkflowJobLease;
  heartbeatPromise: Promise<void> | null;
  executionPromise: Promise<AiMockExecutionOutcome> | null;
  surrenderPromise: Promise<void> | null;
  drainRequested: boolean;
  terminalOutcome: AiMockExecutionOutcome | null;
  closed: boolean;
};

export interface AiOrchestratorMockExecutionAdapterV1 {
  consumeMockResult(lease: AiOrchestratorWorkerRuntimeLeaseHandleV1): Promise<AiMockExecutionOutcome>;
}

export interface AiOrchestratorTestingRuntimePortsV1 {
  admit: typeof admitAiWorkflowJobOutbox;
  claim: typeof claimNextAiWorkflowJob;
  heartbeat: typeof heartbeatAiWorkflowJobLease;
  surrender: typeof surrenderAiWorkflowJobLease;
  preflight: typeof preflightAiWorkflowJobExecution;
  complete: (lease: AiWorkflowJobLease, options: { resultDraft: AiResultArtifactDraft }) => Promise<AiMockExecutionOutcome>;
  fail: (lease: AiWorkflowJobLease, options: { failureCode: 'POLICY_HASH_MISMATCH' | 'MOCK_HANDLER_TRANSIENT' }) => Promise<AiMockExecutionOutcome>;
  recover: typeof recoverExpiredAiWorkflowJobLeases;
  supersede: typeof supersedeIneligibleAiWorkflowJobRuntimes;
  disconnect: () => Promise<void>;
}

function stale(): never {
  throw new AiOrchestratorWorkerRuntimeAdapterError('AI_WORKER_RUNTIME_ADAPTER_LEASE_STALE');
}

function opaqueLease() {
  return Object.freeze(Object.create(null)) as AiOrchestratorWorkerRuntimeLeaseHandleV1;
}

/** Explicitly synthetic, test-only factory. It is absent from every production import graph. */
export function createAiOrchestratorWorkerSyntheticTestingCompositionV1(
  input: CreateAiOrchestratorWorkerRuntimeAdapterInputV1,
  readExecutionAuthority: () => Promise<Readonly<{ allowed: boolean; capabilityAllowed: boolean }>>,
  overrides: Partial<AiOrchestratorTestingRuntimePortsV1> = {},
) {
  if (input.workerEnabled !== '1') {
    throw new AiOrchestratorWorkerRuntimeAdapterError('AI_WORKER_RUNTIME_ADAPTER_GATE_DENIED');
  }
  const leases = new WeakMap<object, Entry>();
  const runtime: AiOrchestratorTestingRuntimePortsV1 = {
    admit: admitAiWorkflowJobOutbox, claim: claimNextAiWorkflowJob, heartbeat: heartbeatAiWorkflowJobLease,
    surrender: surrenderAiWorkflowJobLease, preflight: preflightAiWorkflowJobExecution,
    complete: completeAiWorkflowJobExecution,
    fail: async (lease, options) => {
      const outcome = await failAiWorkflowJob(lease, options);
      if (!['SUPERSEDED', 'RETRY_WAIT', 'FAILED_TERMINAL'].includes(outcome.state)) {
        throw new AiMockExecutionError('AI_MOCK_EXECUTION_INVARIANT_VIOLATION');
      }
      return { state: outcome.state as 'SUPERSEDED' | 'RETRY_WAIT' | 'FAILED_TERMINAL' };
    },
    recover: recoverExpiredAiWorkflowJobLeases,
    supersede: supersedeIneligibleAiWorkflowJobRuntimes, disconnect: () => prisma.$disconnect(),
    ...overrides,
  };
  const pending = new Set<Promise<unknown>>();
  let disconnected = false;
  let disconnectPromise: Promise<void> | null = null;
  const entryFor = (handle: AiOrchestratorWorkerRuntimeLeaseHandleV1) => {
    if (disconnected || !handle || typeof handle !== 'object') stale();
    const entry = leases.get(handle);
    if (!entry || entry.closed) stale();
    return entry;
  };
  const tracked = <T>(promise: Promise<T>) => {
    pending.add(promise);
    void promise.finally(() => pending.delete(promise)).catch(() => undefined);
    return promise;
  };
  const boundedDatabaseOperation = async <T>(operationCode: ExecutionDatabaseOperation, operation: () => Promise<T>) => {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try { return await operation(); }
      catch (error) {
        const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : null;
        if (code === 'P2024' || code === 'P2034') {
          if (attempt === 3) throw new AiMockExecutionError('AI_MOCK_EXECUTION_DB_TRANSIENT');
          await retryTimeout(calculateAiMockExecutionRetryDelayMsV1({
            workerInstanceId: input.workerInstanceId, workerBuildHash: input.workerBuildHash,
            operation: operationCode, failedAttempt: attempt,
          }));
          continue;
        }
        if (code === 'P1001' || code === 'P1002' || code === 'P1008' || code === 'P1017') {
          throw new AiMockExecutionError('AI_MOCK_EXECUTION_DB_UNAVAILABLE');
        }
        if (error instanceof AiOrchestratorExecutionGateDeniedError) {
          throw new AiMockExecutionError('AI_MOCK_EXECUTION_AUTHORITY_DENIED');
        }
        if (error instanceof AiOrchestratorExecutionCapabilityDeniedError) {
          throw new AiMockExecutionError('AI_MOCK_EXECUTION_CAPABILITY_DENIED');
        }
        if (
          error instanceof AiOrchestratorLeaseLostError
          || error instanceof AiOrchestratorPersistedJobPolicyMismatchError
          || error instanceof AiMockExecutionError
        ) throw error;
        throw new AiMockExecutionError('AI_MOCK_EXECUTION_INVARIANT_VIOLATION');
      }
    }
    throw new AiOrchestratorWorkerRuntimeAdapterError('AI_WORKER_RUNTIME_ADAPTER_INVARIANT_VIOLATION');
  };
  const close = (handle: AiOrchestratorWorkerRuntimeLeaseHandleV1, entry: Entry) => {
    entry.closed = true;
    leases.delete(handle);
  };
  const surrenderEntry = async (handle: AiOrchestratorWorkerRuntimeLeaseHandleV1, entry: Entry) => {
    try {
      await boundedDatabaseOperation('SURRENDER', () => runtime.surrender(entry.runtimeLease));
      close(handle, entry);
    } catch (error) {
      if (error instanceof AiOrchestratorLeaseLostError) {
        close(handle, entry);
        return;
      }
      throw error;
    }
  };
  const assertClaim = (entry: Entry, snapshot: AiWorkflowJobExecutionPreflight) => {
    const claim = entry.claim;
    if (
      snapshot.runtimeId !== claim.runtimeId || snapshot.jobId !== claim.jobId
      || snapshot.intent.jobCode !== claim.jobCode || snapshot.intent.jobVersion !== claim.jobVersion
      || snapshot.intent.payloadHash !== claim.jobPayloadHash
      || snapshot.intent.workflowDefinitionHash !== claim.workflowDefinitionHash
      || snapshot.intent.phaseCode !== claim.phaseCode
      || snapshot.intent.phaseEntrySequence !== claim.phaseEntrySequence
      || snapshot.intent.correctionCycle !== claim.correctionCycle
      || snapshot.intent.executorAgentId !== claim.executorAgentId
      || snapshot.intent.executorAgentCode !== claim.executorAgentCode
      || snapshot.intent.executorAgentConfigVersion !== claim.executorAgentConfigVersion
      || snapshot.intent.executorAgentConfigHash !== claim.executorAgentConfigHash
      || snapshot.capabilityCode !== claim.capabilityCode || snapshot.capabilityHash !== claim.capabilityHash
      || snapshot.handlerCode !== claim.handlerCode || snapshot.handlerVersion !== claim.handlerVersion
      || snapshot.attemptSequence !== claim.attemptSequence
      || snapshot.fencingToken !== claim.fencingToken.toString()
      || snapshot.workerInstanceId !== input.workerInstanceId
      || snapshot.workerBuildHash !== input.workerBuildHash
    ) throw new AiOrchestratorWorkerRuntimeAdapterError('AI_WORKER_RUNTIME_ADAPTER_INVARIANT_VIOLATION');
  };

  const runtimeAdapter: AiOrchestratorWorkerRuntimeAdapterV1 = Object.freeze({
    adapterVersion: AI_ORCHESTRATOR_WORKER_RUNTIME_ADAPTER_VERSION,
    readAuthority: () => readAiOrchestratorWorkerControlPlaneAuthorityV1(prisma),
    recover: async () => Object.freeze({ recovered: await runtime.recover() }),
    supersede: async () => Object.freeze({ superseded: await runtime.supersede() }),
    admit: async () => Object.freeze({ admitted: await runtime.admit() }),
    claim: async () => {
      if (disconnected) throw new AiOrchestratorWorkerRuntimeAdapterError('AI_WORKER_RUNTIME_ADAPTER_CLOSED');
      const claimPromise = tracked((async () => {
        const claim = await runtime.claim({ workerInstanceId: input.workerInstanceId, workerBuildHash: input.workerBuildHash });
        if (!claim) return null;
        if (disconnected) {
          try { await runtime.surrender(claim.lease); } catch { /* shutdown risk reduction */ }
          throw new AiOrchestratorWorkerRuntimeAdapterError('AI_WORKER_RUNTIME_ADAPTER_CLOSED');
        }
        const handle = opaqueLease();
        leases.set(handle, { claim: Object.freeze(claim), runtimeLease: claim.lease, heartbeatPromise: null, executionPromise: null, surrenderPromise: null, drainRequested: false, terminalOutcome: null, closed: false });
        return Object.freeze({ lease: handle });
      })());
      return claimPromise;
    },
    heartbeat: async (handle: AiOrchestratorWorkerRuntimeLeaseHandleV1) => {
      const entry = entryFor(handle);
      if (entry.drainRequested || entry.terminalOutcome || entry.executionPromise) stale();
      if (entry.heartbeatPromise) return entry.heartbeatPromise;
      const promise = tracked(runtime.heartbeat(entry.runtimeLease).then(() => undefined));
      entry.heartbeatPromise = promise;
      try { await promise; } catch (error) { if (error instanceof AiOrchestratorLeaseLostError) close(handle, entry); throw error; }
      finally { if (entry.heartbeatPromise === promise) entry.heartbeatPromise = null; }
    },
    surrender: async (handle: AiOrchestratorWorkerRuntimeLeaseHandleV1) => {
      const entry = entryFor(handle);
      entry.drainRequested = true;
      if (entry.surrenderPromise) return entry.surrenderPromise;
      const promise = tracked((async () => {
        if (entry.heartbeatPromise) { try { await entry.heartbeatPromise; } catch { /* risk reduction */ } }
        if (entry.executionPromise) { try { await entry.executionPromise; } catch { /* risk reduction */ } }
        if (entry.terminalOutcome || entry.closed) return;
        await surrenderEntry(handle, entry);
      })());
      entry.surrenderPromise = promise;
      try { await promise; } finally { if (entry.surrenderPromise === promise) entry.surrenderPromise = null; }
    },
    disconnect: async () => {
      if (disconnectPromise) return disconnectPromise;
      disconnected = true;
      disconnectPromise = (async () => {
        while (pending.size) await Promise.allSettled([...pending]);
        await runtime.disconnect();
      })();
      return disconnectPromise;
    },
  });

  const executionAdapter: AiOrchestratorMockExecutionAdapterV1 = Object.freeze({
    consumeMockResult: async (handle: AiOrchestratorWorkerRuntimeLeaseHandleV1) => {
      const entry = entryFor(handle);
      if (entry.executionPromise) return entry.executionPromise;
      if (entry.drainRequested || entry.heartbeatPromise || entry.surrenderPromise) stale();
      const operation = createAiMockExecutionOperationV1({
        readAuthority: () => boundedDatabaseOperation('AUTHORITY', readExecutionAuthority),
        preflight: (() => {
          let preflightSequence = 0;
          return () => boundedDatabaseOperation(preflightSequence++ === 0 ? 'PREFLIGHT_BEFORE' : 'PREFLIGHT_AFTER', () => runtime.preflight(entry.runtimeLease));
        })(),
        complete: (draft) => boundedDatabaseOperation('COMPLETE', () => runtime.complete(entry.runtimeLease, { resultDraft: draft })),
        fail: (failureCode) => boundedDatabaseOperation('FAIL', () => runtime.fail(entry.runtimeLease, { failureCode })) as Promise<AiMockExecutionOutcome>,
        isDrainRequested: () => entry.drainRequested || entry.closed,
        assertClaimMatches: (snapshot) => assertClaim(entry, snapshot),
      });
      const executionTask = (async () => {
        try {
          const outcome = await operation();
          entry.terminalOutcome = outcome;
          if (['SUCCEEDED', 'SUPERSEDED', 'FAILED_TERMINAL', 'RETRY_WAIT'].includes(outcome.state)) close(handle, entry);
          return outcome;
        } catch (error) {
          if (error instanceof AiOrchestratorLeaseLostError) close(handle, entry);
          else {
            entry.drainRequested = true;
            await surrenderEntry(handle, entry);
          }
          throw error;
        }
      })();
      const promise = tracked(executionTask);
      entry.executionPromise = promise;
      try { return await promise; }
      finally { if (entry.executionPromise === promise) entry.executionPromise = null; }
    },
  });
  return Object.freeze({ runtimeAdapter, executionAdapter });
}
