import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  AI_ORCHESTRATOR_DORMANT_WORKER_ACTIVATION_EPOCH,
  AI_ORCHESTRATOR_DORMANT_WORKER_BUILD_HASH,
  AI_ORCHESTRATOR_DORMANT_WORKER_POLL_RESULT,
  AI_ORCHESTRATOR_DORMANT_WORKER_PROCESS_LIMITS,
  AI_ORCHESTRATOR_DORMANT_WORKER_PROCESS_MANIFEST,
  AiOrchestratorDormantWorkerProcessError,
  calculateAiOrchestratorDormantWorkerPollDelayMsV1,
  createAiOrchestratorDormantWorkerBuildHashV1,
  createAiOrchestratorDormantWorkerHeartbeatV1,
  createAiOrchestratorDormantWorkerProcessV1,
  getAiOrchestratorDormantWorkerProcessInvariantErrorsV1,
  parseAiOrchestratorDormantWorkerEnvironmentV1,
  type AiOrchestratorDormantWorkerErrorCode,
  type AiOrchestratorDormantWorkerProcessV1,
} from '../src/lib/ai-orchestrator/dormant-worker-process-v1';

const root = resolve(import.meta.dirname, '..');
const modulePath = resolve(root, 'src/lib/ai-orchestrator/dormant-worker-process-v1.ts');
const scriptPath = resolve(root, 'scripts/ai-orchestrator-worker.ts');

function expectProcessError(code: AiOrchestratorDormantWorkerErrorCode, action: () => unknown) {
  assert.throws(action, (error: unknown) => (
    error instanceof AiOrchestratorDormantWorkerProcessError && error.code === code
  ));
}

function abortError() {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for test condition.');
    await new Promise<void>((resolveWait) => setImmediate(resolveWait));
  }
}

test('manifesto PR81 è canonico, immutabile, non operativo e hashato', () => {
  assert.deepEqual(getAiOrchestratorDormantWorkerProcessInvariantErrorsV1(), []);
  assert.equal(AI_ORCHESTRATOR_DORMANT_WORKER_ACTIVATION_EPOCH, 'FOUNDATION_LOCKED_V1');
  assert.equal(AI_ORCHESTRATOR_DORMANT_WORKER_PROCESS_MANIFEST.operational, false);
  assert.deepEqual(AI_ORCHESTRATOR_DORMANT_WORKER_PROCESS_MANIFEST.lifecycle, [
    'DORMANT', 'DRAINING', 'STOPPED',
  ]);
  assert.equal(AI_ORCHESTRATOR_DORMANT_WORKER_PROCESS_MANIFEST.polling.dataSource, 'NONE');
  assert.equal(
    AI_ORCHESTRATOR_DORMANT_WORKER_PROCESS_MANIFEST.polling.outcome,
    'NO_WORK_FOUNDATION_LOCKED',
  );
  assert.ok(Object.isFrozen(AI_ORCHESTRATOR_DORMANT_WORKER_PROCESS_MANIFEST));
  assert.ok(Object.isFrozen(AI_ORCHESTRATOR_DORMANT_WORKER_PROCESS_MANIFEST.authority));
  assert.ok(Object.isFrozen(AI_ORCHESTRATOR_DORMANT_WORKER_PROCESS_MANIFEST.heartbeat.fields));
  assert.equal(createAiOrchestratorDormantWorkerBuildHashV1(), AI_ORCHESTRATOR_DORMANT_WORKER_BUILD_HASH);
  assert.equal(
    AI_ORCHESTRATOR_DORMANT_WORKER_BUILD_HASH,
    'ec872461a762c80d0d37629ebbfae68dd06f31166cabb64f3eed9c186f127f4a',
  );
});

