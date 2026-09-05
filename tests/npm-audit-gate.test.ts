import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  DependencyAuditGateError,
  NPM_AUDIT_POLICY,
  OSV_FALLBACK_POLICY,
  type AuditCommandResult,
  type AuditCommandRunner,
  parseNpmLockInventory,
  provisionPinnedOsvScanner,
  runDependencyAuditGate,
  runDependencySecurityGate,
  runOsvFallback,
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
    assert.ok(next, 'Unexpected command invocation');
    return next;
  };
  return { calls, runner };
}

const versionResult = () => result({ stdout: `${NPM_AUDIT_POLICY.npmVersion}\n` });

const OSV_BINARY_PATH = resolve('.synthetic-tools/osv-scanner');
const OSV_CONFIG_PATH = resolve('.synthetic-tools/osv-scanner-empty-config.toml');
const OSV_LOCKFILE_PATH = resolve('package-lock.synthetic.json');
const SYNTHETIC_OSV_BINARY = Buffer.from('synthetic pinned osv scanner');
const EMPTY_OSV_CONFIG = Buffer.from('# An empty config file to override the ignore config\n');
const SYNTHETIC_LOCKFILE = Buffer.from(JSON.stringify({
  name: 'synthetic-audit-fixture',
  lockfileVersion: 3,
  requires: true,
  packages: {
    '': {
      name: 'synthetic-audit-fixture',
      dependencies: { alpha: '1.0.0', parent: '2.0.0' },
    },
    'node_modules/alpha': {
      version: '1.0.0',
      resolved: 'https://registry.npmjs.org/alpha/-/alpha-1.0.0.tgz',
      integrity: 'sha512-YQ==',
    },
    'node_modules/parent': {
      version: '2.0.0',
      resolved: 'https://registry.npmjs.org/parent/-/parent-2.0.0.tgz',
      integrity: 'sha512-Yg==',
    },
    'node_modules/parent/node_modules/alpha': {
      version: '1.0.0',
      resolved: 'https://registry.npmjs.org/alpha/-/alpha-1.0.0.tgz',
      integrity: 'sha512-YQ==',
    },
  },
}));
const SYNTHETIC_OSV_SHA256 = createHash('sha256').update(SYNTHETIC_OSV_BINARY).digest('hex');

function osvVersionResult(): AuditCommandResult {
  return result({
    stdout: '',
    stderr: `osv-scanner version: ${OSV_FALLBACK_POLICY.scannerVersion}\ncommit: synthetic\n`,
  });
}

function osvReport(options: {
  lockfilePath?: string;
  packages?: Array<{ name: string; version: string }>;
  vulnerability?: boolean;
} = {}): string {
  const packages = options.packages ?? [
    { name: 'alpha', version: '1.0.0' },
    { name: 'parent', version: '2.0.0' },
  ];
  return JSON.stringify({
    results: [
      {
        source: {
          path: options.lockfilePath ?? OSV_LOCKFILE_PATH,
          type: 'lockfile',
        },
        packages: packages.map((packageValue, index) => ({
          package: { ...packageValue, ecosystem: 'npm' },
          ...(options.vulnerability && index === 0
            ? { vulnerabilities: [{ id: 'OSV-SYNTHETIC-1' }] }
            : {}),
        })),
      },
    ],
    experimental_config: {
      licenses: { summary: false, allowlist: null },
    },
  });
}

function fallbackFiles(overrides: Partial<Record<'binary' | 'config' | 'lockfile', Uint8Array>> = {}) {
  const calls: string[] = [];
  const readBytes = async (path: string): Promise<Uint8Array> => {
    calls.push(path);
    if (path === OSV_BINARY_PATH) return overrides.binary ?? SYNTHETIC_OSV_BINARY;
    if (path === OSV_CONFIG_PATH) return overrides.config ?? EMPTY_OSV_CONFIG;
    if (path === OSV_LOCKFILE_PATH) return overrides.lockfile ?? SYNTHETIC_LOCKFILE;
    throw new Error('Unexpected synthetic file read');
  };
  return { calls, readBytes };
}

