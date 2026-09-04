import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const NPM_AUDIT_POLICY = Object.freeze({
  npmVersion: '11.16.0',
  registryUrl: 'https://registry.npmjs.org/',
  maxAttemptsPerScope: 3,
  attemptTimeoutMs: 40_000,
  versionTimeoutMs: 10_000,
  retryDelayMs: 2_000,
  npmFetchTimeoutMs: 30_000,
  maxOutputBytes: 16 * 1024 * 1024,
});

export type AuditScope = 'runtime' | 'complete';

export type AuditCommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputOverflow: boolean;
  spawnErrorCode?: string;
};

export type AuditCommandRunner = (
  args: readonly string[],
  timeoutMs: number,
) => Promise<AuditCommandResult>;

type AuditLogger = Pick<Console, 'log' | 'warn'>;

type AuditGateOptions = {
  runner?: AuditCommandRunner;
  sleep?: (delayMs: number) => Promise<void>;
  logger?: AuditLogger;
};

type VulnerabilitySeverity = 'info' | 'low' | 'moderate' | 'high' | 'critical';

type AuditSummary = {
  scope: AuditScope;
  attempt: number;
  totalVulnerabilities: number;
  thresholdVulnerabilities: number;
  totalDependencies: number;
};

type ReportValidation =
  | { ok: true; summary: Omit<AuditSummary, 'scope' | 'attempt'> }
  | {
      ok: false;
      code:
        | 'EMPTY_REPORT'
        | 'MALFORMED_REPORT'
        | 'INCOMPLETE_REPORT'
        | 'UNSUPPORTED_REPORT_VERSION'
        | 'INCONSISTENT_REPORT';
    };

const AUDIT_SCOPES: ReadonlyArray<{ scope: AuditScope; args: readonly string[] }> = [
  {
    scope: 'runtime',
    args: [
      'audit',
      '--omit=dev',
      '--include=prod',
      '--include=optional',
      '--include=peer',
      '--audit-level=low',
      '--json',
      `--registry=${NPM_AUDIT_POLICY.registryUrl}`,
      '--offline=false',
      '--prefer-online=true',
      '--fetch-retries=0',
      `--fetch-timeout=${NPM_AUDIT_POLICY.npmFetchTimeoutMs}`,
    ],
  },
  {
    scope: 'complete',
    args: [
      'audit',
      '--include=prod',
      '--include=dev',
      '--include=optional',
      '--include=peer',
      '--audit-level=low',
      '--json',
      `--registry=${NPM_AUDIT_POLICY.registryUrl}`,
      '--offline=false',
      '--prefer-online=true',
      '--fetch-retries=0',
      `--fetch-timeout=${NPM_AUDIT_POLICY.npmFetchTimeoutMs}`,
    ],
  },
];

const SEVERITIES: readonly VulnerabilitySeverity[] = [
  'info',
  'low',
  'moderate',
  'high',
  'critical',
];

const THRESHOLD_SEVERITIES: readonly VulnerabilitySeverity[] = [
  'low',
  'moderate',
  'high',
  'critical',
];