test('environment exact-match ammette soltanto la shell dormiente mock/synthetic', () => {
  const defaults = parseAiOrchestratorDormantWorkerEnvironmentV1({});
  const explicit = parseAiOrchestratorDormantWorkerEnvironmentV1({
    workerEnabled: '0',
    provider: 'mock',
    externalProvidersEnabled: 'false',
    allowedModels: '',
  });
  assert.deepEqual(defaults, explicit);
  assert.deepEqual(explicit, {
    activationEpoch: 'FOUNDATION_LOCKED_V1',
    workerEnabled: false,
    provider: 'mock',
    dataMode: 'synthetic',
    externalProvidersEnabled: false,
    allowedModels: [],
  });
  assert.ok(Object.isFrozen(explicit));
  assert.ok(Object.isFrozen(explicit.allowedModels));

  expectProcessError('AI_DORMANT_WORKER_FOUNDATION_LOCKED', () => (
    parseAiOrchestratorDormantWorkerEnvironmentV1({ workerEnabled: '1' })
  ));
  for (const workerEnabled of ['', 'true', 'false', '01', ' 0', '0 ', 'yes']) {
    expectProcessError('AI_DORMANT_WORKER_GATE_INVALID', () => (
      parseAiOrchestratorDormantWorkerEnvironmentV1({ workerEnabled })
    ));
  }
  for (const provider of ['', 'MOCK', 'openai', ' mock']) {
    expectProcessError('AI_DORMANT_WORKER_PROVIDER_NOT_MOCK', () => (
      parseAiOrchestratorDormantWorkerEnvironmentV1({ provider })
    ));
  }
  for (const externalProvidersEnabled of ['', '0', 'False', 'true', ' false']) {
    expectProcessError('AI_DORMANT_WORKER_EXTERNAL_PROVIDERS_NOT_DISABLED', () => (
      parseAiOrchestratorDormantWorkerEnvironmentV1({ externalProvidersEnabled })
    ));
  }
  for (const allowedModels of [' ', 'gpt-5', ',', 'mock']) {
    expectProcessError('AI_DORMANT_WORKER_MODEL_ALLOWLIST_NOT_EMPTY', () => (
      parseAiOrchestratorDormantWorkerEnvironmentV1({ allowedModels })
    ));
  }
});

test('identità, jitter e heartbeat sono deterministici, limitati e minimizzati', () => {
  const workerInstanceId = '00000000-0000-4000-8000-000000000001';
  const delays = Array.from({ length: 20 }, (_, index) => (
    calculateAiOrchestratorDormantWorkerPollDelayMsV1({
      workerInstanceId,
      pollSequence: index + 1,
    })
  ));
  assert.deepEqual(delays, Array.from({ length: 20 }, (_, index) => (
    calculateAiOrchestratorDormantWorkerPollDelayMsV1({
      workerInstanceId,
      pollSequence: index + 1,
    })
  )));
  assert.ok(new Set(delays).size > 1);
  for (const delay of delays) {
    assert.ok(delay >= AI_ORCHESTRATOR_DORMANT_WORKER_PROCESS_LIMITS.pollBaseIntervalMs);
    assert.ok(delay <= AI_ORCHESTRATOR_DORMANT_WORKER_PROCESS_LIMITS.pollBaseIntervalMs * 1.2);
  }
  expectProcessError('AI_DORMANT_WORKER_SEQUENCE_INVALID', () => (
    calculateAiOrchestratorDormantWorkerPollDelayMsV1({ workerInstanceId, pollSequence: 0 })
  ));

  const heartbeat = createAiOrchestratorDormantWorkerHeartbeatV1({
    workerInstanceId,
    sequence: 1,
    nowMs: 1_700_000_000_000,
  });
  assert.deepEqual(Object.keys(heartbeat), [
    'schemaVersion',
    'workerProcessVersion',
    'workerInstanceId',
    'workerBuildHash',
    'state',
    'sequence',
    'timestamp',
  ]);
  assert.deepEqual(heartbeat, {
    schemaVersion: 1,
    workerProcessVersion: '1.0',
    workerInstanceId,
    workerBuildHash: AI_ORCHESTRATOR_DORMANT_WORKER_BUILD_HASH,
    state: 'DORMANT',
    sequence: 1,
    timestamp: '2023-11-14T22:13:20.000Z',
  });
  assert.doesNotMatch(JSON.stringify(heartbeat), /payload|reason|provider|model|url|error|stack/i);
});

test('import del modulo è privo di timer, log e letture environment', () => {
  const imported = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', `await import(${JSON.stringify(modulePath)})`],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        AI_ORCHESTRATOR_WORKER_ENABLED: '1',
        AI_PROVIDER: 'openai',
        AI_EXTERNAL_PROVIDERS_ENABLED: 'true',
        AI_ALLOWED_MODELS: 'forbidden-model',
      },
    },
  );
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout, '');
  assert.equal(imported.stderr, '');
});

