import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { AiMockExecutionError, createAiMockExecutionOperationV1 } from '../src/lib/ai-orchestrator/mock-execution-result-wiring-v1';
import { createFaiAuditJobPlan, parsePersistedFaiAuditJobIntent } from '../src/lib/ai-orchestrator/job-planner';
import { FAI_AUDIT_WORKFLOW_DEFINITION_HASH, FAI_AUDIT_WORKFLOW_ID, FAI_AUDIT_WORKFLOW_VERSION } from '../src/lib/ai-orchestrator/audit-workflow-v1-1';
import { getFaiAuditExecutorBinding } from '../src/lib/ai-orchestrator/job-catalog-v1';
import { AI_ORCHESTRATOR_WORKER_CAPABILITY_HASHES, AI_ORCHESTRATOR_WORKER_RUNTIME_POLICY_CODE, AI_ORCHESTRATOR_WORKER_RUNTIME_POLICY_HASH, AI_ORCHESTRATOR_WORKER_RUNTIME_POLICY_VERSION, getAiOrchestratorWorkerCapability } from '../src/lib/ai-orchestrator/worker-runtime-policy-v1';
import { createAiOrchestratorWorkerSyntheticTestingCompositionV1, calculateAiMockExecutionRetryDelayMsV1 } from '../src/lib/ai-orchestrator/worker-runtime-testing-composition-v1';
import {
  AiOrchestratorExecutionCapabilityDeniedError,
  AiOrchestratorExecutionGateDeniedError,
  AiOrchestratorLeaseLostError,
  AiOrchestratorPersistedJobPolicyMismatchError,
  type AiWorkflowJobLease,
  type ClaimedAiWorkflowJob,
} from '../src/lib/ai-orchestrator/worker-runtime';

const root = resolve(import.meta.dirname, '..');
const facadeSource = readFileSync(resolve(root, 'src/lib/ai-orchestrator/mock-execution-result-wiring-v1.ts'), 'utf8');
const adapterSource = readFileSync(resolve(root, 'src/lib/ai-orchestrator/worker-runtime-adapter-v1.ts'), 'utf8');
const productionSource = readFileSync(resolve(root, 'src/lib/ai-orchestrator/worker-admission-claim-lease-process-v1.ts'), 'utf8');
const entrypointSource = readFileSync(resolve(root, 'scripts/ai-orchestrator-worker.ts'), 'utf8');
const testingSource = readFileSync(resolve(root, 'src/lib/ai-orchestrator/worker-runtime-testing-composition-v1.ts'), 'utf8');

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function syntheticExecutionFixture() {
  const executor = getFaiAuditExecutorBinding('DOCUMENT_INGESTION');
  assert.ok(executor);
  const intent = createFaiAuditJobPlan({
    workflowInstanceId: 'synthetic-pr83-sequence', workflowCode: FAI_AUDIT_WORKFLOW_ID,
    workflowVersion: FAI_AUDIT_WORKFLOW_VERSION, workflowDefinitionHash: FAI_AUDIT_WORKFLOW_DEFINITION_HASH,
    phaseCode: 'DATA_VALIDATION', phaseEntrySequence: 4, sourceCommandIdempotencyKey: 'synthetic-pr83-command',
    sourceTransitionCode: 'WF-004', sourceTransitionSequence: 4, sourceState: 'NEEDS_DOCUMENTS',
    sourceStateVersion: 4, targetState: 'DATA_VALIDATION', correlationId: 'synthetic-pr83-correlation',
    correctionCycle: 0, availableAt: '2026-01-01T00:00:00.000Z',
    resolvedExecutors: [{ executorAgentId: 'synthetic-agent', ...executor }],
  }).jobs[0];
  assert.ok(intent);
  const capability = getAiOrchestratorWorkerCapability(intent.jobCode);
  assert.ok(capability);
  const runtimeLease = Object.freeze({}) as AiWorkflowJobLease;
  const claim: ClaimedAiWorkflowJob = {
    runtimeId: 'runtime', jobId: 'job', jobCode: intent.jobCode, jobVersion: intent.jobVersion,
    jobPayloadHash: intent.payloadHash, payload: JSON.parse(JSON.stringify(intent.payload)), workflowInstanceId: 'synthetic-pr83-sequence',
    workflowDefinitionHash: intent.workflowDefinitionHash, phaseCode: intent.phaseCode,
    phaseEntrySequence: intent.phaseEntrySequence, correctionCycle: intent.correctionCycle,
    executorAgentId: intent.executorAgentId, executorAgentCode: intent.executorAgentCode,
    executorAgentConfigVersion: intent.executorAgentConfigVersion, executorAgentConfigHash: intent.executorAgentConfigHash,
    capabilityCode: capability.capabilityCode, capabilityHash: AI_ORCHESTRATOR_WORKER_CAPABILITY_HASHES[intent.jobCode],
    handlerCode: capability.handlerCode, handlerVersion: capability.handlerVersion,
    attemptSequence: 1, fencingToken: 1n, leaseExpiresAt: new Date('2026-01-01T00:02:00.000Z'), lease: runtimeLease,
  };
  const snapshot = Object.freeze({
    intent, runtimeId: claim.runtimeId, jobId: claim.jobId, attemptId: 'attempt', attemptSequence: 1,
    fencingToken: '1', workerInstanceId: 'worker', workerBuildHash: 'a'.repeat(64),
    leaseExpiresAt: claim.leaseExpiresAt.toISOString(), leaseMaxExpiresAt: '2026-01-01T00:10:00.000Z',
    runtimePolicyCode: AI_ORCHESTRATOR_WORKER_RUNTIME_POLICY_CODE,
    runtimePolicyVersion: AI_ORCHESTRATOR_WORKER_RUNTIME_POLICY_VERSION,
    runtimePolicyHash: AI_ORCHESTRATOR_WORKER_RUNTIME_POLICY_HASH,
    capabilityCode: capability.capabilityCode, capabilityVersion: capability.capabilityVersion,
    capabilityHash: claim.capabilityHash, handlerCode: capability.handlerCode, handlerVersion: capability.handlerVersion,
  });
  return { claim, snapshot };
}

