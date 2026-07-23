import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  AI_ORCHESTRATOR_WORKER_WIRING_ACTIVATION_EPOCH,
  AI_ORCHESTRATOR_WORKER_WIRING_BUILD_HASH,
  AI_ORCHESTRATOR_WORKER_WIRING_LIMITS,
  AI_ORCHESTRATOR_WORKER_WIRING_PROCESS_MANIFEST,
  AI_ORCHESTRATOR_WORKER_WIRING_PRODUCTION_CAN_ACCEPT_LEASE,
  AiOrchestratorWorkerWiringError,
  createAiOrchestratorWorkerAdmissionClaimLeaseWiringV1,
  createAiOrchestratorWorkerWiringBuildHashV1,
  getAiOrchestratorWorkerWiringInvariantErrorsV1,
  parseAiOrchestratorWorkerWiringEnvironmentV1,
  type AiOrchestratorWorkerWiringAdaptersV1,
  type AiOrchestratorWorkerWiringErrorCode,
  type AiOrchestratorWorkerWiringProcessV1,
} from '../src/lib/ai-orchestrator/worker-admission-claim-lease-wiring-v1';

type TestLease = { readonly marker: 'opaque-test-lease' };

const environment = Object.freeze({
  workerEnabled: '1',
  provider: 'mock',
  externalProvidersEnabled: 'false',
  allowedModels: '',
});

const authorized = Object.freeze({ allowed: true, code: 'AUTHORIZED' } as const);
const foundationLocked = Object.freeze({
  allowed: false,
  code: 'FOUNDATION_LOCKED',
} as const);

function opaqueLease(): TestLease {
  return Object.freeze({ marker: 'opaque-test-lease' });
}

function expectWiringError(code: AiOrchestratorWorkerWiringErrorCode, action: () => unknown) {
  assert.throws(action, (error: unknown) => (
    error instanceof AiOrchestratorWorkerWiringError && error.code === code
  ));
}

function deferred<T>() {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for test condition.');
    await new Promise<void>((resolveWait) => setImmediate(resolveWait));
  }
}

function defaultAdapters(
  overrides: Partial<AiOrchestratorWorkerWiringAdaptersV1<TestLease>> = {},
): AiOrchestratorWorkerWiringAdaptersV1<TestLease> {
  return {
    readAuthority: () => authorized,
    canAcceptLease: () => true,
    recover: () => 0,
    supersede: () => 0,
    admit: () => 0,
    claim: () => null,
    heartbeat: () => 'LEASE_CURRENT',
    surrender: () => undefined,
    disconnect: () => undefined,
    ...overrides,
  };
}

test('manifesto PR82 è autonomo, hashato, fail-closed e senza consumer production', () => {
  assert.deepEqual(getAiOrchestratorWorkerWiringInvariantErrorsV1(), []);
  assert.equal(AI_ORCHESTRATOR_WORKER_WIRING_ACTIVATION_EPOCH, 'FOUNDATION_LOCKED_V1');
  assert.equal(AI_ORCHESTRATOR_WORKER_WIRING_PROCESS_MANIFEST.operational, false);
  assert.equal(AI_ORCHESTRATOR_WORKER_WIRING_PRODUCTION_CAN_ACCEPT_LEASE, false);
  assert.equal(
    AI_ORCHESTRATOR_WORKER_WIRING_PROCESS_MANIFEST.productionComposition.canAcceptLease,
    false,
  );
  assert.equal(
    AI_ORCHESTRATOR_WORKER_WIRING_PROCESS_MANIFEST.productionComposition.leaseConsumer,
    'NONE',
  );
  assert.equal(AI_ORCHESTRATOR_WORKER_WIRING_PROCESS_MANIFEST.authority.defaultDecision, 'DENY');
  assert.equal(
    AI_ORCHESTRATOR_WORKER_WIRING_PROCESS_MANIFEST.scheduling.overlappingOperationsAllowed,
    false,
  );
  assert.ok(Object.isFrozen(AI_ORCHESTRATOR_WORKER_WIRING_PROCESS_MANIFEST));
  assert.ok(Object.isFrozen(AI_ORCHESTRATOR_WORKER_WIRING_PROCESS_MANIFEST.authority));
  assert.ok(Object.isFrozen(AI_ORCHESTRATOR_WORKER_WIRING_PROCESS_MANIFEST.lifecycle));
  assert.equal(
    createAiOrchestratorWorkerWiringBuildHashV1(),
    AI_ORCHESTRATOR_WORKER_WIRING_BUILD_HASH,
  );
  assert.equal(
    AI_ORCHESTRATOR_WORKER_WIRING_BUILD_HASH,
    '3e17d9c2b169004779b7ecd69b36dd07bb74b97984ea518ec997bc3ff43447b5',
  );
});