test('scheduler singolo produce solo NO_WORK e heartbeat a 30 secondi senza overlap', async () => {
  let nowMs = 0;
  let activeTimers = 0;
  let maxActiveTimers = 0;
  let waitCalls = 0;
  const lines: string[] = [];
  let worker: AiOrchestratorDormantWorkerProcessV1;

  worker = createAiOrchestratorDormantWorkerProcessV1({
    environment: { workerEnabled: '0' },
    adapters: {
      nowMs: () => nowMs,
      wait: async (delayMs, signal) => {
        assert.equal(signal.aborted, false);
        activeTimers += 1;
        maxActiveTimers = Math.max(maxActiveTimers, activeTimers);
        waitCalls += 1;
        assert.ok(delayMs >= 0);
        nowMs += delayMs;
        activeTimers -= 1;
      },
      writeJsonLine: (line) => {
        lines.push(line);
        if (lines.length === 2) worker.requestShutdown();
      },
    },
  });

  assert.match(worker.workerInstanceId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(worker.workerBuildHash, AI_ORCHESTRATOR_DORMANT_WORKER_BUILD_HASH);
  const firstStart = worker.start();
  assert.equal(worker.start(), firstStart);
  const stopped = await firstStart;

  assert.equal(stopped.state, 'STOPPED');
  assert.equal(stopped.timerPending, false);
  assert.equal(stopped.lastPollResult, AI_ORCHESTRATOR_DORMANT_WORKER_POLL_RESULT);
  assert.ok(stopped.pollSequence >= 4 && stopped.pollSequence <= 6);
  assert.equal(stopped.heartbeatSequence, 2);
  assert.equal(maxActiveTimers, 1);
  assert.ok(waitCalls >= 5 && waitCalls <= 8);
  assert.equal(activeTimers, 0);
  assert.equal(lines.length, 2);
  assert.ok(lines.every((line) => line.endsWith('\n')));
  const heartbeats = lines.map((line) => JSON.parse(line) as { sequence: number; state: string });
  assert.deepEqual(heartbeats.map(({ sequence }) => sequence), [1, 2]);
  assert.deepEqual(heartbeats.map(({ state }) => state), ['DORMANT', 'DORMANT']);
});

test('shutdown è DORMANT→DRAINING→STOPPED, abortibile e idempotente', async () => {
  const lines: string[] = [];
  let pendingTimers = 0;
  const worker = createAiOrchestratorDormantWorkerProcessV1({
    environment: {},
    adapters: {
      writeJsonLine: (line) => {
        lines.push(line);
      },
      wait: (delayMs, signal) => new Promise<void>((_resolveWait, rejectWait) => {
        assert.ok(delayMs >= 5_000 && delayMs <= 6_000);
        pendingTimers += 1;
        signal.addEventListener('abort', () => {
          pendingTimers -= 1;
          rejectWait(abortError());
        }, { once: true });
      }),
    },
  });

  const completion = worker.start();
  await waitUntil(() => lines.length === 1 && worker.getSnapshot().timerPending);
  assert.equal(worker.getSnapshot().state, 'DORMANT');
  assert.equal(pendingTimers, 1);
  assert.equal(worker.requestShutdown(), true);
  assert.equal(worker.getSnapshot().state, 'DRAINING');
  assert.equal(worker.requestShutdown(), false);
  const stopped = await completion;
  assert.equal(stopped.state, 'STOPPED');
  assert.equal(stopped.timerPending, false);
  assert.equal(pendingTimers, 0);
  assert.equal(lines.length, 1);
});

test('shutdown libera anche una scrittura heartbeat permanentemente bloccata', async () => {
  const worker = createAiOrchestratorDormantWorkerProcessV1({
    environment: {},
    adapters: {
      writeJsonLine: () => new Promise<void>(() => undefined),
    },
  });
  const completion = worker.start();
  await waitUntil(() => worker.getSnapshot().heartbeatSequence === 1);
  assert.equal(worker.requestShutdown(), true);
  assert.equal(worker.getSnapshot().state, 'DRAINING');
  let shutdownTimeout: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolveStop, rejectStop) => {
    shutdownTimeout = setTimeout(
      () => rejectStop(new Error('Shutdown blocked by stdout backpressure.')),
      1_000,
    );
  });
  const stopped = await Promise.race([completion, timeout]).finally(() => {
    if (shutdownTimeout) clearTimeout(shutdownTimeout);
  });
  assert.equal(stopped.state, 'STOPPED');
  assert.equal(stopped.timerPending, false);
  assert.equal(stopped.pollSequence, 0);
});

