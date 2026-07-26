import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { AiMockExecutionError, createAiMockExecutionOperationV1 } from '../src/lib/ai-orchestrator/mock-execution-result-wiring-v1';

const root = resolve(import.meta.dirname, '..');
const facadeSource = readFileSync(resolve(root, 'src/lib/ai-orchestrator/mock-execution-result-wiring-v1.ts'), 'utf8');
const adapterSource = readFileSync(resolve(root, 'src/lib/ai-orchestrator/worker-runtime-adapter-v1.ts'), 'utf8');
const productionSource = readFileSync(resolve(root, 'src/lib/ai-orchestrator/worker-admission-claim-lease-process-v1.ts'), 'utf8');

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
    assert.match(adapterSource, new RegExp(`\\b${field}\\b`));
  }
});
