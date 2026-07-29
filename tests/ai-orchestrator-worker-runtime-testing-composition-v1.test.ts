import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  AI_ORCHESTRATOR_WORKER_RUNTIME_ADAPTER_RETRY_LIMITS,
  AiOrchestratorWorkerRuntimeAdapterError,
  mapAiOrchestratorWorkerRuntimeAdapterDatabaseErrorV1,
} from '../src/lib/ai-orchestrator/worker-runtime-adapter-v1';
import {
  calculateAiOrchestratorSyntheticTestingRuntimeRetryDelayMsV1,
  createAiOrchestratorWorkerSyntheticTestingCompositionV1,
  type AiOrchestratorTestingRuntimePortsV1,
} from '../src/lib/ai-orchestrator/worker-runtime-testing-composition-v1';

const identity = {
  workerInstanceId: '12345678-1234-4123-8123-123456789abc',
  workerBuildHash: 'b'.repeat(64),
  workerEnabled: '1',
} as const;

type Operation = 'readAuthority' | 'recover' | 'supersede' | 'admit';
const operations: readonly Operation[] = ['readAuthority', 'recover', 'supersede', 'admit'];
const successValue = (operation: Operation) => operation === 'readAuthority'
  ? Object.freeze({ allowed: true, capabilityAllowed: true, workerEnabled: true } as never)
  : 7;

function compositionFor(
  operation: Operation,
  implementation: () => Promise<unknown>,
  disconnect = async () => undefined,
  workerInstanceId: string = identity.workerInstanceId,
  workerBuildHash: string = identity.workerBuildHash,
) {
  return createAiOrchestratorWorkerSyntheticTestingCompositionV1(
    { ...identity, workerInstanceId, workerBuildHash },
    async () => ({ allowed: true, capabilityAllowed: true }),
    { [operation]: implementation, disconnect } as Partial<AiOrchestratorTestingRuntimePortsV1>,
  );
}

function expectedResult(operation: Operation) {
  if (operation === 'readAuthority') return successValue(operation);
  if (operation === 'recover') return Object.freeze({ recovered: 7 });
  if (operation === 'supersede') return Object.freeze({ superseded: 7 });
  return Object.freeze({ admitted: 7 });
}

async function invoke(composition: ReturnType<typeof compositionFor>, operation: Operation) {
  return composition.runtimeAdapter[operation]();
}

function prisma(code: string) {
  return Object.assign(new Error(`SECRET prisma query host=db.internal:5432 code=${code}`), {
    code,
    clientVersion: 'secret-version',
  });
}

test('le quattro operazioni runtime applicano retry canonico P2024/P2034 e tre tentativi massimi', async () => {
  for (const operation of operations) {
    for (const sequence of [
      ['P2024', 'P2024'],
      ['P2034', 'P2034'],
      ['P2024', 'P2034'],
      ['P2034', 'P2024'],
    ]) {
      let calls = 0;
      const composition = compositionFor(operation, async () => {
        const code = sequence[calls++];
        if (code) throw prisma(code);
        return successValue(operation);
      });
      await invoke(composition, operation);
      assert.equal(calls, 3, `${operation}: ${sequence.join('/')}`);
      await composition.runtimeAdapter.disconnect();
    }

    let exhaustedCalls = 0;
    const exhausted = compositionFor(operation, async () => {
      exhaustedCalls += 1;
      throw prisma('P2024');
    });
    await assert.rejects(invoke(exhausted, operation), (error: unknown) => (
      error instanceof AiOrchestratorWorkerRuntimeAdapterError
      && error.code === 'AI_WORKER_RUNTIME_ADAPTER_DB_TRANSIENT'
    ));
    assert.equal(exhaustedCalls, 3, operation);
    await exhausted.runtimeAdapter.disconnect();
  }
});