test('errori writer e timer chiudono STOPPED con codici minimizzati', async () => {
  const writerFailure = createAiOrchestratorDormantWorkerProcessV1({
    environment: {},
    adapters: {
      writeJsonLine: async () => {
        await Promise.resolve();
        throw new Error('secret raw stdout failure');
      },
    },
  });
  await assert.rejects(
    writerFailure.start(),
    (error: unknown) => error instanceof AiOrchestratorDormantWorkerProcessError
      && error.code === 'AI_DORMANT_WORKER_STDOUT_FAILURE'
      && !error.message.includes('secret'),
  );
  assert.equal(writerFailure.getSnapshot().state, 'STOPPED');
  assert.equal(writerFailure.getSnapshot().timerPending, false);

  const timerFailure = createAiOrchestratorDormantWorkerProcessV1({
    environment: {},
    adapters: {
      writeJsonLine: () => undefined,
      wait: async () => {
        throw new Error('secret raw timer failure');
      },
    },
  });
  await assert.rejects(
    timerFailure.start(),
    (error: unknown) => error instanceof AiOrchestratorDormantWorkerProcessError
      && error.code === 'AI_DORMANT_WORKER_TIMER_FAILURE'
      && !error.message.includes('secret'),
  );
  assert.equal(timerFailure.getSnapshot().state, 'STOPPED');
  assert.equal(timerFailure.getSnapshot().timerPending, false);
});

async function runWorkerAndSignal(signal: NodeJS.Signals) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>(
    (resolveRun, rejectRun) => {
      const child = spawn(process.execPath, ['--import', 'tsx', scriptPath], {
        cwd: root,
        env: {
          ...process.env,
          AI_ORCHESTRATOR_WORKER_ENABLED: '0',
          AI_PROVIDER: 'mock',
          AI_EXTERNAL_PROVIDERS_ENABLED: 'false',
          AI_ALLOWED_MODELS: '',
          DATABASE_URL: 'postgresql://127.0.0.1:1/must-not-connect?schema=public',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let signalled = false;
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        rejectRun(new Error(`Worker child did not stop after ${signal}.`));
      }, 10_000);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
        if (!signalled && stdout.includes('\n')) {
          signalled = true;
          child.kill(signal);
        }
      });
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.once('error', (error) => {
        clearTimeout(timeout);
        rejectRun(error);
      });
      child.once('exit', (code, exitSignal) => {
        clearTimeout(timeout);
        resolveRun({ code, signal: exitSignal, stdout, stderr });
      });
    },
  );
}

test('entrypoint gestisce SIGTERM/SIGINT senza DB, stack o process.exit', { timeout: 30_000 }, async () => {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    const result = await runWorkerAndSignal(signal);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
    const rows = result.stdout.trim().split('\n');
    assert.equal(rows.length, 1);
    const heartbeat = JSON.parse(rows[0]) as Record<string, unknown>;
    assert.deepEqual(Object.keys(heartbeat), [
      'schemaVersion',
      'workerProcessVersion',
      'workerInstanceId',
      'workerBuildHash',
      'state',
      'sequence',
      'timestamp',
    ]);
    assert.equal(heartbeat.state, 'DORMANT');
    assert.equal(heartbeat.sequence, 1);
    assert.doesNotMatch(result.stdout + result.stderr, /postgresql|must-not-connect|database_url|stack/i);
  }
});