const TRANSIENT_ERROR_CODES = new Set([
  'EAI_AGAIN',
  'E408',
  'E429',
  'E500',
  'E502',
  'E503',
  'E504',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'ENOTFOUND',
  'ETIMEDOUT',
  'ERR_DNS_TIMED_OUT',
  'ERR_SOCKET_CONNECTION_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

const TRANSIENT_PATTERNS: ReadonlyArray<{ code: string; pattern: RegExp }> = [
  { code: 'NETWORK_TIMEOUT', pattern: /\b(?:network|request|socket)\s+time(?:d\s*out|out)\b/i },
  { code: 'FETCH_FAILED', pattern: /\bfetch\s+failed\b/i },
  { code: 'SOCKET_HANG_UP', pattern: /\bsocket\s+hang\s+up\b/i },
  { code: 'RATE_LIMIT', pattern: /\b(?:rate\s*limit(?:ed)?|too\s+many\s+requests)\b/i },
  { code: 'HTTP_408', pattern: /\b(?:http|status(?:\s+code)?|statusCode)\s*[:=]?\s*408\b/i },
  { code: 'HTTP_429', pattern: /\b(?:http|status(?:\s+code)?|statusCode)\s*[:=]?\s*429\b/i },
  { code: 'HTTP_500', pattern: /\b(?:http|status(?:\s+code)?|statusCode)\s*[:=]?\s*500\b/i },
  { code: 'HTTP_502', pattern: /\b(?:http|status(?:\s+code)?|statusCode)\s*[:=]?\s*502\b/i },
  { code: 'HTTP_503', pattern: /\b(?:http|status(?:\s+code)?|statusCode)\s*[:=]?\s*503\b/i },
  { code: 'HTTP_504', pattern: /\b(?:http|status(?:\s+code)?|statusCode)\s*[:=]?\s*504\b/i },
  { code: 'BAD_GATEWAY', pattern: /\bbad\s+gateway\b/i },
  { code: 'SERVICE_UNAVAILABLE', pattern: /\b(?:service|temporarily)\s+unavailable\b/i },
  { code: 'GATEWAY_TIMEOUT', pattern: /\bgateway\s+time(?:d\s*out|out)\b/i },
];

const LEGACY_ENDPOINT_PATTERN = /(?:\/-\/npm\/v1\/security)?\/audits\/quick\b/i;

export class DependencyAuditGateError extends Error {
  readonly code: string;
  readonly scope?: AuditScope;
  readonly attempt?: number;

  constructor(code: string, scope?: AuditScope, attempt?: number) {
    super(code);
    this.name = 'DependencyAuditGateError';
    this.code = code;
    this.scope = scope;
    this.attempt = attempt;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

export function validateAuditReport(stdout: string): ReportValidation {
  const trimmed = stdout.trim();
  if (!trimmed) return { ok: false, code: 'EMPTY_REPORT' };

  let report: unknown;
  try {
    report = JSON.parse(trimmed);
  } catch {
    return { ok: false, code: 'MALFORMED_REPORT' };
  }

  if (!isRecord(report)) return { ok: false, code: 'INCOMPLETE_REPORT' };
  if (report.auditReportVersion !== 2) {
    return { ok: false, code: 'UNSUPPORTED_REPORT_VERSION' };
  }
  if (!isRecord(report.vulnerabilities) || !isRecord(report.metadata)) {
    return { ok: false, code: 'INCOMPLETE_REPORT' };
  }

  const counts = report.metadata.vulnerabilities;
  const dependencies = report.metadata.dependencies;
  if (!isRecord(counts) || !isRecord(dependencies)) {
    return { ok: false, code: 'INCOMPLETE_REPORT' };
  }

  for (const severity of [...SEVERITIES, 'total'] as const) {
    if (!isNonNegativeInteger(counts[severity])) {
      return { ok: false, code: 'INCOMPLETE_REPORT' };
    }
  }
  for (const dependencyType of ['prod', 'dev', 'optional', 'peer', 'peerOptional', 'total'] as const) {
    if (!isNonNegativeInteger(dependencies[dependencyType])) {
      return { ok: false, code: 'INCOMPLETE_REPORT' };
    }
  }
  const reportedTotalVulnerabilities = counts.total as number;
  const reportedTotalDependencies = dependencies.total as number;
  if (reportedTotalDependencies === 0) {
    return { ok: false, code: 'INCONSISTENT_REPORT' };
  }

  const calculatedCounts: Record<VulnerabilitySeverity, number> = {
    info: 0,
    low: 0,
    moderate: 0,
    high: 0,
    critical: 0,
  };
  const vulnerabilityEntries = Object.entries(report.vulnerabilities);
  for (const [packageName, value] of vulnerabilityEntries) {
    if (
      !isRecord(value)
      || value.name !== packageName
      || typeof value.severity !== 'string'
      || !SEVERITIES.includes(value.severity as VulnerabilitySeverity)
      || typeof value.isDirect !== 'boolean'
      || !Array.isArray(value.via)
      || !Array.isArray(value.effects)
      || typeof value.range !== 'string'
      || !Array.isArray(value.nodes)
      || !Object.hasOwn(value, 'fixAvailable')
    ) {
      return { ok: false, code: 'INCOMPLETE_REPORT' };
    }
    calculatedCounts[value.severity as VulnerabilitySeverity] += 1;
  }

  const calculatedTotal = SEVERITIES.reduce((total, severity) => total + calculatedCounts[severity], 0);
  if (calculatedTotal !== vulnerabilityEntries.length || calculatedTotal !== reportedTotalVulnerabilities) {
    return { ok: false, code: 'INCONSISTENT_REPORT' };
  }
  for (const severity of SEVERITIES) {
    if (calculatedCounts[severity] !== counts[severity]) {
      return { ok: false, code: 'INCONSISTENT_REPORT' };
    }
  }

  const thresholdVulnerabilities = THRESHOLD_SEVERITIES.reduce(
    (total, severity) => total + calculatedCounts[severity],
    0,
  );

  return {
    ok: true,
    summary: {
      totalVulnerabilities: calculatedTotal,
      thresholdVulnerabilities,
      totalDependencies: reportedTotalDependencies,
    },
  };
}

function transientReason(result: AuditCommandResult): string | null {
  if (result.timedOut) return 'ATTEMPT_TIMEOUT';
  if (result.spawnErrorCode && TRANSIENT_ERROR_CODES.has(result.spawnErrorCode)) {
    return result.spawnErrorCode;
  }

  const output = `${result.stdout}\n${result.stderr}`;
  for (const code of TRANSIENT_ERROR_CODES) {
    if (new RegExp(`\\b${code}\\b`, 'i').test(output)) return code;
  }
  for (const transient of TRANSIENT_PATTERNS) {
    if (transient.pattern.test(output)) return transient.code;
  }
  return null;
}

function hasLegacyEndpoint(result: AuditCommandResult): boolean {
  return LEGACY_ENDPOINT_PATTERN.test(`${result.stdout}\n${result.stderr}`);
}

function safeSpawnErrorCode(error: unknown): string {
  if (!isRecord(error) || typeof error.code !== 'string') return 'UNKNOWN';
  if (TRANSIENT_ERROR_CODES.has(error.code) || error.code === 'ENOENT') return error.code;
  return 'UNKNOWN';
}

export const runNpmCommand: AuditCommandRunner = async (args, timeoutMs) => {
  const npmExecutable = process.platform === 'win32' ? process.execPath : 'npm';
  const npmArguments = process.platform === 'win32'
    ? [join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'), ...args]
    : [...args];

  return new Promise<AuditCommandResult>((finish) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let outputOverflow = false;
    let settled = false;
    const timers: { forceKill?: NodeJS.Timeout; timeout?: NodeJS.Timeout } = {};

    const complete = (result: AuditCommandResult) => {
      if (settled) return;
      settled = true;
      if (timers.timeout) clearTimeout(timers.timeout);
      if (timers.forceKill) clearTimeout(timers.forceKill);
      finish(result);
    };

    let child;
    try {
      child = spawn(npmExecutable, npmArguments, {
        cwd: process.cwd(),
        env: {
          ...process.env,
          npm_config_audit_level: 'low',
          npm_config_fetch_retries: '0',
          npm_config_fetch_timeout: String(NPM_AUDIT_POLICY.npmFetchTimeoutMs),
          npm_config_fund: 'false',
          npm_config_loglevel: 'error',
          npm_config_update_notifier: 'false',
        },
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      complete({
        exitCode: null,
        stdout,
        stderr,
        timedOut,
        outputOverflow,
        spawnErrorCode: safeSpawnErrorCode(error),
      });
      return;
    }

    const appendOutput = (target: 'stdout' | 'stderr', chunk: Buffer) => {
      if (outputOverflow) return;
      const text = chunk.toString('utf8');
      const nextBytes = Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + Buffer.byteLength(text);
      if (nextBytes > NPM_AUDIT_POLICY.maxOutputBytes) {
        outputOverflow = true;
        child.kill('SIGKILL');
        return;
      }
      if (target === 'stdout') stdout += text;
      else stderr += text;
    };

    child.stdout.on('data', (chunk: Buffer) => appendOutput('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => appendOutput('stderr', chunk));
    child.once('error', (error) => {
      complete({
        exitCode: null,
        stdout,
        stderr,
        timedOut,
        outputOverflow,
        spawnErrorCode: safeSpawnErrorCode(error),
      });
    });
    child.once('close', (exitCode) => {
      complete({ exitCode, stdout, stderr, timedOut, outputOverflow });
    });

    timers.timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      timers.forceKill = setTimeout(() => child.kill('SIGKILL'), 1_000);
    }, timeoutMs);
  });
};

const wait = (delayMs: number) => new Promise<void>((resolveDelay) => setTimeout(resolveDelay, delayMs));

async function verifyPinnedNpm(runner: AuditCommandRunner): Promise<void> {
  const result = await runner(['--version'], NPM_AUDIT_POLICY.versionTimeoutMs);
  if (
    result.timedOut
    || result.outputOverflow
    || result.spawnErrorCode
    || result.exitCode !== 0
    || result.stderr.trim()
    || result.stdout.trim() !== NPM_AUDIT_POLICY.npmVersion
  ) {
    throw new DependencyAuditGateError('NPM_CLIENT_VERSION_UNVERIFIABLE');
  }
}

async function auditScope(
  scope: AuditScope,
  args: readonly string[],
  runner: AuditCommandRunner,
  sleep: (delayMs: number) => Promise<void>,
  logger: AuditLogger,
): Promise<AuditSummary> {
  for (let attempt = 1; attempt <= NPM_AUDIT_POLICY.maxAttemptsPerScope; attempt += 1) {
    const result = await runner(args, NPM_AUDIT_POLICY.attemptTimeoutMs);

    if (hasLegacyEndpoint(result)) {
      throw new DependencyAuditGateError('LEGACY_AUDIT_ENDPOINT_FORBIDDEN', scope, attempt);
    }
    if (result.outputOverflow) {
      throw new DependencyAuditGateError('AUDIT_OUTPUT_LIMIT_EXCEEDED', scope, attempt);
    }

    const validation = result.timedOut
      ? ({ ok: false, code: 'EMPTY_REPORT' } as const)
      : validateAuditReport(result.stdout);

    if (validation.ok) {
      if (validation.summary.thresholdVulnerabilities > 0) {
        throw new DependencyAuditGateError('VULNERABILITIES_AT_OR_ABOVE_LOW', scope, attempt);
      }
      if (result.spawnErrorCode || result.exitCode !== 0) {
        throw new DependencyAuditGateError('AUDIT_RESULT_EXIT_MISMATCH', scope, attempt);
      }
      logger.log(
        `[dependency-audit] scope=${scope} status=pass attempt=${attempt} `
          + `thresholdVulnerabilities=0 totalDependencies=${validation.summary.totalDependencies}`,
      );
      return { scope, attempt, ...validation.summary };
    }

    const retryCode = transientReason(result);
    if (retryCode && attempt < NPM_AUDIT_POLICY.maxAttemptsPerScope) {
      logger.warn(
        `[dependency-audit] scope=${scope} status=retry attempt=${attempt}/`
          + `${NPM_AUDIT_POLICY.maxAttemptsPerScope} reason=${retryCode}`,
      );
      await sleep(NPM_AUDIT_POLICY.retryDelayMs);
      continue;
    }
    if (retryCode) {
      throw new DependencyAuditGateError('AUDIT_SERVICE_UNAVAILABLE', scope, attempt);
    }
    if (result.spawnErrorCode) {
      throw new DependencyAuditGateError('NPM_CLIENT_EXECUTION_FAILED', scope, attempt);
    }
    throw new DependencyAuditGateError(validation.code, scope, attempt);
  }

  throw new DependencyAuditGateError('AUDIT_ATTEMPT_BOUND_EXCEEDED', scope);
}

export async function runDependencyAuditGate(options: AuditGateOptions = {}): Promise<AuditSummary[]> {
  const runner = options.runner ?? runNpmCommand;
  const sleep = options.sleep ?? wait;
  const logger = options.logger ?? console;

  await verifyPinnedNpm(runner);
  logger.log(`[dependency-audit] client=npm@${NPM_AUDIT_POLICY.npmVersion} status=verified`);

  const summaries: AuditSummary[] = [];
  for (const audit of AUDIT_SCOPES) {
    summaries.push(await auditScope(audit.scope, audit.args, runner, sleep, logger));
  }
  return summaries;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  runDependencyAuditGate().catch((error: unknown) => {
    const failure = error instanceof DependencyAuditGateError
      ? error
      : new DependencyAuditGateError('UNEXPECTED_GATE_FAILURE');
    const scope = failure.scope ? ` scope=${failure.scope}` : '';
    const attempt = failure.attempt ? ` attempt=${failure.attempt}` : '';
    console.error(`[dependency-audit] status=fail code=${failure.code}${scope}${attempt}`);
    process.exitCode = 1;
  });
}