function deniedPorts(drain = false) {
  return {
    readAuthority: async () => ({ allowed: false, capabilityAllowed: false }),
    preflight: async () => { throw new Error('must not preflight'); },
    complete: async () => { throw new Error('must not complete'); },
    fail: async () => { throw new Error('must not fail'); },
    isDrainRequested: () => drain,
    assertClaimMatches: () => { throw new Error('must not compare'); },
  };
}

test('authority and drain deny before preflight or handler', async () => {
  await assert.rejects(createAiMockExecutionOperationV1(deniedPorts())(), (error) => (
    error instanceof AiMockExecutionError && error.code === 'AI_MOCK_EXECUTION_AUTHORITY_DENIED'
  ));
  await assert.rejects(createAiMockExecutionOperationV1(deniedPorts(true))(), (error) => (
    error instanceof AiMockExecutionError && error.code === 'AI_MOCK_EXECUTION_DRAINING'
  ));
});

test('PR83 facade has no Prisma, dynamic handler, network, filesystem, or caller draft surface', () => {
  assert.doesNotMatch(facadeSource, /@prisma|\.\.\/prisma|node:fs|child_process|worker_threads|fetch\(|https?:|import\(/);
  assert.doesNotMatch(facadeSource, /createSyntheticAiResultDraft/);
  assert.match(facadeSource, /createAiOrchestratorMockHandlerInvocation/);
  assert.match(facadeSource, /executeAiOrchestratorMockHandler/);
  assert.doesNotMatch(productionSource, /SyntheticTestingComposition|MockExecutionAdapter|consumeMockResult/);
  assert.doesNotMatch(entrypointSource, /mock-execution-result-wiring|runtime-testing-composition|mock-handler-registry/);
  assert.doesNotMatch(productionSource, /mock-execution-result-wiring|runtime-testing-composition|mock-handler-registry/);
  assert.doesNotMatch(adapterSource, /mock-execution-result-wiring|runtime-testing-composition|mock-handler-registry|consumeMockResult/);
  const runtimeApi = adapterSource.match(/export interface AiOrchestratorWorkerRuntimeAdapterV1 \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(runtimeApi);
  assert.doesNotMatch(runtimeApi, /consume|execute|complete|fail/i);
});

test('preflight is read-only, uses database time, and execution state is factory scoped', () => {
  const runtime = readFileSync(resolve(root, 'src/lib/ai-orchestrator/worker-runtime.ts'), 'utf8');
  const preflight = runtime.match(/export async function preflightAiWorkflowJobExecution\([\s\S]*?\n\}/)?.[0];
  assert.ok(preflight);
  assert.match(preflight, /SET TRANSACTION READ ONLY/);
  assert.match(preflight, /databaseNow\(tx\)/);
  assert.doesNotMatch(preflight, /FOR UPDATE|\.create\(|\.update|\.delete/);
  for (const field of ['claim', 'heartbeatPromise', 'surrenderPromise', 'executionPromise', 'drainRequested', 'terminalOutcome', 'closed']) {
    assert.match(testingSource, new RegExp(`\\b${field}\\b`));
  }
  assert.match(preflight, /id: 'global'/);
  assert.match(preflight, /aiControlSetting\.findUnique/);
});

test('execution follows the exact authority/preflight/handler/completion sequence', async () => {
  const executor = getFaiAuditExecutorBinding('DOCUMENT_INGESTION');
  assert.ok(executor);
  const intent = createFaiAuditJobPlan({
    workflowInstanceId: 'synthetic-pr83-sequence', workflowCode: FAI_AUDIT_WORKFLOW_ID,
    workflowVersion: FAI_AUDIT_WORKFLOW_VERSION, workflowDefinitionHash: FAI_AUDIT_WORKFLOW_DEFINITION_HASH,
    phaseCode: 'DATA_VALIDATION', phaseEntrySequence: 4, sourceCommandIdempotencyKey: 'synthetic-pr83-command',
    sourceTransitionCode: 'WF-004', sourceTransitionSequence: 4, sourceState: 'NEEDS_DOCUMENTS',
    sourceStateVersion: 4, targetState: 'DATA_VALIDATION', correlationId: 'synthetic-pr83-correlation',
    correctionCycle: 0, availableAt: '2026-01-01T00:00:00.000Z',
    resolvedExecutors: [{ executorAgentId: 'synthetic-agent', ...executor }],
  }).jobs[0];
  assert.ok(intent);
  const capability = getAiOrchestratorWorkerCapability(intent.jobCode);
  assert.ok(capability);
  const snapshot = Object.freeze({
    intent, runtimeId: 'runtime', jobId: 'job', attemptId: 'attempt', attemptSequence: 1,
    fencingToken: '1', workerInstanceId: 'worker', workerBuildHash: 'a'.repeat(64),
    leaseExpiresAt: '2026-01-01T00:02:00.000Z', leaseMaxExpiresAt: '2026-01-01T00:10:00.000Z',
    runtimePolicyCode: AI_ORCHESTRATOR_WORKER_RUNTIME_POLICY_CODE,
    runtimePolicyVersion: AI_ORCHESTRATOR_WORKER_RUNTIME_POLICY_VERSION,
    runtimePolicyHash: AI_ORCHESTRATOR_WORKER_RUNTIME_POLICY_HASH,
    capabilityCode: capability.capabilityCode, capabilityVersion: capability.capabilityVersion,
    capabilityHash: AI_ORCHESTRATOR_WORKER_CAPABILITY_HASHES[intent.jobCode],
    handlerCode: capability.handlerCode, handlerVersion: capability.handlerVersion,
  });
  const calls: string[] = [];
  const outcome = await createAiMockExecutionOperationV1({
    isDrainRequested: () => { calls.push('drain'); return false; },
    readAuthority: async () => { calls.push('authority'); return { allowed: true, capabilityAllowed: true }; },
    preflight: async () => { calls.push('preflight'); return snapshot; },
    assertClaimMatches: () => { calls.push('canonical'); },
    complete: async () => { calls.push('complete'); return { state: 'SUCCEEDED', resultHash: 'b'.repeat(64) }; },
    fail: async () => { calls.push('fail'); return { state: 'FAILED_TERMINAL' }; },
  })();
  assert.equal(outcome.state, 'SUCCEEDED');
  assert.deepEqual(calls, ['drain', 'authority', 'preflight', 'canonical', 'drain', 'drain', 'authority', 'preflight', 'canonical', 'drain', 'complete']);
});

test('testing composition single-flights consume and closes every terminal outcome', async () => {
  for (const state of ['SUCCEEDED', 'SUPERSEDED', 'FAILED_TERMINAL', 'RETRY_WAIT'] as const) {
    const { claim, snapshot } = syntheticExecutionFixture();
    let completionCount = 0;
    const completion = deferred<{ state: typeof state; resultHash?: string }>();
    const composition = createAiOrchestratorWorkerSyntheticTestingCompositionV1(
      { workerInstanceId: 'worker', workerBuildHash: 'a'.repeat(64), workerEnabled: '1' },
      async () => ({ allowed: true, capabilityAllowed: true }),
      {
        claim: async () => claim, preflight: async () => snapshot,
        complete: async () => { completionCount += 1; return completion.promise; },
        disconnect: async () => undefined,
      },
    );
    const claimed = await composition.runtimeAdapter.claim();
    assert.ok(claimed);
    const first = composition.executionAdapter.consumeMockResult(claimed.lease);
    const second = composition.executionAdapter.consumeMockResult(claimed.lease);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(completionCount, 1);
    completion.resolve({ state, resultHash: state === 'SUCCEEDED' ? 'b'.repeat(64) : undefined });
    assert.deepEqual(await first, await second);
    await assert.rejects(composition.executionAdapter.consumeMockResult(claimed.lease), /LEASE_STALE/);
    await composition.runtimeAdapter.disconnect();
  }
});

test('heartbeat/execution/surrender interleavings are bounded and deadlock-free', async () => {
  const { claim, snapshot } = syntheticExecutionFixture();
  const secondPreflight = deferred<typeof snapshot>();
  let preflights = 0;
  let surrenderCount = 0;
  let heartbeatCount = 0;
  const composition = createAiOrchestratorWorkerSyntheticTestingCompositionV1(
    { workerInstanceId: 'worker', workerBuildHash: 'a'.repeat(64), workerEnabled: '1' },
    async () => ({ allowed: true, capabilityAllowed: true }),
    {
      claim: async () => claim,
      preflight: async () => (++preflights === 1 ? snapshot : secondPreflight.promise),
      complete: async () => ({ replay: false, state: 'SUCCEEDED', resultHash: 'b'.repeat(64) }),
      heartbeat: async () => { heartbeatCount += 1; return new Date(); },
      surrender: async () => { surrenderCount += 1; return { state: 'RETRY_WAIT', availableAt: new Date() }; },
      disconnect: async () => undefined,
    },
  );
  const claimed = await composition.runtimeAdapter.claim();
  assert.ok(claimed);
  const execution = composition.executionAdapter.consumeMockResult(claimed.lease);
  while (preflights < 2) await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(composition.runtimeAdapter.heartbeat(claimed.lease), /LEASE_STALE/);
  const surrendered = composition.runtimeAdapter.surrender(claimed.lease);
  secondPreflight.resolve(snapshot);
  await assert.rejects(execution, /DRAINING/);
  await surrendered;
  assert.equal(heartbeatCount, 0);
  assert.equal(surrenderCount, 1);
  await assert.rejects(composition.runtimeAdapter.heartbeat(claimed.lease), /LEASE_STALE/);
  await composition.runtimeAdapter.disconnect();
});

test('retry delays are deterministic and execution DB errors are minimized', () => {
  const input = { workerInstanceId: 'worker', workerBuildHash: 'a'.repeat(64), operation: 'COMPLETE' as const, failedAttempt: 1 };
  assert.equal(calculateAiMockExecutionRetryDelayMsV1(input), calculateAiMockExecutionRetryDelayMsV1(input));
  assert.notEqual(calculateAiMockExecutionRetryDelayMsV1(input), calculateAiMockExecutionRetryDelayMsV1({ ...input, failedAttempt: 2 }));
});

test('database transient, unavailable and invariant errors map to closed PR83 codes with surrender', async () => {
  for (const scenario of [
    { prismaCode: 'P2024', expected: 'AI_MOCK_EXECUTION_DB_TRANSIENT', attempts: 3 },
    { prismaCode: 'P1001', expected: 'AI_MOCK_EXECUTION_DB_UNAVAILABLE', attempts: 1 },
    { prismaCode: 'UNKNOWN', expected: 'AI_MOCK_EXECUTION_INVARIANT_VIOLATION', attempts: 1 },
  ] as const) {
    const { claim } = syntheticExecutionFixture();
    let attempts = 0;
    let surrenders = 0;
    const composition = createAiOrchestratorWorkerSyntheticTestingCompositionV1(
      { workerInstanceId: 'worker', workerBuildHash: 'a'.repeat(64), workerEnabled: '1' },
      async () => ({ allowed: true, capabilityAllowed: true }),
      {
        claim: async () => claim,
        preflight: async () => { attempts += 1; throw Object.assign(new Error('redacted'), { code: scenario.prismaCode }); },
        surrender: async () => { surrenders += 1; return { state: 'RETRY_WAIT', availableAt: new Date() }; },
        disconnect: async () => undefined,
      },
    );
    const claimed = await composition.runtimeAdapter.claim();
    assert.ok(claimed);
    await assert.rejects(composition.executionAdapter.consumeMockResult(claimed.lease), (error) => (
      error instanceof AiMockExecutionError && error.code === scenario.expected && error.message === scenario.expected
    ));
    assert.equal(attempts, scenario.attempts);
    assert.equal(surrenders, 1);
    await composition.runtimeAdapter.disconnect();
  }
});

test('persisted policy mismatch in either preflight terminalizes exactly once without surrender', async () => {
  for (const mismatchAt of [1, 2]) {
    const { claim, snapshot } = syntheticExecutionFixture();
    let preflights = 0; let failures = 0; let surrenders = 0; let completions = 0;
    const composition = createAiOrchestratorWorkerSyntheticTestingCompositionV1(
      { workerInstanceId: 'worker', workerBuildHash: 'a'.repeat(64), workerEnabled: '1' },
      async () => ({ allowed: true, capabilityAllowed: true }),
      {
        claim: async () => claim,
        preflight: async () => {
          preflights += 1;
          if (preflights === mismatchAt) throw new AiOrchestratorPersistedJobPolicyMismatchError();
          return snapshot;
        },
        fail: async (_lease, options) => {
          failures += 1; assert.equal(options.failureCode, 'POLICY_HASH_MISMATCH');
          return { state: 'FAILED_TERMINAL' };
        },
        complete: async () => { completions += 1; return { state: 'SUCCEEDED' }; },
        surrender: async () => { surrenders += 1; return { state: 'RETRY_WAIT', availableAt: new Date() }; },
        disconnect: async () => undefined,
      },
    );
    const leased = await composition.runtimeAdapter.claim(); assert.ok(leased);
    assert.deepEqual(await composition.executionAdapter.consumeMockResult(leased.lease), { state: 'FAILED_TERMINAL' });
    assert.equal(failures, 1); assert.equal(surrenders, 0); assert.equal(completions, 0);
    await assert.rejects(composition.executionAdapter.consumeMockResult(leased.lease), /LEASE_STALE/);
    await composition.runtimeAdapter.disconnect();
  }
});

test('persisted intent and runtime identities reject every closed policy mismatch family', async () => {
  const { snapshot } = syntheticExecutionFixture();
  for (const mutate of [
    (value: Record<string, unknown>) => { value.payloadHash = '0'.repeat(64); },
    (value: Record<string, unknown>) => { value.dedupeKey = '0'.repeat(64); },
    (value: Record<string, unknown>) => { value.catalogHash = '0'.repeat(64); },
    (value: Record<string, unknown>) => { value.executorAgentConfigHash = '0'.repeat(64); },
  ]) {
    const persisted = structuredClone(snapshot.intent) as unknown as Record<string, unknown>;
    mutate(persisted);
    assert.throws(() => parsePersistedFaiAuditJobIntent(persisted));
  }
  for (const changed of [
    { ...snapshot, runtimePolicyHash: '0'.repeat(64) },
    { ...snapshot, handlerVersion: '9.9' },
    { ...snapshot, capabilityHash: '0'.repeat(64) },
  ]) {
    let failures = 0;
    const outcome = await createAiMockExecutionOperationV1({
      readAuthority: async () => ({ allowed: true, capabilityAllowed: true }),
      preflight: async () => changed,
      assertClaimMatches: () => undefined,
      isDrainRequested: () => false,
      complete: async () => { throw new Error('must not complete'); },
      fail: async (code) => { failures += 1; assert.equal(code, 'POLICY_HASH_MISMATCH'); return { state: 'FAILED_TERMINAL' }; },
    })();
    assert.equal(outcome.state, 'FAILED_TERMINAL'); assert.equal(failures, 1);
  }
});

test('gate and capability denial surrender once while a genuinely stale lease never surrenders', async () => {
  for (const scenario of [
    { error: new AiOrchestratorExecutionGateDeniedError(), code: 'AI_MOCK_EXECUTION_AUTHORITY_DENIED', surrender: 1 },
    { error: new AiOrchestratorExecutionCapabilityDeniedError(), code: 'AI_MOCK_EXECUTION_CAPABILITY_DENIED', surrender: 1 },
    { error: new AiOrchestratorLeaseLostError(), code: null, surrender: 0 },
  ] as const) {
    const { claim } = syntheticExecutionFixture(); let surrenders = 0; let failures = 0;
    const composition = createAiOrchestratorWorkerSyntheticTestingCompositionV1(
      { workerInstanceId: 'worker', workerBuildHash: 'a'.repeat(64), workerEnabled: '1' },
      async () => ({ allowed: true, capabilityAllowed: true }),
      {
        claim: async () => claim, preflight: async () => { throw scenario.error; },
        fail: async () => { failures += 1; return { state: 'FAILED_TERMINAL' }; },
        surrender: async () => { surrenders += 1; return { state: 'RETRY_WAIT', availableAt: new Date() }; },
        disconnect: async () => undefined,
      },
    );
    const leased = await composition.runtimeAdapter.claim(); assert.ok(leased);
    await assert.rejects(composition.executionAdapter.consumeMockResult(leased.lease), (error) => (
      scenario.code ? error instanceof AiMockExecutionError && error.code === scenario.code : error instanceof AiOrchestratorLeaseLostError
    ));
    assert.equal(surrenders, scenario.surrender); assert.equal(failures, 0);
    await assert.rejects(composition.executionAdapter.consumeMockResult(leased.lease), /LEASE_STALE/);
    await composition.runtimeAdapter.disconnect();
  }
});

test('disconnect fences an in-flight claim, surrenders its runtime lease once and prevents later claims', async () => {
  const { claim } = syntheticExecutionFixture();
  const databaseClaim = deferred<ClaimedAiWorkflowJob | null>();
  let surrenders = 0; let disconnects = 0;
  const composition = createAiOrchestratorWorkerSyntheticTestingCompositionV1(
    { workerInstanceId: 'worker', workerBuildHash: 'a'.repeat(64), workerEnabled: '1' },
    async () => ({ allowed: true, capabilityAllowed: true }),
    {
      claim: async () => databaseClaim.promise,
      surrender: async () => { surrenders += 1; return { state: 'RETRY_WAIT', availableAt: new Date() }; },
      disconnect: async () => { disconnects += 1; },
    },
  );
  const pendingClaim = composition.runtimeAdapter.claim();
  const shutdown = composition.runtimeAdapter.disconnect();
  databaseClaim.resolve(claim);
  await assert.rejects(pendingClaim, /ADAPTER_CLOSED/);
  await shutdown;
  assert.equal(surrenders, 1); assert.equal(disconnects, 1);
  await assert.rejects(composition.runtimeAdapter.claim(), /ADAPTER_CLOSED/);
  assert.equal(surrenders, 1); assert.equal(disconnects, 1);
});

test('completion-time gate and capability denial surrender, while stale completion only closes the handle', async () => {
  for (const scenario of [
    { error: new AiOrchestratorExecutionGateDeniedError(), code: 'AI_MOCK_EXECUTION_AUTHORITY_DENIED', surrenders: 1 },
    { error: new AiOrchestratorExecutionCapabilityDeniedError(), code: 'AI_MOCK_EXECUTION_CAPABILITY_DENIED', surrenders: 1 },
    { error: new AiOrchestratorLeaseLostError(), code: null, surrenders: 0 },
  ] as const) {
    const { claim, snapshot } = syntheticExecutionFixture(); let completions = 0; let surrenders = 0;
    const composition = createAiOrchestratorWorkerSyntheticTestingCompositionV1(
      { workerInstanceId: 'worker', workerBuildHash: 'a'.repeat(64), workerEnabled: '1' },
      async () => ({ allowed: true, capabilityAllowed: true }),
      {
        claim: async () => claim, preflight: async () => snapshot,
        complete: async () => { completions += 1; throw scenario.error; },
        surrender: async () => { surrenders += 1; return { state: 'RETRY_WAIT', availableAt: new Date() }; },
        disconnect: async () => undefined,
      },
    );
    const leased = await composition.runtimeAdapter.claim(); assert.ok(leased);
    await assert.rejects(composition.executionAdapter.consumeMockResult(leased.lease), (error) => (
      scenario.code ? error instanceof AiMockExecutionError && error.code === scenario.code : error instanceof AiOrchestratorLeaseLostError
    ));
    assert.equal(completions, 1); assert.equal(surrenders, scenario.surrenders);
    await assert.rejects(composition.executionAdapter.consumeMockResult(leased.lease), /LEASE_STALE/);
    await composition.runtimeAdapter.disconnect();
  }
});

test('cleanup surrender retries transient failures and preserves a drained handle after exhausted or unavailable DB', async () => {
  for (const scenario of [
    { failures: ['P2024', 'P2024'] as const, expected: 'AI_MOCK_EXECUTION_AUTHORITY_DENIED', firstAttempts: 3 },
    { failures: ['P2024', 'P2024', 'P2024'] as const, expected: 'AI_MOCK_EXECUTION_DB_TRANSIENT', firstAttempts: 3 },
    { failures: ['P1001'] as const, expected: 'AI_MOCK_EXECUTION_DB_UNAVAILABLE', firstAttempts: 1 },
  ]) {
    const { claim } = syntheticExecutionFixture(); let attempts = 0;
    const composition = createAiOrchestratorWorkerSyntheticTestingCompositionV1(
      { workerInstanceId: 'worker', workerBuildHash: 'a'.repeat(64), workerEnabled: '1' },
      async () => ({ allowed: false, capabilityAllowed: false }),
      {
        claim: async () => claim,
        surrender: async () => {
          const code = scenario.failures[attempts]; attempts += 1;
          if (code) throw Object.assign(new Error('redacted'), { code });
          return { state: 'RETRY_WAIT', availableAt: new Date() };
        },
        disconnect: async () => undefined,
      },
    );
    const leased = await composition.runtimeAdapter.claim(); assert.ok(leased);
    await assert.rejects(composition.executionAdapter.consumeMockResult(leased.lease), (error) => (
      error instanceof AiMockExecutionError && error.code === scenario.expected
    ));
    assert.equal(attempts, scenario.firstAttempts);
    await assert.rejects(composition.executionAdapter.consumeMockResult(leased.lease), /LEASE_STALE/);
    await assert.rejects(composition.runtimeAdapter.heartbeat(leased.lease), /LEASE_STALE/);
    if (scenario.expected !== 'AI_MOCK_EXECUTION_AUTHORITY_DENIED') {
      await composition.runtimeAdapter.surrender(leased.lease);
      assert.equal(attempts, scenario.firstAttempts + 1);
      await assert.rejects(composition.runtimeAdapter.surrender(leased.lease), /LEASE_STALE/);
    }
    await composition.runtimeAdapter.disconnect();
  }
});

test('a stale cleanup surrender is idempotent and closes the drained handle', async () => {
  const { claim } = syntheticExecutionFixture(); let attempts = 0;
  const composition = createAiOrchestratorWorkerSyntheticTestingCompositionV1(
    { workerInstanceId: 'worker', workerBuildHash: 'a'.repeat(64), workerEnabled: '1' },
    async () => ({ allowed: false, capabilityAllowed: false }),
    {
      claim: async () => claim,
      surrender: async () => { attempts += 1; throw new AiOrchestratorLeaseLostError(); },
      disconnect: async () => undefined,
    },
  );
  const leased = await composition.runtimeAdapter.claim(); assert.ok(leased);
  await assert.rejects(composition.executionAdapter.consumeMockResult(leased.lease), /AUTHORITY_DENIED/);
  assert.equal(attempts, 1);
  await assert.rejects(composition.runtimeAdapter.surrender(leased.lease), /LEASE_STALE/);
  await composition.runtimeAdapter.disconnect();
});

test('both authority reads use deterministic bounded retry before handler or completion', async () => {
  for (const scenario of [
    { beforeSecond: false, code: 'P2024' },
    { beforeSecond: false, code: 'P2034' },
    { beforeSecond: true, code: 'P2024' },
    { beforeSecond: true, code: 'P2034' },
  ] as const) {
    const { claim, snapshot } = syntheticExecutionFixture();
    let authorityCalls = 0; let preflights = 0; let completions = 0; let injected = 0;
    const composition = createAiOrchestratorWorkerSyntheticTestingCompositionV1(
      { workerInstanceId: 'worker', workerBuildHash: 'a'.repeat(64), workerEnabled: '1' },
      async () => {
        authorityCalls += 1;
        const eligible = scenario.beforeSecond ? preflights === 1 : preflights === 0;
        if (eligible && injected < 2) { injected += 1; throw Object.assign(new Error('redacted'), { code: scenario.code }); }
        return { allowed: true, capabilityAllowed: true };
      },
      {
        claim: async () => claim,
        preflight: async () => { preflights += 1; return snapshot; },
        complete: async () => { completions += 1; return { state: 'SUCCEEDED', resultHash: 'b'.repeat(64) }; },
        disconnect: async () => undefined,
      },
    );
    const leased = await composition.runtimeAdapter.claim(); assert.ok(leased);
    assert.equal((await composition.executionAdapter.consumeMockResult(leased.lease)).state, 'SUCCEEDED');
    assert.equal(authorityCalls, 4); assert.equal(preflights, 2); assert.equal(completions, 1);
    await composition.runtimeAdapter.disconnect();
  }
});

test('authority database failures are minimized, stop the correct phase, and surrender once', async () => {
  for (const scenario of [
    { second: false, codes: ['P2024', 'P2024', 'P2024'], expected: 'AI_MOCK_EXECUTION_DB_TRANSIENT' },
    { second: true, codes: ['P2024', 'P2024', 'P2024'], expected: 'AI_MOCK_EXECUTION_DB_TRANSIENT' },
    { second: false, codes: ['P1001'], expected: 'AI_MOCK_EXECUTION_DB_UNAVAILABLE' },
    { second: true, codes: ['UNKNOWN'], expected: 'AI_MOCK_EXECUTION_INVARIANT_VIOLATION' },
  ] as const) {
    const { claim, snapshot } = syntheticExecutionFixture();
    let preflights = 0; let injected = 0; let completions = 0; let surrenders = 0;
    const composition = createAiOrchestratorWorkerSyntheticTestingCompositionV1(
      { workerInstanceId: 'worker', workerBuildHash: 'a'.repeat(64), workerEnabled: '1' },
      async () => {
        const target = scenario.second ? preflights === 1 : preflights === 0;
        const code = target ? scenario.codes[injected] : undefined;
        if (code) { injected += 1; throw Object.assign(new Error('sensitive database detail'), { code }); }
        return { allowed: true, capabilityAllowed: true };
      },
      {
        claim: async () => claim, preflight: async () => { preflights += 1; return snapshot; },
        complete: async () => { completions += 1; return { state: 'SUCCEEDED' }; },
        surrender: async () => { surrenders += 1; return { state: 'RETRY_WAIT', availableAt: new Date() }; },
        disconnect: async () => undefined,
      },
    );
    const leased = await composition.runtimeAdapter.claim(); assert.ok(leased);
    await assert.rejects(composition.executionAdapter.consumeMockResult(leased.lease), (error) => (
      error instanceof AiMockExecutionError && error.code === scenario.expected
      && error.message === scenario.expected && !error.message.includes('sensitive')
    ));
    assert.equal(preflights, scenario.second ? 1 : 0); assert.equal(completions, 0); assert.equal(surrenders, 1);
    await assert.rejects(composition.executionAdapter.consumeMockResult(leased.lease), /LEASE_STALE/);
    await composition.runtimeAdapter.disconnect();
  }
});

test('authority failure plus unavailable surrender preserves the drained handle for cleanup retry', async () => {
  const { claim } = syntheticExecutionFixture(); let surrenderCalls = 0;
  const composition = createAiOrchestratorWorkerSyntheticTestingCompositionV1(
    { workerInstanceId: 'worker', workerBuildHash: 'a'.repeat(64), workerEnabled: '1' },
    async () => { throw Object.assign(new Error('redacted'), { code: 'P1001' }); },
    {
      claim: async () => claim,
      surrender: async () => {
        surrenderCalls += 1;
        if (surrenderCalls === 1) throw Object.assign(new Error('redacted'), { code: 'P1001' });
        return { state: 'RETRY_WAIT', availableAt: new Date() };
      },
      disconnect: async () => undefined,
    },
  );
  const leased = await composition.runtimeAdapter.claim(); assert.ok(leased);
  await assert.rejects(composition.executionAdapter.consumeMockResult(leased.lease), /DB_UNAVAILABLE/);
  await assert.rejects(composition.executionAdapter.consumeMockResult(leased.lease), /LEASE_STALE/);
  await composition.runtimeAdapter.surrender(leased.lease);
  assert.equal(surrenderCalls, 2);
  await assert.rejects(composition.runtimeAdapter.surrender(leased.lease), /LEASE_STALE/);
  await composition.runtimeAdapter.disconnect();
});

test('disconnect drains one or multiple installed idle leases before Prisma disconnect', async () => {
  for (const leaseCount of [1, 2]) {
    const { claim } = syntheticExecutionFixture(); const calls: string[] = [];
    const composition = createAiOrchestratorWorkerSyntheticTestingCompositionV1(
      { workerInstanceId: 'worker', workerBuildHash: 'a'.repeat(64), workerEnabled: '1' },
      async () => ({ allowed: true, capabilityAllowed: true }),
      {
        claim: async () => ({ ...claim, runtimeId: `runtime-${calls.filter((value) => value === 'claim').length}`, lease: Object.freeze({}) as AiWorkflowJobLease }),
        surrender: async () => { calls.push('surrender'); return { state: 'RETRY_WAIT', availableAt: new Date() }; },
        disconnect: async () => { calls.push('disconnect'); },
      },
    );
    const handles = [];
    for (let index = 0; index < leaseCount; index += 1) { calls.push('claim'); handles.push(await composition.runtimeAdapter.claim()); }
    assert.ok(handles.every(Boolean));
    await composition.runtimeAdapter.disconnect();
    assert.equal(calls.filter((value) => value === 'surrender').length, leaseCount);
    assert.equal(calls.at(-1), 'disconnect');
    for (const leased of handles) if (leased) await assert.rejects(composition.runtimeAdapter.surrender(leased.lease), /LEASE_STALE/);
  }
});

test('disconnect waits for an existing heartbeat and then surrenders without deadlock', async () => {
  const { claim } = syntheticExecutionFixture(); const heartbeat = deferred<Date>(); const calls: string[] = [];
  const composition = createAiOrchestratorWorkerSyntheticTestingCompositionV1(
    { workerInstanceId: 'worker', workerBuildHash: 'a'.repeat(64), workerEnabled: '1' },
    async () => ({ allowed: true, capabilityAllowed: true }),
    {
      claim: async () => claim, heartbeat: async () => heartbeat.promise,
      surrender: async () => { calls.push('surrender'); return { state: 'RETRY_WAIT', availableAt: new Date() }; },
      disconnect: async () => { calls.push('disconnect'); },
    },
  );
  const leased = await composition.runtimeAdapter.claim(); assert.ok(leased);
  const beating = composition.runtimeAdapter.heartbeat(leased.lease);
  const shutdown = composition.runtimeAdapter.disconnect();
  await new Promise((resolve) => setImmediate(resolve)); assert.deepEqual(calls, []);
  heartbeat.resolve(new Date()); await beating; await shutdown;
  assert.deepEqual(calls, ['surrender', 'disconnect']);
});

test('disconnect waits for a completing execution and does not surrender a successful lease', async () => {
  const { claim, snapshot } = syntheticExecutionFixture(); const completion = deferred<{ state: 'SUCCEEDED'; resultHash: string }>();
  let completionCalls = 0; let surrenders = 0; let disconnects = 0;
  const composition = createAiOrchestratorWorkerSyntheticTestingCompositionV1(
    { workerInstanceId: 'worker', workerBuildHash: 'a'.repeat(64), workerEnabled: '1' },
    async () => ({ allowed: true, capabilityAllowed: true }),
    {
      claim: async () => claim, preflight: async () => snapshot,
      complete: async () => { completionCalls += 1; return completion.promise; },
      surrender: async () => { surrenders += 1; return { state: 'RETRY_WAIT', availableAt: new Date() }; },
      disconnect: async () => { disconnects += 1; },
    },
  );
  const leased = await composition.runtimeAdapter.claim(); assert.ok(leased);
  const execution = composition.executionAdapter.consumeMockResult(leased.lease);
  while (completionCalls === 0) await new Promise((resolve) => setImmediate(resolve));
  const shutdown = composition.runtimeAdapter.disconnect();
  completion.resolve({ state: 'SUCCEEDED', resultHash: 'b'.repeat(64) });
  assert.equal((await execution).state, 'SUCCEEDED'); await shutdown;
  assert.equal(surrenders, 0); assert.equal(disconnects, 1);
});

test('disconnect cleanup is retry-safe after transient or unavailable surrender failure', async () => {
  for (const codes of [['P2024', 'P2024', 'P2024'], ['P1001']] as const) {
    const { claim } = syntheticExecutionFixture(); let attempts = 0; let disconnects = 0;
    const composition = createAiOrchestratorWorkerSyntheticTestingCompositionV1(
      { workerInstanceId: 'worker', workerBuildHash: 'a'.repeat(64), workerEnabled: '1' },
      async () => ({ allowed: true, capabilityAllowed: true }),
      {
        claim: async () => claim,
        surrender: async () => {
          const code = codes[attempts]; attempts += 1;
          if (code) throw Object.assign(new Error('redacted'), { code });
          return { state: 'RETRY_WAIT', availableAt: new Date() };
        },
        disconnect: async () => { disconnects += 1; },
      },
    );
    const leased = await composition.runtimeAdapter.claim(); assert.ok(leased);
    await assert.rejects(composition.runtimeAdapter.disconnect(), codes[0] === 'P1001' ? /DB_UNAVAILABLE/ : /DB_TRANSIENT/);
    assert.equal(disconnects, 0);
    await composition.runtimeAdapter.disconnect();
    assert.equal(disconnects, 1); assert.equal(attempts, codes.length + 1);
    await assert.rejects(composition.runtimeAdapter.surrender(leased.lease), /LEASE_STALE/);
  }
});

test('multi-handle disconnect drains every snapshot entry and retries only failed cleanups', async () => {
  for (const scenario of ['TRANSIENT_FIRST', 'UNAVAILABLE_AND_STALE', 'MIXED_PRIORITY'] as const) {
    const base = syntheticExecutionFixture().claim;
    const runtimeLeases = Array.from({ length: 3 }, () => Object.freeze({}) as AiWorkflowJobLease);
    let claimIndex = 0; const attempts = [0, 0, 0]; let disconnects = 0;
    const composition = createAiOrchestratorWorkerSyntheticTestingCompositionV1(
      { workerInstanceId: 'worker', workerBuildHash: 'a'.repeat(64), workerEnabled: '1' },
      async () => ({ allowed: true, capabilityAllowed: true }),
      {
        claim: async () => {
          const index = claimIndex; claimIndex += 1;
          return { ...base, runtimeId: `runtime-${index}`, lease: runtimeLeases[index] };
        },
        surrender: async (lease) => {
          const index = runtimeLeases.indexOf(lease); attempts[index] += 1;
          if (scenario === 'TRANSIENT_FIRST' && index === 0 && attempts[index] <= 3) {
            throw Object.assign(new Error('private'), { code: 'P2024' });
          }
          if (scenario === 'UNAVAILABLE_AND_STALE' && index === 0 && attempts[index] === 1) {
            throw Object.assign(new Error('private'), { code: 'P1001' });
          }
          if (scenario === 'UNAVAILABLE_AND_STALE' && index === 2) throw new AiOrchestratorLeaseLostError();
          if (scenario === 'MIXED_PRIORITY' && index === 0 && attempts[index] <= 3) {
            throw Object.assign(new Error('private'), { code: 'P2024' });
          }
          if (scenario === 'MIXED_PRIORITY' && index === 1 && attempts[index] === 1) {
            throw Object.assign(new Error('private'), { code: 'P1001' });
          }
          return { state: 'RETRY_WAIT', availableAt: new Date() };
        },
        disconnect: async () => { disconnects += 1; },
      },
    );
    const handles = await Promise.all(Array.from({ length: 3 }, () => composition.runtimeAdapter.claim()));
    assert.ok(handles.every(Boolean));
    const expected = scenario === 'TRANSIENT_FIRST' ? 'DB_TRANSIENT' : 'DB_UNAVAILABLE';
    await assert.rejects(composition.runtimeAdapter.disconnect(), new RegExp(expected));
    assert.equal(disconnects, 0);
    assert.ok(attempts[1] >= 1); assert.ok(attempts[2] >= 1);
    const firstPassAttempts = [...attempts];
    await composition.runtimeAdapter.disconnect();
    assert.equal(disconnects, 1);
    assert.equal(attempts[2], firstPassAttempts[2]);
    if (scenario === 'TRANSIENT_FIRST') assert.deepEqual(attempts, [4, 1, 1]);
    if (scenario === 'UNAVAILABLE_AND_STALE') assert.deepEqual(attempts, [2, 1, 1]);
    if (scenario === 'MIXED_PRIORITY') assert.deepEqual(attempts, [4, 2, 1]);
  }
});

test('crossing claims collect every error, preserve priority, and defer all retries to the next disconnect', async () => {
  for (const reverseCompletion of [false, true]) {
    const base = syntheticExecutionFixture().claim;
    const claimDeferred = [deferred<ClaimedAiWorkflowJob | null>(), deferred<ClaimedAiWorkflowJob | null>()];
    const leases = [Object.freeze({}) as AiWorkflowJobLease, Object.freeze({}) as AiWorkflowJobLease];
    let claimCall = 0; const surrenderCalls = [0, 0]; let prismaDisconnects = 0;
    const composition = createAiOrchestratorWorkerSyntheticTestingCompositionV1(
      { workerInstanceId: 'worker', workerBuildHash: 'a'.repeat(64), workerEnabled: '1' },
      async () => ({ allowed: true, capabilityAllowed: true }),
      {
        claim: async () => claimDeferred[claimCall++].promise,
        surrender: async (lease) => {
          const index = leases.indexOf(lease); surrenderCalls[index] += 1;
          if (index === 0 && surrenderCalls[index] === 1) throw Object.assign(new Error('private P1001 detail'), { code: 'P1001' });
          if (index === 1 && surrenderCalls[index] <= 3) throw Object.assign(new Error('private P2024 detail'), { code: 'P2024' });
          return { state: 'RETRY_WAIT', availableAt: new Date() };
        },
        disconnect: async () => { prismaDisconnects += 1; },
      },
    );
    const claims = [composition.runtimeAdapter.claim(), composition.runtimeAdapter.claim()];
    const firstDisconnect = composition.runtimeAdapter.disconnect();
    const concurrentDisconnect = composition.runtimeAdapter.disconnect();
    const claimAssertions = [assert.rejects(claims[0], /DB_UNAVAILABLE/), assert.rejects(claims[1], /DB_TRANSIENT/)];
    const disconnectAssertions = [
      assert.rejects(firstDisconnect, (error) => error instanceof AiMockExecutionError
        && error.code === 'AI_MOCK_EXECUTION_DB_UNAVAILABLE' && !error.message.includes('private')),
      assert.rejects(concurrentDisconnect, /DB_UNAVAILABLE/),
    ];
    const resolveClaim = (index: number) => claimDeferred[index].resolve({ ...base, runtimeId: `crossing-${index}`, lease: leases[index] });
    if (reverseCompletion) { resolveClaim(1); await new Promise((resolve) => setImmediate(resolve)); resolveClaim(0); }
    else { resolveClaim(0); await new Promise((resolve) => setImmediate(resolve)); resolveClaim(1); }
    await Promise.all([...claimAssertions, ...disconnectAssertions]);
    assert.deepEqual(surrenderCalls, [1, 3]);
    assert.equal(prismaDisconnects, 0);
    await assert.rejects(composition.runtimeAdapter.claim(), /ADAPTER_CLOSED/);
    await composition.runtimeAdapter.disconnect();
    assert.deepEqual(surrenderCalls, [2, 4]);
    assert.equal(prismaDisconnects, 1);
  }
});
