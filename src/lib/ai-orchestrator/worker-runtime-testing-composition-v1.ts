import { prisma } from '../prisma';
import {
  AiOrchestratorLeaseLostError,
  admitAiWorkflowJobOutbox,
  claimNextAiWorkflowJob,
  completeAiWorkflowJob,
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
import { createAiMockExecutionOperationV1, type AiMockExecutionOutcome } from './mock-execution-result-wiring-v1';

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
) {
  if (input.workerEnabled !== '1') {
    throw new AiOrchestratorWorkerRuntimeAdapterError('AI_WORKER_RUNTIME_ADAPTER_GATE_DENIED');
  }
  const leases = new WeakMap<object, Entry>();
  const pending = new Set<Promise<unknown>>();
  let disconnected = false;
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
  const boundedDatabaseOperation = async <T>(operation: () => Promise<T>) => {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try { return await operation(); }
      catch (error) {
        const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : null;
        if ((code !== 'P2024' && code !== 'P2034') || attempt === 3) throw error;
      }
    }
    throw new AiOrchestratorWorkerRuntimeAdapterError('AI_WORKER_RUNTIME_ADAPTER_INVARIANT_VIOLATION');
  };
  const close = (handle: AiOrchestratorWorkerRuntimeLeaseHandleV1, entry: Entry) => {
    entry.closed = true;
    leases.delete(handle);
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
    recover: async () => Object.freeze({ recovered: await recoverExpiredAiWorkflowJobLeases() }),
    supersede: async () => Object.freeze({ superseded: await supersedeIneligibleAiWorkflowJobRuntimes() }),
    admit: async () => Object.freeze({ admitted: await admitAiWorkflowJobOutbox() }),
    claim: async () => {
      const claim = await claimNextAiWorkflowJob({ workerInstanceId: input.workerInstanceId, workerBuildHash: input.workerBuildHash });
      if (!claim) return null;
      const handle = opaqueLease();
      leases.set(handle, { claim: Object.freeze(claim), runtimeLease: claim.lease, heartbeatPromise: null, executionPromise: null, surrenderPromise: null, drainRequested: false, terminalOutcome: null, closed: false });
      return Object.freeze({ lease: handle });
    },
    heartbeat: async (handle: AiOrchestratorWorkerRuntimeLeaseHandleV1) => {
      const entry = entryFor(handle);
      if (entry.drainRequested || entry.terminalOutcome || entry.executionPromise) stale();
      if (entry.heartbeatPromise) return entry.heartbeatPromise;
      const promise = tracked(heartbeatAiWorkflowJobLease(entry.runtimeLease).then(() => undefined));
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
        try { await surrenderAiWorkflowJobLease(entry.runtimeLease); }
        catch (error) { if (!(error instanceof AiOrchestratorLeaseLostError)) throw error; }
        close(handle, entry);
      })());
      entry.surrenderPromise = promise;
      try { await promise; } finally { if (entry.surrenderPromise === promise) entry.surrenderPromise = null; }
    },
    disconnect: async () => {
      disconnected = true;
      await Promise.allSettled([...pending]);
      await prisma.$disconnect();
    },
  });

  const executionAdapter: AiOrchestratorMockExecutionAdapterV1 = Object.freeze({
    consumeMockResult: async (handle: AiOrchestratorWorkerRuntimeLeaseHandleV1) => {
      const entry = entryFor(handle);
      if (entry.executionPromise) return entry.executionPromise;
      if (entry.drainRequested || entry.heartbeatPromise || entry.surrenderPromise) stale();
      const operation = createAiMockExecutionOperationV1({
        readAuthority: readExecutionAuthority,
        preflight: () => boundedDatabaseOperation(() => preflightAiWorkflowJobExecution(entry.runtimeLease)),
        complete: (draft) => boundedDatabaseOperation(() => completeAiWorkflowJob(entry.runtimeLease, { resultDraft: draft })),
        fail: (failureCode) => boundedDatabaseOperation(() => failAiWorkflowJob(entry.runtimeLease, { failureCode })) as Promise<AiMockExecutionOutcome>,
        isDrainRequested: () => entry.drainRequested || entry.closed,
        assertClaimMatches: (snapshot) => assertClaim(entry, snapshot),
      });
      const promise = tracked(operation());
      entry.executionPromise = promise;
      try {
        const outcome = await promise;
        entry.terminalOutcome = outcome;
        if (['SUCCEEDED', 'SUPERSEDED', 'FAILED_TERMINAL', 'RETRY_WAIT'].includes(outcome.state)) close(handle, entry);
        return outcome;
      } catch (error) {
        if (error instanceof AiOrchestratorLeaseLostError) close(handle, entry);
        else {
          entry.drainRequested = true;
          try { await surrenderAiWorkflowJobLease(entry.runtimeLease); } catch { /* best-effort */ }
          close(handle, entry);
        }
        throw error;
      } finally { if (entry.executionPromise === promise) entry.executionPromise = null; }
    },
  });
  return Object.freeze({ runtimeAdapter, executionAdapter });
}
