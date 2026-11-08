import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const scriptPath = resolve(root, 'scripts/ai-orchestrator-worker.ts');

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