test('synthetic worker identities preserve transient retry semantics', async () => {
  for (const operation of operations) {
    let calls = 0;
    const composition = compositionFor(operation, async () => {
      calls += 1;
      if (calls < 3) throw prisma('P2024');
      return successValue(operation);
    }, undefined, 'worker');
    assert.deepEqual(await invoke(composition, operation), expectedResult(operation));
    assert.equal(calls, 3);
    await composition.runtimeAdapter.disconnect();

    let exhaustedCalls = 0;
    const exhausted = compositionFor(operation, async () => {
      exhaustedCalls += 1;
      throw prisma('P2024');
    }, undefined, 'worker');
    await assert.rejects(invoke(exhausted, operation), (error: unknown) => (
      error instanceof AiOrchestratorWorkerRuntimeAdapterError
      && error.code === 'AI_WORKER_RUNTIME_ADAPTER_DB_TRANSIENT'
      && !error.message.includes('RETRY_INPUT_INVALID')
    ));
    assert.equal(exhaustedCalls, 3);
    await exhausted.runtimeAdapter.disconnect();
  }
});

test('helper retry test-only accetta ID sintetici bounded e conserva i parametri canonici', () => {
  const workerInstanceId = 'synthetic-worker-'.padEnd(128, 'x');
  const common = {
    workerInstanceId,
    workerBuildHash: identity.workerBuildHash,
    operation: 'READ_AUTHORITY' as const,
  };
  for (const failedAttempt of [1, 2] as const) {
    const delay = calculateAiOrchestratorSyntheticTestingRuntimeRetryDelayMsV1({ ...common, failedAttempt });
    const repeated = calculateAiOrchestratorSyntheticTestingRuntimeRetryDelayMsV1({ ...common, failedAttempt });
    const exponential = AI_ORCHESTRATOR_WORKER_RUNTIME_ADAPTER_RETRY_LIMITS.baseDelayMs
      * (2 ** (failedAttempt - 1));
    assert.equal(delay, repeated);
    assert.ok(delay >= exponential);
    assert.ok(delay <= exponential + AI_ORCHESTRATOR_WORKER_RUNTIME_ADAPTER_RETRY_LIMITS.maxJitterMs);
  }
  const authorityDelay = calculateAiOrchestratorSyntheticTestingRuntimeRetryDelayMsV1({ ...common, failedAttempt: 1 });
  const admitDelay = calculateAiOrchestratorSyntheticTestingRuntimeRetryDelayMsV1({
    ...common, operation: 'ADMIT', failedAttempt: 1,
  });
  assert.notEqual(authorityDelay, admitDelay, 'operation code must separate retry entropy');
  for (const failedAttempt of [0, 3]) assert.throws(
    () => calculateAiOrchestratorSyntheticTestingRuntimeRetryDelayMsV1({ ...common, failedAttempt }),
    (error: unknown) => error instanceof AiOrchestratorWorkerRuntimeAdapterError
      && error.code === 'AI_WORKER_RUNTIME_ADAPTER_CONFIG_INVALID',
  );
});

test('helper retry test-only chiude ogni identità e parametro runtime non type-safe', () => {
  const valid = {
    workerInstanceId: 'worker',
    workerBuildHash: identity.workerBuildHash,
    operation: 'READ_AUTHORITY',
    failedAttempt: 1,
  };
  const invalidCases: ReadonlyArray<Readonly<Record<string, unknown>>> = [
    { workerInstanceId: undefined },
    { workerInstanceId: null },
    { workerInstanceId: 42 },
    { workerInstanceId: {} },
    { workerInstanceId: [] },
    { workerInstanceId: '' },
    { workerInstanceId: 'x'.repeat(129) },
    { workerBuildHash: undefined },
    { workerBuildHash: null },
    { workerBuildHash: 42 },
    { workerBuildHash: 'not-a-sha256' },
    { operation: undefined },
    { operation: 'UNKNOWN' },
    { failedAttempt: undefined },
    { failedAttempt: Number.NaN },
    { failedAttempt: 1.5 },
    { failedAttempt: 0 },
    { failedAttempt: 3 },
  ];
  let runtimeCalls = 0;
  for (const invalid of invalidCases) {
    assert.throws(
      () => calculateAiOrchestratorSyntheticTestingRuntimeRetryDelayMsV1({
        ...valid,
        ...invalid,
      } as Parameters<typeof calculateAiOrchestratorSyntheticTestingRuntimeRetryDelayMsV1>[0]),
      (error: unknown) => (
        error instanceof AiOrchestratorWorkerRuntimeAdapterError
        && !(error instanceof TypeError)
        && error.code === 'AI_WORKER_RUNTIME_ADAPTER_CONFIG_INVALID'
        && error.message === 'AI_WORKER_RUNTIME_ADAPTER_CONFIG_INVALID'
        && !error.message.includes('RETRY_INPUT_INVALID')
      ),
    );
  }
  assert.equal(runtimeCalls, 0);
});

