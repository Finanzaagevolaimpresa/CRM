import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { AiMockExecutionError, createAiMockExecutionOperationV1 } from '../src/lib/ai-orchestrator/mock-execution-result-wiring-v1';
import { createFaiAuditJobPlan } from '../src/lib/ai-orchestrator/job-planner';
import { FAI_AUDIT_WORKFLOW_DEFINITION_HASH, FAI_AUDIT_WORKFLOW_ID, FAI_AUDIT_WORKFLOW_VERSION } from '../src/lib/ai-orchestrator/audit-workflow-v1-1';
import { getFaiAuditExecutorBinding } from '../src/lib/ai-orchestrator/job-catalog-v1';
import { AI_ORCHESTRATOR_WORKER_CAPABILITY_HASHES, AI_ORCHESTRATOR_WORKER_RUNTIME_POLICY_CODE, AI_ORCHESTRATOR_WORKER_RUNTIME_POLICY_HASH, AI_ORCHESTRATOR_WORKER_RUNTIME_POLICY_VERSION, getAiOrchestratorWorkerCapability } from '../src/lib/ai-orchestrator/worker-runtime-policy-v1';

const root = resolve(import.meta.dirname, '..');
const facadeSource = readFileSync(resolve(root, 'src/lib/ai-orchestrator/mock-execution-result-wiring-v1.ts'), 'utf8');
const adapterSource = readFileSync(resolve(root, 'src/lib/ai-orchestrator/worker-runtime-adapter-v1.ts'), 'utf8');
const productionSource = readFileSync(resolve(root, 'src/lib/ai-orchestrator/worker-admission-claim-lease-process-v1.ts'), 'utf8');
const entrypointSource = readFileSync(resolve(root, 'scripts/ai-orchestrator-worker.ts'), 'utf8');
const testingSource = readFileSync(resolve(root, 'src/lib/ai-orchestrator/worker-runtime-testing-composition-v1.ts'), 'utf8');

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
