import { readFileSync } from 'node:fs';

type PublicDiagnostic = Readonly<{
  package: string;
  installedVersions: readonly string[];
  affectedRange: string;
  advisoryReferences: readonly string[];
  fixAvailable: boolean | Readonly<{ package: string; version: string; semverMajor: boolean }>;
}>;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function safeText(value: unknown, pattern: RegExp, maximum: number): string | null {
  return typeof value === 'string' && value.length <= maximum && pattern.test(value) ? value : null;
}

export function npmAuditPublicDiagnostics(reportText: string, lockText: string): PublicDiagnostic[] {
  const report = record(JSON.parse(reportText));
  const lock = record(JSON.parse(lockText));
  const vulnerabilities = record(report?.vulnerabilities);
  const packages = record(lock?.packages);
  if (report?.auditReportVersion !== 2 || !vulnerabilities || lock?.lockfileVersion !== 3 || !packages) {
    throw new Error('NPM_AUDIT_DIAGNOSTIC_INPUT_INVALID');
  }

  const installed = new Map<string, Set<string>>();
  for (const [path, value] of Object.entries(packages)) {
    if (!path.includes('node_modules/')) continue;
    const item = record(value);
    const tail = path.slice(path.lastIndexOf('node_modules/') + 13);
    const name = tail.startsWith('@') ? tail.split('/').slice(0, 2).join('/') : tail.split('/')[0];
    const version = safeText(item?.version, /^[0-9A-Za-z.+_-]+$/u, 80);
    if (!name || !version) continue;
    const versions = installed.get(name) ?? new Set<string>();
    versions.add(version);
    installed.set(name, versions);
  }

  return Object.entries(vulnerabilities).map(([name, raw]) => {
    const vulnerability = record(raw);
    const packageName = safeText(name, /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/iu, 214);
    const affectedRange = safeText(vulnerability?.range, /^[0-9A-Za-z*<>=|~^., +_-]+$/u, 240);
    if (!vulnerability || vulnerability.name !== name || !packageName || !affectedRange
      || !Array.isArray(vulnerability.via)) throw new Error('NPM_AUDIT_DIAGNOSTIC_INPUT_INVALID');
    const advisoryReferences = vulnerability.via.flatMap((entry) => {
      const advisory = record(entry);
      if (!advisory) return [];
      const source = typeof advisory.source === 'number' && Number.isSafeInteger(advisory.source)
        ? `npm:${advisory.source}` : null;
      const url = safeText(advisory.url, /^https:\/\/[A-Za-z0-9./?&=_:%#~-]+$/u, 500);
      return [source, url].filter((value): value is string => value !== null);
    }).sort();
    const rawFix = vulnerability.fixAvailable;
    let fixAvailable: PublicDiagnostic['fixAvailable'];
    if (typeof rawFix === 'boolean') {
      fixAvailable = rawFix;
    } else {
      const fix = record(rawFix);
      const fixName = safeText(fix?.name, /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/iu, 214);
      const version = safeText(fix?.version, /^[0-9A-Za-z.+_-]+$/u, 80);
      if (!fix || !fixName || !version || typeof fix.isSemVerMajor !== 'boolean') {
        throw new Error('NPM_AUDIT_DIAGNOSTIC_INPUT_INVALID');
      }
      fixAvailable = { package: fixName, version, semverMajor: fix.isSemVerMajor };
    }
    return Object.freeze({
      package: packageName,
      installedVersions: Object.freeze([...(installed.get(packageName) ?? [])].sort()),
      affectedRange,
      advisoryReferences: Object.freeze([...new Set(advisoryReferences)]),
      fixAvailable: fixAvailable && Object.freeze(fixAvailable),
    });
  }).sort((left, right) => left.package.localeCompare(right.package));
}

const DIAGNOSTIC_CODES = Object.freeze({
  ARGUMENT: 'ARGUMENT_INVALID',
  REPORT: 'REPORT_UNAVAILABLE_OR_INVALID',
  LOCK: 'LOCKFILE_UNAVAILABLE_OR_INVALID',
  CONTENT: 'PUBLIC_FINDING_INVALID',
} as const);

if (process.argv[1]?.endsWith('npm-audit-public-diagnostics.ts')) {
  let code: typeof DIAGNOSTIC_CODES[keyof typeof DIAGNOSTIC_CODES] = DIAGNOSTIC_CODES.CONTENT;
  try {
    const [reportPath, lockPath, scope] = process.argv.slice(2);
    if (!reportPath || !lockPath || !['runtime', 'complete'].includes(scope)) {
      code = DIAGNOSTIC_CODES.ARGUMENT;
      throw new Error('NPM_AUDIT_DIAGNOSTIC_ARGUMENT_INVALID');
    }
    code = DIAGNOSTIC_CODES.REPORT;
    const reportText = readFileSync(reportPath, 'utf8');
    JSON.parse(reportText);
    code = DIAGNOSTIC_CODES.LOCK;
    const lockText = readFileSync(lockPath, 'utf8');
    JSON.parse(lockText);
    code = DIAGNOSTIC_CODES.CONTENT;
    const diagnostics = npmAuditPublicDiagnostics(
      reportText, lockText,
    );
    for (const diagnostic of diagnostics) {
      process.stdout.write(`[dependency-audit-diagnostic] scope=${scope} finding=${JSON.stringify(diagnostic)}\n`);
    }
    if (diagnostics.length === 0) {
      process.stdout.write(`[dependency-audit-diagnostic] scope=${scope} status=no-public-findings\n`);
    }
  } catch {
    const scope = ['runtime', 'complete'].includes(process.argv[4] ?? '') ? process.argv[4] : 'invalid';
    process.stdout.write(`[dependency-audit-diagnostic] scope=${scope} status=unavailable code=${code}\n`);
  }
}