test('P2024 con workerInstanceId non-stringa fallisce chiuso senza retry e consente disconnect', async () => {
  let runtimeCalls = 0; let disconnectCalls = 0;
  const composition = createAiOrchestratorWorkerSyntheticTestingCompositionV1(
    {
      ...identity,
      workerInstanceId: 42 as unknown as string,
    },
    async () => ({ allowed: true, capabilityAllowed: true }),
    {
      admit: async () => { runtimeCalls += 1; throw prisma('P2024'); },
      disconnect: async () => { disconnectCalls += 1; },
    },
  );
  await assert.rejects(composition.runtimeAdapter.admit(), (error: unknown) => (
    error instanceof AiOrchestratorWorkerRuntimeAdapterError
    && !(error instanceof TypeError)
    && error.code === 'AI_WORKER_RUNTIME_ADAPTER_CONFIG_INVALID'
    && error.message === 'AI_WORKER_RUNTIME_ADAPTER_CONFIG_INVALID'
    && !error.message.includes('RETRY_INPUT_INVALID')
  ));
  assert.equal(runtimeCalls, 1);
  await composition.runtimeAdapter.disconnect();
  assert.equal(disconnectCalls, 1);
  assert.equal(runtimeCalls, 1);
});

test('identità PR83 sintetica ritenta P2034 senza errore di validazione', async () => {
  let calls = 0;
  const composition = compositionFor('recover', async () => {
    calls += 1;
    if (calls === 1) throw prisma('P2034');
    return 7;
  }, undefined, `pr83-runtime-${randomUUID()}`);
  assert.deepEqual(await composition.runtimeAdapter.recover(), { recovered: 7 });
  assert.equal(calls, 2);
  await composition.runtimeAdapter.disconnect();
});

test('workerBuildHash invalido fallisce chiuso prima del retry senza raw input error', async () => {
  let calls = 0;
  const composition = compositionFor('admit', async () => {
    calls += 1;
    throw prisma('P2024');
  }, undefined, 'worker', 'invalid-build-hash');
  await assert.rejects(composition.runtimeAdapter.admit(), (error: unknown) => (
    error instanceof AiOrchestratorWorkerRuntimeAdapterError
    && error.code === 'AI_WORKER_RUNTIME_ADAPTER_CONFIG_INVALID'
    && error.message === error.code
  ));
  assert.equal(calls, 1);
  await composition.runtimeAdapter.disconnect();
});

test('le quattro operazioni mappano indisponibilità, TypeError, errori opachi e AdapterError senza retry', async () => {
  const cases = [
    ...['P1001', 'P1002', 'P1008', 'P1017'].map((code) => ({
      expected: 'AI_WORKER_RUNTIME_ADAPTER_DB_UNAVAILABLE' as const,
      error: prisma(code),
    })),
    { expected: 'AI_WORKER_RUNTIME_ADAPTER_CONFIG_INVALID' as const, error: new TypeError('SECRET config') },
    { expected: 'AI_WORKER_RUNTIME_ADAPTER_INVARIANT_VIOLATION' as const, error: new Error('SECRET unknown') },
    {
      expected: 'AI_WORKER_RUNTIME_ADAPTER_CLOSED' as const,
      error: new AiOrchestratorWorkerRuntimeAdapterError('AI_WORKER_RUNTIME_ADAPTER_CLOSED'),
    },
  ];
  for (const operation of operations) for (const scenario of cases) {
    let calls = 0;
    const composition = compositionFor(operation, async () => { calls += 1; throw scenario.error; });
    await assert.rejects(invoke(composition, operation), (error: unknown) => (
      error instanceof AiOrchestratorWorkerRuntimeAdapterError
      && error.code === scenario.expected
      && error.message === scenario.expected
      && !error.message.includes('SECRET')
      && error.cause === undefined
    ));
    assert.equal(calls, 1, `${operation}: ${scenario.expected}`);
    await composition.runtimeAdapter.disconnect();
  }
});