test('entrypoint converte EPIPE reale in un solo errore minimizzato senza stack', () => {
  const result = spawnSync('bash', [
    '-o',
    'pipefail',
    '-c',
    'AI_ORCHESTRATOR_WORKER_ENABLED=0 AI_PROVIDER=mock AI_EXTERNAL_PROVIDERS_ENABLED=false AI_ALLOWED_MODELS= node --import tsx scripts/ai-orchestrator-worker.ts | head -n 0',
  ], {
    cwd: root,
    encoding: 'utf8',
    timeout: 15_000,
    env: process.env,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, '');
  const rows = result.stderr.trim().split('\n');
  assert.equal(rows.length, 1);
  const failure = JSON.parse(rows[0]) as Record<string, unknown>;
  assert.equal(failure.activationEpoch, 'FOUNDATION_LOCKED_V1');
  assert.equal(failure.errorCode, 'AI_DORMANT_WORKER_STDOUT_FAILURE');
  assert.doesNotMatch(result.stderr, /EPIPE|node:events|Unhandled|Error:|\.ts:|stack/i);
});

test('entrypoint rifiuta gate 1 e ambiguo prima di creare timer o heartbeat', () => {
  for (const [workerEnabled, expectedCode] of [
    ['1', 'AI_DORMANT_WORKER_FOUNDATION_LOCKED'],
    ['true', 'AI_DORMANT_WORKER_GATE_INVALID'],
  ] as const) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', scriptPath], {
      cwd: root,
      encoding: 'utf8',
      timeout: 15_000,
      env: {
        ...process.env,
        AI_ORCHESTRATOR_WORKER_ENABLED: workerEnabled,
        AI_PROVIDER: 'mock',
        AI_EXTERNAL_PROVIDERS_ENABLED: 'false',
        AI_ALLOWED_MODELS: '',
      },
    });
    assert.equal(result.status, 1);
    assert.equal(result.signal, null);
    assert.equal(result.stdout, '');
    const failure = JSON.parse(result.stderr) as Record<string, unknown>;
    assert.deepEqual(Object.keys(failure), [
      'schemaVersion', 'workerProcessVersion', 'activationEpoch', 'errorCode',
    ]);
    assert.equal(failure.activationEpoch, 'FOUNDATION_LOCKED_V1');
    assert.equal(failure.errorCode, expectedCode);
    assert.doesNotMatch(result.stderr, /true|stack|environment|process\.env/i);
  }
});

test('confini statici vietano DB, job, handler, rete, provider e avvio production', () => {
  const source = readFileSync(modulePath, 'utf8');
  const script = readFileSync(scriptPath, 'utf8');
  const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  const dockerfile = readFileSync(resolve(root, 'Dockerfile.prod.example'), 'utf8');
  const compose = readFileSync(resolve(root, 'docker-compose.prod.example.yml'), 'utf8');

  assert.doesNotMatch(source + script, /@prisma|worker-runtime|workflow-service|job-planner|mock-handler-registry|result-artifact-contract/i);
  assert.doesNotMatch(source + script, /from\s+['"](?:node:)?(?:http|https|net|dns|tls|fs|child_process|worker_threads)['"]/);
  assert.doesNotMatch(source + script, /\bfetch\s*\(|\bWebSocket\b|\bOpenAI\b|\baxios\b|\bundici\b/);
  assert.doesNotMatch(source + script, /\bDATABASE_URL\b|\bAI_API_KEY\b|\bprocess\.(?:argv|pid)\b|\bos\.hostname\b/);
  assert.doesNotMatch(source + script, /\bsetInterval\s*\(|\beval\s*\(|\bnew\s+Function\s*\(|\bprocess\.exit\s*\(/);
  assert.equal((script.match(/process\.env\.[A-Z0-9_]+/g) ?? []).length, 4);
  assert.doesNotMatch(script, /Object\.(?:keys|values|entries)\s*\(\s*process\.env|\.\.\.process\.env/);
  assert.equal(
    packageJson.scripts?.['ai:orchestrator:worker'],
    'tsx scripts/ai-orchestrator-worker.ts',
  );
  assert.match(dockerfile, /COPY --from=build[^\n]*\/app\/scripts \.\/scripts/);
  assert.match(dockerfile, /COPY --from=build[^\n]*\/app\/src \.\/src/);
  assert.match(dockerfile, /CMD \["npm", "run", "start"\]/);
  assert.doesNotMatch(compose, /^\s{2}(?:worker|ai-orchestrator-worker):/m);
  assert.deepEqual(
    readdirSync(resolve(root, 'deploy/systemd')).sort(),
    ['fai-crm-ai-reconcile.service.example', 'fai-crm-ai-reconcile.timer.example'],
  );
  assert.equal(readdirSync(resolve(root, 'prisma/migrations')).length, 29);
});
