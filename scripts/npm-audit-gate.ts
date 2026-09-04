import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
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

export const OSV_FALLBACK_POLICY = Object.freeze({
  scannerVersion: '2.5.1',
  releaseCommit: 'c84fa4568f2526d0333e9a914ea8a0a5f74ad68b',
  releasePublishedAt: '2026-08-17T04:29:53Z',
  linuxAmd64Url:
    'https://github.com/google/osv-scanner/releases/download/v2.5.1/osv-scanner_linux_amd64',
  linuxAmd64Sha256: 'f9f25499a2c8cc367b3af45df2ea7eeca7fbccceab9c35079968f4b3652194be',
  apiUrl: 'https://api.osv.dev/',
  emptyConfigSha256: '4c25ee4f56ca2b53807db3ed9c0e36d85a41ba0160d6bcc7f0f1cb9dc0e93136',
  lockfilePath: 'package-lock.json',
  versionTimeoutMs: 10_000,
  scanTimeoutMs: 180_000,
  maxOutputBytes: 32 * 1024 * 1024,
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

export type AuditGateOptions = {
  runner?: AuditCommandRunner;
  sleep?: (delayMs: number) => Promise<void>;
  logger?: AuditLogger;
};

export type AuditFileReader = (path: string) => Promise<Uint8Array>;

export type DependencySecurityGateOptions = AuditGateOptions & {
  osvRunner?: AuditCommandRunner;
  readBytes?: AuditFileReader;
  now?: () => Date;
  osvBinaryPath?: string;
  osvConfigPath?: string;
  lockfilePath?: string;
  expectedOsvBinarySha256?: string;
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

type NpmLockInventory = {
  entryCount: number;
  coordinates: ReadonlySet<string>;
};

type OsvReportValidation =
  | {
      ok: true;
      findingCount: number;
      uniquePackageCount: number;
    }
  | {
      ok: false;
      code:
        | 'OSV_EMPTY_REPORT'
        | 'OSV_MALFORMED_REPORT'
        | 'OSV_INCOMPLETE_REPORT'
        | 'OSV_INVENTORY_MISMATCH';
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

function sha256(contents: Uint8Array): string {
  return createHash('sha256').update(contents).digest('hex');
}

function npmPackageNameFromPath(packagePath: string): string | null {
  const marker = 'node_modules/';
  const markerIndex = packagePath.lastIndexOf(marker);
  if (markerIndex < 0 || packagePath.includes('\\')) return null;

  const tail = packagePath.slice(markerIndex + marker.length);
  const segments = tail.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null;
  if (tail.startsWith('@')) return segments.length === 2 ? tail : null;
  return segments.length === 1 ? tail : null;
}

function inventoryCoordinate(name: string, version: string): string {
  return JSON.stringify([name, version]);
}

export function parseNpmLockInventory(contents: Uint8Array): NpmLockInventory {
  let lockfile: unknown;
  try {
    lockfile = JSON.parse(Buffer.from(contents).toString('utf8'));
  } catch {
    throw new DependencyAuditGateError('OSV_LOCKFILE_INVENTORY_INVALID');
  }

  if (
    !isRecord(lockfile)
    || lockfile.lockfileVersion !== 3
    || !isRecord(lockfile.packages)
    || !isRecord(lockfile.packages[''])
  ) {
    throw new DependencyAuditGateError('OSV_LOCKFILE_INVENTORY_INVALID');
  }

  const coordinates = new Set<string>();
  let entryCount = 0;
  for (const [packagePath, packageValue] of Object.entries(lockfile.packages)) {
    if (packagePath === '') continue;
    const name = npmPackageNameFromPath(packagePath);
    if (!name || !isRecord(packageValue)) {
      throw new DependencyAuditGateError('OSV_LOCKFILE_INVENTORY_INVALID');
    }

    const version = packageValue.version;
    const resolvedUrl = packageValue.resolved;
    const integrity = packageValue.integrity;
    if (
      typeof version !== 'string'
      || version.length === 0
      || /[\u0000-\u001f\u007f]/.test(version)
      || typeof resolvedUrl !== 'string'
      || typeof integrity !== 'string'
      || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity)
      || packageValue.link === true
      || (Object.hasOwn(packageValue, 'name') && packageValue.name !== name)
    ) {
      throw new DependencyAuditGateError('OSV_LOCKFILE_INVENTORY_INVALID');
    }

    let resolvedPackageUrl: URL;
    try {
      resolvedPackageUrl = new URL(resolvedUrl);
    } catch {
      throw new DependencyAuditGateError('OSV_LOCKFILE_INVENTORY_INVALID');
    }
    if (resolvedPackageUrl.origin !== 'https://registry.npmjs.org') {
      throw new DependencyAuditGateError('OSV_LOCKFILE_INVENTORY_INVALID');
    }

    entryCount += 1;
    coordinates.add(inventoryCoordinate(name, version));
  }

  if (entryCount === 0 || coordinates.size === 0) {
    throw new DependencyAuditGateError('OSV_LOCKFILE_INVENTORY_INVALID');
  }
  return { entryCount, coordinates };
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function validateOptionalArray(value: Record<string, unknown>, key: string): unknown[] | null {
  if (!Object.hasOwn(value, key)) return [];
  return Array.isArray(value[key]) ? value[key] : null;
}

export function validateOsvReport(
  stdout: string,
  lockfilePath: string,
  inventory: NpmLockInventory,
): OsvReportValidation {
  const trimmed = stdout.trim();
  if (!trimmed) return { ok: false, code: 'OSV_EMPTY_REPORT' };

  let report: unknown;
  try {
    report = JSON.parse(trimmed);
  } catch {
    return { ok: false, code: 'OSV_MALFORMED_REPORT' };
  }

  if (
    !isRecord(report)
    || !hasOnlyKeys(report, [
      'results',
      'experimental_config',
      'experimental_generic_findings',
      'license_summary',
    ])
    || !Array.isArray(report.results)
    || report.results.length !== 1
    || !isRecord(report.experimental_config)
    || !hasOnlyKeys(report.experimental_config, ['licenses'])
    || !isRecord(report.experimental_config.licenses)
    || !hasOnlyKeys(report.experimental_config.licenses, ['summary', 'allowlist'])
    || report.experimental_config.licenses.summary !== false
    || report.experimental_config.licenses.allowlist !== null
  ) {
    return { ok: false, code: 'OSV_INCOMPLETE_REPORT' };
  }

  const genericFindings = validateOptionalArray(report, 'experimental_generic_findings');
  const licenseSummary = validateOptionalArray(report, 'license_summary');
  if (!genericFindings || !licenseSummary) {
    return { ok: false, code: 'OSV_INCOMPLETE_REPORT' };
  }

  const result = report.results[0];
  if (
    !isRecord(result)
    || !hasOnlyKeys(result, ['source', 'packages', 'experimental_pes'])
    || !isRecord(result.source)
    || !hasOnlyKeys(result.source, ['path', 'type'])
    || result.source.type !== 'lockfile'
    || typeof result.source.path !== 'string'
    || resolve(result.source.path) !== resolve(lockfilePath)
    || !Array.isArray(result.packages)
    || result.packages.length === 0
  ) {
    return { ok: false, code: 'OSV_INCOMPLETE_REPORT' };
  }

  const experimentalPes = validateOptionalArray(result, 'experimental_pes');
  if (!experimentalPes) return { ok: false, code: 'OSV_INCOMPLETE_REPORT' };

  const reportedCoordinates = new Set<string>();
  let findingCount = genericFindings.length + licenseSummary.length + experimentalPes.length;
  for (const packageResult of result.packages) {
    if (
      !isRecord(packageResult)
      || !hasOnlyKeys(packageResult, [
        'package',
        'dependency_groups',
        'vulnerabilities',
        'groups',
        'licenses',
        'license_violations',
      ])
      || !isRecord(packageResult.package)
      || !hasOnlyKeys(packageResult.package, ['name', 'version', 'ecosystem', 'deprecated'])
      || typeof packageResult.package.name !== 'string'
      || typeof packageResult.package.version !== 'string'
      || packageResult.package.ecosystem !== 'npm'
      || (Object.hasOwn(packageResult.package, 'deprecated')
        && typeof packageResult.package.deprecated !== 'boolean')
    ) {
      return { ok: false, code: 'OSV_INCOMPLETE_REPORT' };
    }

    const dependencyGroups = validateOptionalArray(packageResult, 'dependency_groups');
    const vulnerabilities = validateOptionalArray(packageResult, 'vulnerabilities');
    const groups = validateOptionalArray(packageResult, 'groups');
    const licenses = validateOptionalArray(packageResult, 'licenses');
    const licenseViolations = validateOptionalArray(packageResult, 'license_violations');
    if (
      !dependencyGroups
      || dependencyGroups.some((group) => typeof group !== 'string')
      || !vulnerabilities
      || vulnerabilities.some((vulnerability) => (
        !isRecord(vulnerability)
        || typeof vulnerability.id !== 'string'
        || vulnerability.id.length === 0
      ))
      || !groups
      || !licenses
      || !licenseViolations
    ) {
      return { ok: false, code: 'OSV_INCOMPLETE_REPORT' };
    }

    const coordinate = inventoryCoordinate(
      packageResult.package.name,
      packageResult.package.version,
    );
    if (
      reportedCoordinates.has(coordinate)
      || !inventory.coordinates.has(coordinate)
    ) {
      return { ok: false, code: 'OSV_INVENTORY_MISMATCH' };
    }
    reportedCoordinates.add(coordinate);
    findingCount += vulnerabilities.length + groups.length + licenseViolations.length;
    if (packageResult.package.deprecated === true) findingCount += 1;
  }

  if (
    reportedCoordinates.size !== inventory.coordinates.size
    || [...inventory.coordinates].some((coordinate) => !reportedCoordinates.has(coordinate))
  ) {
    return { ok: false, code: 'OSV_INVENTORY_MISMATCH' };
  }

  return {
    ok: true,
    findingCount,
    uniquePackageCount: reportedCoordinates.size,
  };
}

function permitsTransientClassification(stdout: string): boolean {
  const trimmed = stdout.trim();
  if (!trimmed) return true;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return false;
  }
  if (!isRecord(parsed) || !Object.hasOwn(parsed, 'error')) return false;
  return typeof parsed.error === 'string' || isRecord(parsed.error);
}

function transientReason(result: AuditCommandResult): string | null {
  if (result.timedOut) return 'ATTEMPT_TIMEOUT';
  if (result.spawnErrorCode && TRANSIENT_ERROR_CODES.has(result.spawnErrorCode)) {
    return result.spawnErrorCode;
  }
  if (!permitsTransientClassification(result.stdout)) return null;

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

function runCommand(
  executable: string,
  args: readonly string[],
  timeoutMs: number,
  maxOutputBytes: number,
  environment: NodeJS.ProcessEnv,
): Promise<AuditCommandResult> {
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
      child = spawn(executable, [...args], {
        cwd: process.cwd(),
        env: environment,
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
      if (nextBytes > maxOutputBytes) {
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
}

export const runNpmCommand: AuditCommandRunner = async (args, timeoutMs) => {
  const npmExecutable = process.platform === 'win32' ? process.execPath : 'npm';
  const npmArguments = process.platform === 'win32'
    ? [join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'), ...args]
    : [...args];

  return runCommand(
    npmExecutable,
    npmArguments,
    timeoutMs,
    NPM_AUDIT_POLICY.maxOutputBytes,
    {
      ...process.env,
      npm_config_audit_level: 'low',
      npm_config_fetch_retries: '0',
      npm_config_fetch_timeout: String(NPM_AUDIT_POLICY.npmFetchTimeoutMs),
      npm_config_fund: 'false',
      npm_config_loglevel: 'error',
      npm_config_update_notifier: 'false',
    },
  );
};

function createOsvCommandRunner(binaryPath: string): AuditCommandRunner {
  return (args, timeoutMs) => runCommand(
    binaryPath,
    args,
    timeoutMs,
    OSV_FALLBACK_POLICY.maxOutputBytes,
    process.env,
  );
}

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

async function verifyOsvScanner(
  binaryPath: string,
  configPath: string,
  expectedBinarySha256: string,
  runner: AuditCommandRunner,
  readBytes: AuditFileReader,
): Promise<void> {
  if (!isAbsolute(binaryPath) || !isAbsolute(configPath)) {
    throw new DependencyAuditGateError('OSV_SCANNER_CONFIGURATION_INVALID');
  }

  let binary: Uint8Array;
  let config: Uint8Array;
  try {
    binary = await readBytes(binaryPath);
    config = await readBytes(configPath);
  } catch {
    throw new DependencyAuditGateError('OSV_SCANNER_PROVENANCE_UNVERIFIABLE');
  }

  if (
    !/^[a-f0-9]{64}$/.test(expectedBinarySha256)
    || sha256(binary) !== expectedBinarySha256
    || sha256(config) !== OSV_FALLBACK_POLICY.emptyConfigSha256
  ) {
    throw new DependencyAuditGateError('OSV_SCANNER_PROVENANCE_UNVERIFIABLE');
  }

  const versionResult = await runner(['--version'], OSV_FALLBACK_POLICY.versionTimeoutMs);
  const versionLines = `${versionResult.stdout}\n${versionResult.stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim());
  if (
    versionResult.timedOut
    || versionResult.outputOverflow
    || versionResult.spawnErrorCode
    || versionResult.exitCode !== 0
    || !versionLines.includes(`osv-scanner version: ${OSV_FALLBACK_POLICY.scannerVersion}`)
  ) {
    throw new DependencyAuditGateError('OSV_SCANNER_VERSION_UNVERIFIABLE');
  }
}

export async function runOsvFallback(
  options: Omit<DependencySecurityGateOptions, 'runner' | 'sleep'> = {},
): Promise<{ uniquePackageCount: number }> {
  const logger = options.logger ?? console;
  const readBytes = options.readBytes ?? readFile;
  const now = options.now ?? (() => new Date());
  const binaryPath = options.osvBinaryPath ?? process.env.OSV_SCANNER_BIN ?? '';
  const configPath = options.osvConfigPath ?? process.env.OSV_SCANNER_CONFIG ?? '';
  const lockfilePath = resolve(options.lockfilePath ?? OSV_FALLBACK_POLICY.lockfilePath);
  const expectedBinarySha256 = options.expectedOsvBinarySha256
    ?? OSV_FALLBACK_POLICY.linuxAmd64Sha256;
  const runner = options.osvRunner ?? createOsvCommandRunner(binaryPath);

  await verifyOsvScanner(
    binaryPath,
    configPath,
    expectedBinarySha256,
    runner,
    readBytes,
  );
  logger.log(
    `[dependency-audit] client=osv-scanner@${OSV_FALLBACK_POLICY.scannerVersion} `
      + `status=verified assetSha256=${expectedBinarySha256} `
      + `releaseCommit=${OSV_FALLBACK_POLICY.releaseCommit}`,
  );

  let lockfileBefore: Uint8Array;
  try {
    lockfileBefore = await readBytes(lockfilePath);
  } catch {
    throw new DependencyAuditGateError('OSV_LOCKFILE_UNAVAILABLE');
  }
  const lockfileSha256 = sha256(lockfileBefore);
  const inventory = parseNpmLockInventory(lockfileBefore);
  const queryStartedAt = now().toISOString();
  logger.log(
    `[dependency-audit] source=osv status=query api=${OSV_FALLBACK_POLICY.apiUrl} `
      + `queryStartedAt=${queryStartedAt} lockfileSha256=${lockfileSha256} `
      + `inventoryEntries=${inventory.entryCount} uniquePackages=${inventory.coordinates.size}`,
  );

  const result = await runner(
    [
      'scan',
      'source',
      '--offline=false',
      '--all-vulns',
      '--all-packages',
      '--format=json',
      '--verbosity=error',
      `--config=${configPath}`,
      `--lockfile=${lockfilePath}`,
    ],
    OSV_FALLBACK_POLICY.scanTimeoutMs,
  );

  let lockfileAfter: Uint8Array;
  try {
    lockfileAfter = await readBytes(lockfilePath);
  } catch {
    throw new DependencyAuditGateError('OSV_LOCKFILE_UNAVAILABLE');
  }
  if (sha256(lockfileAfter) !== lockfileSha256) {
    throw new DependencyAuditGateError('OSV_LOCKFILE_CHANGED_DURING_SCAN');
  }

  if (result.outputOverflow) {
    throw new DependencyAuditGateError('OSV_OUTPUT_LIMIT_EXCEEDED');
  }
  if (result.timedOut || result.exitCode === 129) {
    throw new DependencyAuditGateError('OSV_SERVICE_UNAVAILABLE');
  }
  if (result.spawnErrorCode) {
    throw new DependencyAuditGateError('OSV_SCANNER_EXECUTION_FAILED');
  }

  const validation = validateOsvReport(result.stdout, lockfilePath, inventory);
  if (!validation.ok) throw new DependencyAuditGateError(validation.code);
  if (validation.findingCount > 0) {
    throw new DependencyAuditGateError('OSV_FINDINGS_DETECTED');
  }
  if (result.exitCode !== 0) {
    throw new DependencyAuditGateError('OSV_RESULT_EXIT_MISMATCH');
  }

  logger.log(
    `[dependency-audit] source=osv status=pass api=${OSV_FALLBACK_POLICY.apiUrl} `
      + `queryStartedAt=${queryStartedAt} queryCompletedAt=${now().toISOString()} `
      + `lockfileSha256=${lockfileSha256} inventoryEntries=${inventory.entryCount} `
      + `uniquePackages=${validation.uniquePackageCount} findings=0`,
  );
  return { uniquePackageCount: validation.uniquePackageCount };
}

export async function runDependencySecurityGate(
  options: DependencySecurityGateOptions = {},
): Promise<{ source: 'npm' | 'osv' }> {
  const logger = options.logger ?? console;
  try {
    await runDependencyAuditGate({
      runner: options.runner,
      sleep: options.sleep,
      logger,
    });
    return { source: 'npm' };
  } catch (error) {
    if (
      !(error instanceof DependencyAuditGateError)
      || error.code !== 'AUDIT_SERVICE_UNAVAILABLE'
    ) {
      throw error;
    }
    logger.warn(
      '[dependency-audit] primary=npm status=service-unavailable fallback=osv status=start',
    );
  }

  await runOsvFallback(options);
  return { source: 'osv' };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  runDependencySecurityGate().catch((error: unknown) => {
    const failure = error instanceof DependencyAuditGateError
      ? error
      : new DependencyAuditGateError('UNEXPECTED_GATE_FAILURE');
    const scope = failure.scope ? ` scope=${failure.scope}` : '';
    const attempt = failure.attempt ? ` attempt=${failure.attempt}` : '';
    console.error(`[dependency-audit] status=fail code=${failure.code}${scope}${attempt}`);
    process.exitCode = 1;
  });
}