test('composizione test-only e mapper usato dal production adapter hanno codici chiusi equivalenti', async () => {
  for (const raw of [
    prisma('P1001'), prisma('P1002'), prisma('P1008'), prisma('P1017'),
    new TypeError('SECRET type'), new Error('SECRET unknown'),
  ]) {
    const expected = mapAiOrchestratorWorkerRuntimeAdapterDatabaseErrorV1(raw).code;
    const composition = compositionFor('admit', async () => { throw raw; });
    await assert.rejects(composition.runtimeAdapter.admit(), (error: unknown) => (
      error instanceof AiOrchestratorWorkerRuntimeAdapterError && error.code === expected
    ));
    await composition.runtimeAdapter.disconnect();
  }
  for (const code of ['P2024', 'P2034']) {
    const raw = prisma(code);
    const expected = mapAiOrchestratorWorkerRuntimeAdapterDatabaseErrorV1(raw).code;
    let calls = 0;
    const composition = compositionFor('recover', async () => { calls += 1; throw raw; });
    await assert.rejects(composition.runtimeAdapter.recover(), (error: unknown) => (
      error instanceof AiOrchestratorWorkerRuntimeAdapterError && error.code === expected
    ));
    assert.equal(calls, 3);
    await composition.runtimeAdapter.disconnect();
  }
});

test('disconnect durante backoff chiude senza retry o riconnessione', async () => {
  let calls = 0; let disconnects = 0;
  const composition = compositionFor('admit', async () => { calls += 1; throw prisma('P2024'); }, async () => { disconnects += 1; }, 'worker');
  const operation = composition.runtimeAdapter.admit();
  await new Promise((resolve) => setImmediate(resolve));
  await composition.runtimeAdapter.disconnect();
  await assert.rejects(operation, /AI_WORKER_RUNTIME_ADAPTER_CLOSED/);
  assert.equal(calls, 1); assert.equal(disconnects, 1);
  await assert.rejects(composition.runtimeAdapter.admit(), /AI_WORKER_RUNTIME_ADAPTER_CLOSED/);
  assert.equal(calls, 1); assert.equal(disconnects, 1);
});

test('disconnect reentrant nel backoff non attende se stesso ma attende le altre operazioni', async () => {
  let composition!: ReturnType<typeof compositionFor>;
  let disconnects = 0; let recoverCalls = 0; let releaseOther!: () => void;
  const other = new Promise<void>((resolve) => { releaseOther = resolve; });
  composition = createAiOrchestratorWorkerSyntheticTestingCompositionV1(
    { ...identity, workerInstanceId: 'worker' },
    async () => ({ allowed: true, capabilityAllowed: true }),
    {
      recover: async () => {
        recoverCalls += 1;
        setTimeout(() => { void composition.runtimeAdapter.disconnect(); }, 1);
        throw prisma('P2034');
      },
      supersede: async () => { await other; return 0; },
      disconnect: async () => { disconnects += 1; },
    },
  );
  const pendingOther = composition.runtimeAdapter.supersede();
  const reentrant = composition.runtimeAdapter.recover();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(disconnects, 0);
  releaseOther();
  await pendingOther;
  await assert.rejects(reentrant, /AI_WORKER_RUNTIME_ADAPTER_CLOSED/);
  await composition.runtimeAdapter.disconnect();
  assert.equal(recoverCalls, 1); assert.equal(disconnects, 1);
});

test('operazioni concorrenti mantengono operation code, retry e tracking indipendenti', async () => {
  const calls = new Map<Operation, number>();
  const overrides = Object.fromEntries(operations.map((operation) => [operation, async () => {
    const count = (calls.get(operation) ?? 0) + 1; calls.set(operation, count);
    if (count < 3) throw prisma(count === 1 ? 'P2024' : 'P2034');
    return successValue(operation);
  }])) as Partial<AiOrchestratorTestingRuntimePortsV1>;
  let disconnects = 0;
  const composition = createAiOrchestratorWorkerSyntheticTestingCompositionV1(
    identity, async () => ({ allowed: true, capabilityAllowed: true }),
    { ...overrides, disconnect: async () => { disconnects += 1; } },
  );
  await Promise.all(operations.map((operation) => invoke(composition, operation)));
  assert.deepEqual(Object.fromEntries(calls), Object.fromEntries(operations.map((operation) => [operation, 3])));
  await composition.runtimeAdapter.disconnect();
  assert.equal(disconnects, 1);
});