test('configurazione PR82 usa confronti letterali e non conserva valori originali', () => {
  const parsed = parseAiOrchestratorWorkerWiringEnvironmentV1(environment);
  assert.deepEqual(parsed, {
    activationEpoch: 'FOUNDATION_LOCKED_V1',
    workerEnabled: true,
    provider: 'mock',
    dataMode: 'synthetic',
    externalProvidersEnabled: false,
    allowedModels: [],
  });
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.allowedModels));

  for (const workerEnabled of [undefined, '0', '', 'true', '01', ' 1', '1 ']) {
    expectWiringError('AI_WORKER_WIRING_GATE_INVALID', () => (
      parseAiOrchestratorWorkerWiringEnvironmentV1({ workerEnabled })
    ));
  }
  for (const provider of ['', 'MOCK', 'openai', ' mock']) {
    expectWiringError('AI_WORKER_WIRING_PROVIDER_NOT_MOCK', () => (
      parseAiOrchestratorWorkerWiringEnvironmentV1({ workerEnabled: '1', provider })
    ));
  }
  for (const externalProvidersEnabled of ['', '0', 'False', 'true', ' false']) {
    expectWiringError('AI_WORKER_WIRING_EXTERNAL_PROVIDERS_NOT_DISABLED', () => (
      parseAiOrchestratorWorkerWiringEnvironmentV1({
        workerEnabled: '1',
        externalProvidersEnabled,
      })
    ));
  }
  for (const allowedModels of [' ', 'mock', ',', 'gpt-5']) {
    expectWiringError('AI_WORKER_WIRING_MODEL_ALLOWLIST_NOT_EMPTY', () => (
      parseAiOrchestratorWorkerWiringEnvironmentV1({
        workerEnabled: '1',
        allowedModels,
      })
    ));
  }
});

test('authority è sempre la prima operazione e il diniego impedisce ogni mutazione', async () => {
  const calls: string[] = [];
  let observedCode: string | null = null;
  let worker!: AiOrchestratorWorkerWiringProcessV1;
  worker = createAiOrchestratorWorkerAdmissionClaimLeaseWiringV1({
    environment,
    adapters: defaultAdapters({
      readAuthority: () => {
        calls.push('authority');
        return foundationLocked;
      },
      canAcceptLease: () => {
        calls.push('accept');
        return true;
      },
      recover: () => {
        calls.push('recover');
        return 0;
      },
      supersede: () => {
        calls.push('supersede');
        return 0;
      },
      admit: () => {
        calls.push('admit');
        return 0;
      },
      claim: () => {
        calls.push('claim');
        return null;
      },
      wait: async (delayMs) => {
        calls.push('wait');
        assert.equal(delayMs, AI_ORCHESTRATOR_WORKER_WIRING_LIMITS.pollIntervalMs);
        observedCode = worker.getSnapshot().lastResultCode;
        worker.requestShutdown();
      },
      disconnect: () => {
        calls.push('disconnect');
      },
    }),
  });

  const firstStart = worker.start();
  assert.equal(worker.start(), firstStart);
  const stopped = await firstStart;
  assert.deepEqual(calls, ['authority', 'wait', 'disconnect']);
  assert.equal(observedCode, 'AUTHORITY_FOUNDATION_LOCKED');
  assert.equal(stopped.state, 'STOPPED');
  assert.equal(stopped.activeLease, false);
  assert.equal(stopped.operationPending, false);
  assert.equal(stopped.timerPending, false);
});

test('canAcceptLease false impedisce recovery, supersession, admission e claim', async () => {
  const calls: string[] = [];
  let observedCode: string | null = null;
  let worker!: AiOrchestratorWorkerWiringProcessV1;
  worker = createAiOrchestratorWorkerAdmissionClaimLeaseWiringV1({
    environment,
    adapters: defaultAdapters({
      readAuthority: () => {
        calls.push('authority');
        return authorized;
      },
      canAcceptLease: () => {
        calls.push('accept');
        return false;
      },
      recover: () => {
        calls.push('recover');
        return 0;
      },
      supersede: () => {
        calls.push('supersede');
        return 0;
      },
      admit: () => {
        calls.push('admit');
        return 0;
      },
      claim: () => {
        calls.push('claim');
        return null;
      },
      wait: async () => {
        calls.push('wait');
        observedCode = worker.getSnapshot().lastResultCode;
        worker.requestShutdown();
      },
      disconnect: () => {
        calls.push('disconnect');
      },
    }),
  });

  const stopped = await worker.start();
  assert.deepEqual(calls, ['authority', 'accept', 'wait', 'disconnect']);
  assert.equal(observedCode, 'LEASE_ACCEPTANCE_DISABLED');
  assert.equal(stopped.state, 'STOPPED');
});

