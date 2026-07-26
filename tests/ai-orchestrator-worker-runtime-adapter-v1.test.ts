import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  AI_ORCHESTRATOR_WORKER_RUNTIME_ADAPTER_ERROR_CODES,
  AI_ORCHESTRATOR_WORKER_RUNTIME_ADAPTER_RETRY_LIMITS,
  AI_ORCHESTRATOR_WORKER_RUNTIME_ADAPTER_VERSION,
  AiOrchestratorWorkerRuntimeAdapterError,
  calculateAiOrchestratorWorkerRuntimeAdapterRetryDelayMsV1,
  createAiOrchestratorWorkerRuntimeAdapterV1,
} from '../src/lib/ai-orchestrator/worker-runtime-adapter-v1';

const root = resolve(import.meta.dirname, '..');
const source = readFileSync(resolve(
  root,
  'src/lib/ai-orchestrator/worker-runtime-adapter-v1.ts',
), 'utf8');

const validIdentity = {
  workerInstanceId: '12345678-1234-4123-8123-123456789abc',
  workerBuildHash: 'a'.repeat(64),
} as const;

test('adapter v1 fallisce prima degli import runtime con gate chiuso o identità non canonica', async () => {
  await assert.rejects(
    createAiOrchestratorWorkerRuntimeAdapterV1({
      ...validIdentity,
      workerEnabled: '0',
    }),
    (error: unknown) => (
      error instanceof AiOrchestratorWorkerRuntimeAdapterError
      && error.code === 'AI_WORKER_RUNTIME_ADAPTER_GATE_DENIED'
      && error.message === error.code
    ),
  );
  await assert.rejects(
    createAiOrchestratorWorkerRuntimeAdapterV1({
      workerInstanceId: 'worker-from-environment',
      workerBuildHash: validIdentity.workerBuildHash,
      workerEnabled: '0',
    }),
    (error: unknown) => (
      error instanceof AiOrchestratorWorkerRuntimeAdapterError
      && error.code === 'AI_WORKER_RUNTIME_ADAPTER_CONFIG_INVALID'
    ),
  );
});

test('error taxonomy adapter è chiusa, univoca e priva di messaggi grezzi', () => {
  assert.equal(AI_ORCHESTRATOR_WORKER_RUNTIME_ADAPTER_VERSION, '1.0');
  assert.equal(
    new Set(AI_ORCHESTRATOR_WORKER_RUNTIME_ADAPTER_ERROR_CODES).size,
    AI_ORCHESTRATOR_WORKER_RUNTIME_ADAPTER_ERROR_CODES.length,
  );
  for (const code of AI_ORCHESTRATOR_WORKER_RUNTIME_ADAPTER_ERROR_CODES) {
    const error = new AiOrchestratorWorkerRuntimeAdapterError(code);
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    assert.equal(error.cause, undefined);
  }
});

test('retry DB transient è deterministico, jittered e limitato a tre tentativi', () => {
  assert.deepEqual(AI_ORCHESTRATOR_WORKER_RUNTIME_ADAPTER_RETRY_LIMITS, {
    maxAttempts: 3,
    baseDelayMs: 25,
    maxJitterMs: 25,
  });
  for (const failedAttempt of [1, 2]) {
    const input = {
      ...validIdentity,
      operation: 'CLAIM' as const,
      failedAttempt,
    };
    const first = calculateAiOrchestratorWorkerRuntimeAdapterRetryDelayMsV1(input);
    const second = calculateAiOrchestratorWorkerRuntimeAdapterRetryDelayMsV1(input);
    const base = 25 * (2 ** (failedAttempt - 1));
    assert.equal(first, second);
    assert.ok(first >= base);
    assert.ok(first <= base + 25);
  }
  for (const failedAttempt of [0, 3, Number.MAX_SAFE_INTEGER]) {
    assert.throws(
      () => calculateAiOrchestratorWorkerRuntimeAdapterRetryDelayMsV1({
        ...validIdentity,
        operation: 'CLAIM',
        failedAttempt,
      }),
      /AI_WORKER_RUNTIME_ADAPTER_RETRY_INPUT_INVALID/,
    );
  }
  assert.match(source, /AI_WORKER_RUNTIME_ADAPTER_DB_TRANSIENT/);
  assert.match(source, /attempt >= AI_ORCHESTRATOR_WORKER_RUNTIME_ADAPTER_RETRY_LIMITS\.maxAttempts/);
});

test('facade espone solo authority, sei primitive ristrette e disconnect', () => {
  const api = source.match(
    /export interface AiOrchestratorWorkerRuntimeAdapterV1 \{([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(api);
  for (const method of [
    'readAuthority',
    'recover',
    'supersede',
    'admit',
    'claim',
    'heartbeat',
    'surrender',
    'disconnect',
  ]) assert.match(api, new RegExp(`\\b${method}\\b`));
  assert.doesNotMatch(api, /complete|fail|result|artifact|handler|payload/i);
  assert.doesNotMatch(source, /completeAiWorkflowJob|failAiWorkflowJob/);
  assert.doesNotMatch(source, /result-artifact-contract|mock-handler-registry|workflow-service/);
});

test('runtime, Prisma e authority vengono caricati solo dinamicamente dopo il gate esatto', () => {
  assert.match(source, /workerEnabled \?\? process\.env\.AI_ORCHESTRATOR_WORKER_ENABLED/);
  assert.match(source, /!== '1'/);
  assert.match(source, /import\('\.\/worker-runtime'\)/);
  assert.match(source, /import\('\.\.\/prisma'\)/);
  assert.match(source, /import\('\.\/worker-control-plane-authority-v1'\)/);
  assert.doesNotMatch(source, /^import \{[^;]*\} from ['"]\.\/worker-runtime['"]/m);
  assert.doesNotMatch(source, /^import \{[^;]*\} from ['"]\.\.\/prisma['"]/m);
});

test('claim adapter espone soltanto una seconda lease opaca', () => {
  const claimType = source.match(
    /export interface AiOrchestratorWorkerRuntimeClaimV1 \{([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(claimType);
  assert.match(claimType, /lease:/);
  assert.doesNotMatch(
    claimType,
    /runtimeId|attemptSequence|fencingToken|leaseExpiresAt|payload|handler|executor|capability|workflow|jobCode|jobPayloadHash/i,
  );
  assert.match(source, /new WeakMap<object, LeaseEntry>/);
  assert.match(source, /Object\.freeze\(Object\.create\(null\)\)/);
  assert.match(source, /runtimeLease: claimed\.lease/);
  assert.doesNotMatch(source, /leases\.set\([^;]*claimed\)/);
});

test('surrender è single-flight e resta disponibile dopo un heartbeat negato', () => {
  const surrender = source.match(
    /surrender: async \(lease\) => \{([\s\S]*?)\n    \},\n\n    disconnect:/,
  )?.[1];
  assert.ok(surrender);
  assert.match(surrender, /if \(entry\.surrenderPromise\) return entry\.surrenderPromise/);
  assert.match(surrender, /await entry\.heartbeatPromise/);
  assert.match(surrender, /catch \{\s*\/\/ A gate denial must not prevent/s);
  assert.match(surrender, /leases\.delete\(lease\)/);
  assert.doesNotMatch(surrender, /admitAiWorkflowJobOutbox|claimNextAiWorkflowJob/);
});
