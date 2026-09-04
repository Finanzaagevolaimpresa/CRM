import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  DependencyAuditGateError,
  NPM_AUDIT_POLICY,
  type AuditCommandResult,
  type AuditCommandRunner,
  runDependencyAuditGate,
  validateAuditReport,
} from '../scripts/npm-audit-gate';

const quietLogger = { log: () => undefined, warn: () => undefined };

function report(severity?: 'info' | 'low' | 'moderate' | 'high' | 'critical') {
  const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 };
  const vulnerabilities: Record<string, unknown> = {};
  if (severity) {
    counts[severity] = 1;
    counts.total = 1;
    vulnerabilities.synthetic_dependency = {
      name: 'synthetic_dependency',
      severity,
      isDirect: true,
      via: ['SYNTHETIC-ONLY'],
      effects: [],
      range: '<1.0.0',
      nodes: ['node_modules/synthetic_dependency'],
      fixAvailable: false,
    };
  }
  return JSON.stringify({
    auditReportVersion: 2,
    vulnerabilities,
    metadata: {
      vulnerabilities: counts,
      dependencies: { prod: 100, dev: 50, optional: 5, peer: 3, peerOptional: 1, total: 159 },
    },
  });
}

function result(overrides: Partial<AuditCommandResult> = {}): AuditCommandResult {
  return {
    exitCode: 0,
    stdout: report(),
    stderr: '',
    timedOut: false,
    outputOverflow: false,
    ...overrides,
  };
}

function scriptedRunner(script: AuditCommandResult[]) {
  const calls: Array<{ args: readonly string[]; timeoutMs: number }> = [];
  const runner: AuditCommandRunner = async (args, timeoutMs) => {
    calls.push({ args, timeoutMs });
    const next = script.shift();
    assert.ok(next, 'Unexpected npm invocation');
    return next;
  };
  return { calls, runner };
}

const versionResult = () => result({ stdout: `${NPM_AUDIT_POLICY.npmVersion}\n` });

async function expectGateError(
  promise: Promise<unknown>,
  expectedCode: string,
): Promise<DependencyAuditGateError> {
  try {
    await promise;
    assert.fail(`Expected dependency audit failure ${expectedCode}`);
  } catch (error) {
    assert.ok(error instanceof DependencyAuditGateError);
    assert.equal(error.code, expectedCode);
    return error;
  }
}

test('the gate is strictly bounded and keeps npm audit-level low', async () => {
  assert.equal(NPM_AUDIT_POLICY.npmVersion, '11.16.0');
  assert.equal(NPM_AUDIT_POLICY.maxAttemptsPerScope, 3);
  assert.ok(NPM_AUDIT_POLICY.attemptTimeoutMs <= 40_000);
  assert.ok(
    NPM_AUDIT_POLICY.versionTimeoutMs
      + (2 * NPM_AUDIT_POLICY.maxAttemptsPerScope * NPM_AUDIT_POLICY.attemptTimeoutMs)
      + (2 * (NPM_AUDIT_POLICY.maxAttemptsPerScope - 1) * NPM_AUDIT_POLICY.retryDelayMs)
      < 300_000,
  );

  const scripted = scriptedRunner([versionResult(), result(), result()]);
  const summaries = await runDependencyAuditGate({
    runner: scripted.runner,
    sleep: async () => undefined,
    logger: quietLogger,
  });

  assert.deepEqual(summaries.map((summary) => summary.scope), ['runtime', 'complete']);
  assert.deepEqual(scripted.calls[0].args, ['--version']);
  assert.ok(scripted.calls[1].args.includes('--omit=dev'));
  assert.ok(scripted.calls[1].args.includes('--include=prod'));
  assert.ok(scripted.calls[1].args.includes('--include=optional'));
  assert.ok(scripted.calls[1].args.includes('--include=peer'));
  assert.ok(scripted.calls[2].args.includes('--include=dev'));
  assert.ok(scripted.calls[2].args.includes('--include=prod'));
  assert.ok(scripted.calls[2].args.includes('--include=optional'));
  assert.ok(scripted.calls[2].args.includes('--include=peer'));
  for (const call of scripted.calls.slice(1)) {
    assert.ok(call.args.includes('--audit-level=low'));
    assert.ok(call.args.includes('--json'));
    assert.ok(call.args.includes('--registry=https://registry.npmjs.org/'));
    assert.ok(call.args.includes('--offline=false'));
    assert.ok(call.args.includes('--prefer-online=true'));
    assert.ok(call.args.includes('--fetch-retries=0'));
    assert.equal(call.timeoutMs, NPM_AUDIT_POLICY.attemptTimeoutMs);
  }
});