test('ciclo positivo è strettamente sequenziale e il claim nullo produce NO_WORK', async () => {
  const calls: string[] = [];
  let activeOperations = 0;
  let maxActiveOperations = 0;
  const capturedIdentities: Array<Readonly<{
    workerInstanceId: string;
    workerBuildHash: string;
  }>> = [];
  let observedCode: string | null = null;
  let worker!: AiOrchestratorWorkerWiringProcessV1;

  const operation = async <T>(name: string, value: T) => {
    calls.push(name);
    activeOperations += 1;
    maxActiveOperations = Math.max(maxActiveOperations, activeOperations);
    await Promise.resolve();
    activeOperations -= 1;
    return value;
  };

  worker = createAiOrchestratorWorkerAdmissionClaimLeaseWiringV1({
    environment,
    adapters: defaultAdapters({
      readAuthority: () => operation('authority', authorized),
      canAcceptLease: () => operation('accept', true),
      recover: () => operation('recover', 0),
      supersede: () => operation('supersede', 0),
      admit: () => operation('admit', 0),
      claim: (identity) => {
        capturedIdentities.push(identity);
        return operation('claim', null);
      },
      wait: async (delayMs) => {
        calls.push('wait');
        assert.equal(delayMs, AI_ORCHESTRATOR_WORKER_WIRING_LIMITS.pollIntervalMs);
        observedCode = worker.getSnapshot().lastResultCode;
        worker.requestShutdown();
      },
      disconnect: () => operation('disconnect', undefined),
    }),
  });

  assert.match(
    worker.workerInstanceId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.equal(worker.workerBuildHash, AI_ORCHESTRATOR_WORKER_WIRING_BUILD_HASH);
  const stopped = await worker.start();
  assert.deepEqual(
    calls,
    ['authority', 'accept', 'recover', 'supersede', 'admit', 'claim', 'wait', 'disconnect'],
  );
  assert.equal(maxActiveOperations, 1);
  assert.equal(activeOperations, 0);
  assert.equal(capturedIdentities.length, 1);
  const capturedIdentity = capturedIdentities[0];
  assert.ok(capturedIdentity);
  assert.ok(Object.isFrozen(capturedIdentity));
  assert.equal(capturedIdentity.workerInstanceId, worker.workerInstanceId);
  assert.equal(capturedIdentity.workerBuildHash, worker.workerBuildHash);
  assert.equal(observedCode, 'NO_WORK');
  assert.equal(stopped.operationSequence, 7);
  assert.equal(stopped.heartbeatSequence, 0);
  assert.equal(stopped.surrenderSequence, 0);
});

test('drain durante ogni mutazione interrompe il ciclo prima dell’operazione successiva', async () => {
  const stages = ['recover', 'supersede', 'admit'] as const;
  for (const stage of stages) {
    const calls: string[] = [];
    const pending = deferred<number>();
    const stageValue = (name: typeof stages[number]) => {
      calls.push(name);
      return name === stage ? pending.promise : 0;
    };
    const worker = createAiOrchestratorWorkerAdmissionClaimLeaseWiringV1({
      environment,
      adapters: defaultAdapters({
        readAuthority: () => {
          calls.push('authority');
          return authorized;
        },
        canAcceptLease: () => {
          calls.push('accept');
          return true;
        },
        recover: () => stageValue('recover'),
        supersede: () => stageValue('supersede'),
        admit: () => stageValue('admit'),
        claim: () => {
          calls.push('claim');
          return null;
        },
        disconnect: () => {
          calls.push('disconnect');
        },
      }),
    });

    const completion = worker.start();
    await waitUntil(() => calls.includes(stage));
    assert.equal(worker.requestShutdown(), true);
    pending.resolve(0);
    const stopped = await completion;
    const stageIndex = calls.indexOf(stage);
    assert.deepEqual(calls.slice(stageIndex + 1), ['disconnect']);
    assert.equal(stopped.state, 'STOPPED');
    assert.equal(stopped.activeLease, false);
    assert.equal(stopped.surrenderSequence, 0);
  }
});

test('claim risolto dopo il drain registra la lease e la surrendera una sola volta', async () => {
  const calls: string[] = [];
  const pendingClaim = deferred<TestLease | null>();
  let capturedIdentity: Readonly<{
    workerInstanceId: string;
    workerBuildHash: string;
  }> | null = null;
  const worker = createAiOrchestratorWorkerAdmissionClaimLeaseWiringV1({
    environment,
    adapters: defaultAdapters({
      readAuthority: () => {
        calls.push('authority');
        return authorized;
      },
      canAcceptLease: () => {
        calls.push('accept');
        return true;
      },
      recover: () => {
        calls.push('recover');
        return 0;
      },
      supersede: () => {
        calls.push('supersede');
        return 0;
      },
      admit: () => {
        calls.push('admit');
        return 0;
      },
      claim: (identity) => {
        calls.push('claim');
        capturedIdentity = identity;
        return pendingClaim.promise;
      },
      heartbeat: () => {
        calls.push('heartbeat');
        return 'LEASE_CURRENT' as const;
      },
      surrender: (lease) => {
        calls.push('surrender');
        assert.equal(lease.marker, 'opaque-test-lease');
      },
      disconnect: () => {
        calls.push('disconnect');
      },
    }),
  });

  const completion = worker.start();
  await waitUntil(() => calls.includes('claim'));
  assert.equal(worker.requestShutdown(), true);
  assert.equal(worker.requestShutdown(), false);
  pendingClaim.resolve(opaqueLease());
  const stopped = await completion;

  assert.ok(capturedIdentity);
  assert.deepEqual(calls, [
    'authority',
    'accept',
    'recover',
    'supersede',
    'admit',
    'claim',
    'surrender',
    'disconnect',
  ]);
  assert.equal(stopped.state, 'STOPPED');
  assert.equal(stopped.activeLease, false);
  assert.equal(stopped.lastResultCode, 'DRAIN_REQUESTED');
  assert.equal(stopped.heartbeatSequence, 0);
  assert.equal(stopped.surrenderSequence, 1);
});

test('heartbeat è sequenziale e il drain durante il battito surrendera una volta', async () => {
  const calls: string[] = [];
  const delays: number[] = [];
  let activeOperations = 0;
  let maxActiveOperations = 0;
  let worker!: AiOrchestratorWorkerWiringProcessV1;

  const operation = async <T>(name: string, value: T) => {
    calls.push(name);
    activeOperations += 1;
    maxActiveOperations = Math.max(maxActiveOperations, activeOperations);
    await Promise.resolve();
    activeOperations -= 1;
    return value;
  };

  worker = createAiOrchestratorWorkerAdmissionClaimLeaseWiringV1({
    environment,
    adapters: defaultAdapters({
      readAuthority: () => operation('authority', authorized),
      canAcceptLease: () => operation('accept', true),
      recover: () => operation('recover', 0),
      supersede: () => operation('supersede', 0),
      admit: () => operation('admit', 0),
      claim: () => operation('claim', opaqueLease()),
      wait: async (delayMs) => {
        calls.push('wait');
        delays.push(delayMs);
      },
      heartbeat: async () => {
        calls.push('heartbeat');
        activeOperations += 1;
        maxActiveOperations = Math.max(maxActiveOperations, activeOperations);
        assert.equal(worker.requestShutdown(), true);
        await Promise.resolve();
        activeOperations -= 1;
        return 'LEASE_CURRENT' as const;
      },
      surrender: () => operation('surrender', undefined),
      disconnect: () => operation('disconnect', undefined),
    }),
  });

  const stopped = await worker.start();
  assert.deepEqual(delays, [AI_ORCHESTRATOR_WORKER_WIRING_LIMITS.heartbeatIntervalMs]);
  assert.deepEqual(calls, [
    'authority',
    'accept',
    'recover',
    'supersede',
    'admit',
    'claim',
    'wait',
    'authority',
    'accept',
    'heartbeat',
    'surrender',
    'disconnect',
  ]);
  assert.equal(maxActiveOperations, 1);
  assert.equal(activeOperations, 0);
  assert.equal(stopped.heartbeatSequence, 1);
  assert.equal(stopped.surrenderSequence, 1);
  assert.equal(stopped.activeLease, false);
});

test('heartbeat stale elimina definitivamente la lease senza surrender', async () => {
  const calls: string[] = [];
  let worker!: AiOrchestratorWorkerWiringProcessV1;
  worker = createAiOrchestratorWorkerAdmissionClaimLeaseWiringV1({
    environment,
    adapters: defaultAdapters({
      readAuthority: () => authorized,
      canAcceptLease: () => true,
      claim: () => opaqueLease(),
      wait: async () => undefined,
      heartbeat: () => {
        calls.push('heartbeat');
        worker.requestShutdown();
        return 'LEASE_STALE';
      },
      surrender: () => {
        calls.push('surrender');
      },
      disconnect: () => {
        calls.push('disconnect');
      },
    }),
  });

  const stopped = await worker.start();
  assert.deepEqual(calls, ['heartbeat', 'disconnect']);
  assert.equal(stopped.heartbeatSequence, 1);
  assert.equal(stopped.surrenderSequence, 0);
  assert.equal(stopped.activeLease, false);
});

test('errore adapter è minimizzato e cleanup conserva surrender e disconnect', async () => {
  const calls: string[] = [];
  const worker = createAiOrchestratorWorkerAdmissionClaimLeaseWiringV1({
    environment,
    adapters: defaultAdapters({
      claim: () => opaqueLease(),
      wait: async () => undefined,
      heartbeat: async () => {
        calls.push('heartbeat');
        throw new Error('secret raw adapter payload');
      },
      surrender: () => {
        calls.push('surrender');
      },
      disconnect: () => {
        calls.push('disconnect');
      },
    }),
  });

  await assert.rejects(worker.start(), (error: unknown) => (
    error instanceof AiOrchestratorWorkerWiringError
    && error.code === 'AI_WORKER_WIRING_ADAPTER_FAILURE'
    && error.message === 'AI_WORKER_WIRING_ADAPTER_FAILURE'
    && !error.message.includes('secret')
  ));
  assert.deepEqual(calls, ['heartbeat', 'surrender', 'disconnect']);
  const stopped = worker.getSnapshot();
  assert.equal(stopped.state, 'STOPPED');
  assert.equal(stopped.activeLease, false);
  assert.equal(stopped.surrenderSequence, 1);
  assert.equal(stopped.operationPending, false);
  assert.equal(stopped.timerPending, false);
});

test('errori DB esauriti restano distinti senza propagare dettagli adapter', async () => {
  for (const [adapterCode, expectedCode] of [
    [
      'AI_WORKER_RUNTIME_ADAPTER_DB_TRANSIENT',
      'AI_WORKER_WIRING_DB_TRANSIENT_EXHAUSTED',
    ],
    [
      'AI_WORKER_RUNTIME_ADAPTER_DB_UNAVAILABLE',
      'AI_WORKER_WIRING_DB_UNAVAILABLE',
    ],
  ] as const) {
    const worker = createAiOrchestratorWorkerAdmissionClaimLeaseWiringV1({
      environment,
      adapters: defaultAdapters({
        readAuthority: () => {
          throw Object.freeze({
            code: adapterCode,
            message: 'secret raw database detail',
          });
        },
      }),
    });
    await assert.rejects(worker.start(), (error: unknown) => (
      error instanceof AiOrchestratorWorkerWiringError
      && error.code === expectedCode
      && error.message === expectedCode
      && !error.message.includes('secret')
    ));
    assert.equal(worker.getSnapshot().state, 'STOPPED');
  }
});

test('confini statici mantengono il modulo puro e privo di superfici vietate', () => {
  const root = resolve(import.meta.dirname, '..');
  const source = readFileSync(resolve(
    root,
    'src/lib/ai-orchestrator/worker-admission-claim-lease-wiring-v1.ts',
  ), 'utf8');

  assert.doesNotMatch(source, /@prisma|worker-runtime|DATABASE_URL|AiRun|AiOutput/);
  assert.doesNotMatch(
    source,
    /from\s+['"](?:node:)?(?:http|https|net|dns|tls|fs|child_process|worker_threads)['"]/,
  );
  assert.doesNotMatch(source, /\bfetch\s*\(|\bWebSocket\b|\bOpenAI\b|\baxios\b|\bundici\b/);
  assert.doesNotMatch(
    source,
    /\b(?:completeAiWorkflowJob|failAiWorkflowJob|applyAuditWorkflowTransition)\b/,
  );
  assert.doesNotMatch(source, /\bprocess\.(?:env|argv|pid|exit)\b|\bos\.hostname\b/);
  assert.doesNotMatch(source, /\bsetInterval\s*\(|\beval\s*\(|\bnew\s+Function\s*\(/);
});