function fallbackOptions(
  osvScript: AuditCommandResult[],
  files = fallbackFiles(),
) {
  const osv = scriptedRunner(osvScript);
  return {
    files,
    osv,
    options: {
      osvRunner: osv.runner,
      readBytes: files.readBytes,
      now: () => new Date('2026-09-04T10:00:00.000Z'),
      osvBinaryPath: OSV_BINARY_PATH,
      osvConfigPath: OSV_CONFIG_PATH,
      lockfilePath: OSV_LOCKFILE_PATH,
      expectedOsvBinarySha256: SYNTHETIC_OSV_SHA256,
      logger: quietLogger,
    },
  };
}

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
  assert.equal(OSV_FALLBACK_POLICY.scannerVersion, '2.5.1');
  assert.equal(OSV_FALLBACK_POLICY.provisionRetryCount, 2);
  assert.ok(OSV_FALLBACK_POLICY.provisionTimeoutMs <= 190_000);
  assert.ok(OSV_FALLBACK_POLICY.scanTimeoutMs <= 180_000);
  assert.ok(
    NPM_AUDIT_POLICY.versionTimeoutMs
      + (2 * NPM_AUDIT_POLICY.maxAttemptsPerScope * NPM_AUDIT_POLICY.attemptTimeoutMs)
      + (2 * (NPM_AUDIT_POLICY.maxAttemptsPerScope - 1) * NPM_AUDIT_POLICY.retryDelayMs)
      < 300_000,
  );
  assert.ok(
    NPM_AUDIT_POLICY.versionTimeoutMs
      + (2 * NPM_AUDIT_POLICY.maxAttemptsPerScope * NPM_AUDIT_POLICY.attemptTimeoutMs)
      + (2 * (NPM_AUDIT_POLICY.maxAttemptsPerScope - 1) * NPM_AUDIT_POLICY.retryDelayMs)
      + OSV_FALLBACK_POLICY.provisionTimeoutMs
      + OSV_FALLBACK_POLICY.versionTimeoutMs
      + OSV_FALLBACK_POLICY.scanTimeoutMs
      < 720_000,
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

test('a complete npm result remains primary even when OSV distribution is unavailable', async () => {
  const npm = scriptedRunner([versionResult(), result(), result()]);
  let osvCalls = 0;
  let provisioningCalls = 0;

  const gateResult = await runDependencySecurityGate({
    runner: npm.runner,
    sleep: async () => undefined,
    logger: quietLogger,
    osvRunner: async () => {
      osvCalls += 1;
      return result();
    },
    osvProvisioner: async () => {
      provisioningCalls += 1;
      throw new Error('synthetic OSV distribution outage');
    },
  });

  assert.deepEqual(gateResult, { source: 'npm' });
  assert.equal(osvCalls, 0);
  assert.equal(provisioningCalls, 0);
});

test('OSV runs only after bounded npm service unavailability and verifies the full lock inventory', async () => {
  const timeout = result({ exitCode: 1, stdout: '', stderr: 'network timeout', timedOut: true });
  const npm = scriptedRunner([versionResult(), timeout, timeout, timeout]);
  const fallback = fallbackOptions([
    osvVersionResult(),
    result({ stdout: osvReport() }),
  ]);

  const gateResult = await runDependencySecurityGate({
    runner: npm.runner,
    sleep: async () => undefined,
    ...fallback.options,
  });

  assert.deepEqual(gateResult, { source: 'osv' });
  assert.equal(npm.calls.length, 4);
  assert.equal(fallback.osv.calls.length, 2);
  assert.deepEqual(fallback.osv.calls[0], {
    args: ['--version'],
    timeoutMs: OSV_FALLBACK_POLICY.versionTimeoutMs,
  });
  assert.deepEqual(fallback.osv.calls[1], {
    args: [
      'scan',
      'source',
      '--offline=false',
      '--all-vulns',
      '--all-packages',
      '--format=json',
      '--verbosity=error',
      `--config=${OSV_CONFIG_PATH}`,
      `--lockfile=${OSV_LOCKFILE_PATH}`,
    ],
    timeoutMs: OSV_FALLBACK_POLICY.scanTimeoutMs,
  });
  assert.deepEqual(fallback.files.calls, [
    OSV_BINARY_PATH,
    OSV_CONFIG_PATH,
    OSV_LOCKFILE_PATH,
    OSV_LOCKFILE_PATH,
  ]);
});

test('the authorized package-lock inventory is complete and deterministic', () => {
  const inventory = parseNpmLockInventory(readFileSync('package-lock.json'));
  assert.equal(inventory.entryCount, 486);
  assert.equal(inventory.coordinates.size, 477);
});

test('npm vulnerabilities, malformed reports and non-transient errors never activate OSV', async () => {
  const cases: Array<{ command: AuditCommandResult; expectedCode: string }> = [
    {
      command: result({ exitCode: 1, stdout: report('low'), stderr: 'service unavailable' }),
      expectedCode: 'VULNERABILITIES_AT_OR_ABOVE_LOW',
    },
    {
      command: result({ exitCode: 1, stdout: 'not-json', stderr: '503 service unavailable' }),
      expectedCode: 'MALFORMED_REPORT',
    },
    {
      command: result({
        exitCode: 1,
        stdout: JSON.stringify({ auditReportVersion: 2 }),
        stderr: 'E503',
      }),
      expectedCode: 'INCOMPLETE_REPORT',
    },
    {
      command: result({ exitCode: 1, stdout: '', stderr: 'E401 authentication required' }),
      expectedCode: 'EMPTY_REPORT',
    },
  ];

  for (const testCase of cases) {
    const npm = scriptedRunner([versionResult(), testCase.command]);
    let osvCalls = 0;
    await expectGateError(
      runDependencySecurityGate({
        runner: npm.runner,
        sleep: async () => undefined,
        logger: quietLogger,
        osvRunner: async () => {
          osvCalls += 1;
          return result();
        },
      }),
      testCase.expectedCode,
    );
    assert.equal(osvCalls, 0);
    assert.equal(npm.calls.length, 2);
  }
});

test('every OSV vulnerability is blocking regardless of severity or scanner exit semantics', async () => {
  const fallback = fallbackOptions([
    osvVersionResult(),
    result({ exitCode: 1, stdout: osvReport({ vulnerability: true }) }),
  ]);

  await expectGateError(runOsvFallback(fallback.options), 'OSV_FINDINGS_DETECTED');
  assert.equal(fallback.osv.calls.length, 2);
  assert.ok(fallback.osv.calls[1].args.includes('--all-vulns'));
  assert.ok(!fallback.osv.calls[1].args.some((arg) => /ignore|allowlist|suppress/i.test(arg)));
});

test('malformed, incomplete and partial OSV reports remain blocking', async () => {
  const cases: Array<{ stdout: string; expectedCode: string }> = [
    { stdout: 'not-json', expectedCode: 'OSV_MALFORMED_REPORT' },
    {
      stdout: JSON.stringify({ results: [] }),
      expectedCode: 'OSV_INCOMPLETE_REPORT',
    },
    {
      stdout: osvReport({ packages: [{ name: 'alpha', version: '1.0.0' }] }),
      expectedCode: 'OSV_INVENTORY_MISMATCH',
    },
  ];

  for (const testCase of cases) {
    const fallback = fallbackOptions([
      osvVersionResult(),
      result({ exitCode: 127, stdout: testCase.stdout }),
    ]);
    await expectGateError(runOsvFallback(fallback.options), testCase.expectedCode);
    assert.equal(fallback.osv.calls.length, 2);
  }
});

test('unavailability of both npm and OSV is blocking and OSV is not retried', async () => {
  const timeout = result({ exitCode: 1, stdout: '', stderr: 'network timeout', timedOut: true });
  const npm = scriptedRunner([versionResult(), timeout, timeout, timeout]);
  const fallback = fallbackOptions([
    osvVersionResult(),
    result({ exitCode: 129, stdout: '', stderr: 'OSV API unavailable' }),
  ]);

  await expectGateError(
    runDependencySecurityGate({
      runner: npm.runner,
      sleep: async () => undefined,
      ...fallback.options,
    }),
    'OSV_SERVICE_UNAVAILABLE',
  );
  assert.equal(fallback.osv.calls.length, 2);
});

test('npm and OSV distribution unavailability remain blocking', async () => {
  const timeout = result({ exitCode: 1, stdout: '', stderr: 'network timeout', timedOut: true });
  const npm = scriptedRunner([versionResult(), timeout, timeout, timeout]);
  let provisioningCalls = 0;

  await expectGateError(
    runDependencySecurityGate({
      runner: npm.runner,
      sleep: async () => undefined,
      logger: quietLogger,
      osvProvisioner: async () => {
        provisioningCalls += 1;
        throw new Error('synthetic OSV distribution outage');
      },
    }),
    'OSV_SCANNER_PROVISIONING_UNAVAILABLE',
  );
  assert.equal(npm.calls.length, 4);
  assert.equal(provisioningCalls, 1);
});

test('OSV provisioning is checksum-pinned and bounded when the distribution is unavailable', async () => {
  const download = scriptedRunner([
    result({ exitCode: 28, stdout: '', stderr: 'network timeout', timedOut: true }),
  ]);

  await expectGateError(
    provisionPinnedOsvScanner({ runner: download.runner, logger: quietLogger }),
    'OSV_SCANNER_PROVISIONING_UNAVAILABLE',
  );
  assert.equal(download.calls.length, 1);
  assert.equal(download.calls[0].timeoutMs, OSV_FALLBACK_POLICY.provisionTimeoutMs);
  assert.ok(download.calls[0].args.includes(OSV_FALLBACK_POLICY.linuxAmd64Url));
  assert.deepEqual(
    download.calls[0].args.slice(
      download.calls[0].args.indexOf('--retry'),
      download.calls[0].args.indexOf('--retry') + 2,
    ),
    ['--retry', String(OSV_FALLBACK_POLICY.provisionRetryCount)],
  );
  assert.deepEqual(
    download.calls[0].args.slice(
      download.calls[0].args.indexOf('--retry-max-time'),
      download.calls[0].args.indexOf('--retry-max-time') + 2,
    ),
    ['--retry-max-time', String(OSV_FALLBACK_POLICY.provisionRetryMaxTimeSeconds)],
  );
});

test('OSV binary and empty configuration provenance are mandatory', async () => {
  assert.equal(
    createHash('sha256').update(EMPTY_OSV_CONFIG).digest('hex'),
    OSV_FALLBACK_POLICY.emptyConfigSha256,
  );

  for (const files of [
    fallbackFiles({ binary: Buffer.from('tampered scanner') }),
    fallbackFiles({ config: Buffer.from('[[IgnoredVulns]]\nid = "OSV-SYNTHETIC-1"\n') }),
  ]) {
    const fallback = fallbackOptions([osvVersionResult()], files);
    await expectGateError(
      runOsvFallback(fallback.options),
      'OSV_SCANNER_PROVENANCE_UNVERIFIABLE',
    );
    assert.equal(fallback.osv.calls.length, 0);
  }
});

test('CI pins the bulk-only npm client and keeps the audit gate blocking', () => {
  const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
  assert.match(workflow, /npm install --global npm@11\.16\.0/);
  assert.match(workflow, /--registry=https:\/\/registry\.npmjs\.org\//);
  assert.match(workflow, /test "\$\(npm --version\)" = "11\.16\.0"/);
  assert.match(workflow, /node --import tsx --test tests\/npm-audit-gate\.test\.ts/);
  assert.match(workflow, /node --import tsx scripts\/npm-audit-gate\.ts/);
  assert.doesNotMatch(workflow, /Provision checksum-verified OSV fallback scanner/);
  assert.doesNotMatch(workflow, /OSV_SCANNER_ASSET_URL/);
  assert.doesNotMatch(workflow, /OSV_SCANNER_BIN=%s/);
  assert.doesNotMatch(workflow, /audits\/quick/);
  assert.doesNotMatch(workflow, /continue-on-error/);
  assert.doesNotMatch(workflow, /allow-failure/);
});