test('recognized transient failures retry only to the fixed maximum and remain blocking', async () => {
  const timeout = result({ exitCode: 1, stdout: '', stderr: 'network timeout', timedOut: true });
  const scripted = scriptedRunner([versionResult(), timeout, timeout, timeout]);
  const delays: number[] = [];

  const error = await expectGateError(
    runDependencyAuditGate({
      runner: scripted.runner,
      sleep: async (delayMs) => { delays.push(delayMs); },
      logger: quietLogger,
    }),
    'AUDIT_SERVICE_UNAVAILABLE',
  );

  assert.equal(error.scope, 'runtime');
  assert.equal(error.attempt, 3);
  assert.equal(scripted.calls.length, 4);
  assert.deepEqual(delays, [NPM_AUDIT_POLICY.retryDelayMs, NPM_AUDIT_POLICY.retryDelayMs]);
});

test('a transient service failure may recover without weakening either audit scope', async () => {
  const unavailable = result({
    exitCode: 1,
    stdout: JSON.stringify({ error: { code: 'E503' } }),
    stderr: '',
  });
  const scripted = scriptedRunner([versionResult(), unavailable, result(), result()]);

  const summaries = await runDependencyAuditGate({
    runner: scripted.runner,
    sleep: async () => undefined,
    logger: quietLogger,
  });

  assert.equal(summaries[0].attempt, 2);
  assert.equal(summaries[1].attempt, 1);
});

test('malformed and incomplete reports fail closed without retry', async () => {
  for (const invalidReport of ['not-json', JSON.stringify({ auditReportVersion: 2 })]) {
    const scripted = scriptedRunner([versionResult(), result({ stdout: invalidReport })]);
    const expected = invalidReport === 'not-json' ? 'MALFORMED_REPORT' : 'INCOMPLETE_REPORT';
    await expectGateError(
      runDependencyAuditGate({
        runner: scripted.runner,
        sleep: async () => undefined,
        logger: quietLogger,
      }),
      expected,
    );
    assert.equal(scripted.calls.length, 2);
  }
});

test('a vulnerability at audit-level low fails immediately and is never retried', async () => {
  const scripted = scriptedRunner([
    versionResult(),
    result({ exitCode: 1, stdout: report('low'), stderr: 'service unavailable' }),
  ]);

  await expectGateError(
    runDependencyAuditGate({
      runner: scripted.runner,
      sleep: async () => undefined,
      logger: quietLogger,
    }),
    'VULNERABILITIES_AT_OR_ABOVE_LOW',
  );
  assert.equal(scripted.calls.length, 2);
});

test('the removed quick-audit endpoint is forbidden even on otherwise retryable output', async () => {
  const scripted = scriptedRunner([
    versionResult(),
    result({
      exitCode: 1,
      stdout: '',
      stderr: '503 service unavailable at /-/npm/v1/security/audits/quick',
    }),
  ]);

  await expectGateError(
    runDependencyAuditGate({
      runner: scripted.runner,
      sleep: async () => undefined,
      logger: quietLogger,
    }),
    'LEGACY_AUDIT_ENDPOINT_FORBIDDEN',
  );
  assert.equal(scripted.calls.length, 2);
});

test('the exact npm client version and complete report consistency are mandatory', async () => {
  const wrongVersion = scriptedRunner([result({ stdout: '11.15.0\n' })]);
  await expectGateError(
    runDependencyAuditGate({ runner: wrongVersion.runner, logger: quietLogger }),
    'NPM_CLIENT_VERSION_UNVERIFIABLE',
  );

  const inconsistent = JSON.parse(report()) as {
    metadata: { vulnerabilities: { total: number } };
  };
  inconsistent.metadata.vulnerabilities.total = 1;
  assert.deepEqual(validateAuditReport(JSON.stringify(inconsistent)), {
    ok: false,
    code: 'INCONSISTENT_REPORT',
  });
});

test('CI pins the bulk-only npm client and keeps the audit gate blocking', () => {
  const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
  assert.match(workflow, /npm install --global npm@11\.16\.0/);
  assert.match(workflow, /--registry=https:\/\/registry\.npmjs\.org\//);
  assert.match(workflow, /test "\$\(npm --version\)" = "11\.16\.0"/);
  assert.match(workflow, /node --import tsx --test tests\/npm-audit-gate\.test\.ts/);
  assert.match(workflow, /node --import tsx scripts\/npm-audit-gate\.ts/);
  assert.doesNotMatch(workflow, /audits\/quick/);
  assert.doesNotMatch(workflow, /continue-on-error/);
});
