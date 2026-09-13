import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { npmAuditPublicDiagnostics } from '../scripts/npm-audit-public-diagnostics';

test('npm audit diagnostics expose only public package, version, advisory and all valid fix forms', () => {
  const report = JSON.stringify({
    auditReportVersion: 2,
    vulnerabilities: {
      fixed_object: {
        name: 'fixed_object', range: '<2.0.0',
        via: [{ source: 12345, url: 'https://github.com/advisories/GHSA-xxxx-yyyy-zzzz' }],
        fixAvailable: { name: 'fixed_object', version: '2.0.0', isSemVerMajor: true },
      },
      fixed_unspecified: {
        name: 'fixed_unspecified', range: '<3.0.0', via: [], fixAvailable: true,
      },
      no_fix: {
        name: 'no_fix', range: '*', via: [], fixAvailable: false,
      },
    },
  });
  const lock = JSON.stringify({ lockfileVersion: 3, packages: {
    '': { name: 'fixture' },
    'node_modules/fixed_object': { version: '1.2.3' },
    'node_modules/fixed_unspecified': { version: '2.1.0' },
    'node_modules/no_fix': { version: '4.0.0' },
  } });
  assert.deepEqual(npmAuditPublicDiagnostics(report, lock), [{
    package: 'fixed_object', installedVersions: ['1.2.3'], affectedRange: '<2.0.0',
    advisoryReferences: ['https://github.com/advisories/GHSA-xxxx-yyyy-zzzz', 'npm:12345'],
    fixAvailable: { package: 'fixed_object', version: '2.0.0', semverMajor: true },
  }, {
    package: 'fixed_unspecified', installedVersions: ['2.1.0'], affectedRange: '<3.0.0',
    advisoryReferences: [], fixAvailable: true,
  }, {
    package: 'no_fix', installedVersions: ['4.0.0'], affectedRange: '*',
    advisoryReferences: [], fixAvailable: false,
  }]);
  assert.doesNotMatch(JSON.stringify(npmAuditPublicDiagnostics(report, lock)), /resolved|registry/u);
});

test('npm audit diagnostics reject malformed or unsafe public fields', () => {
  assert.throws(() => npmAuditPublicDiagnostics(JSON.stringify({
    auditReportVersion: 2,
    vulnerabilities: { synthetic: { name: 'synthetic', range: '<2', via: [], fixAvailable: false, secret: 'not-read' } },
  }), JSON.stringify({ lockfileVersion: 2, packages: {} })), /NPM_AUDIT_DIAGNOSTIC_INPUT_INVALID/u);
});

test('npm audit CLI reports finite reason codes without echoing invalid input', () => {
  const directory = mkdtempSync(join(tmpdir(), 'npm-audit-diagnostic-'));
  const reportPath = join(directory, 'report.json');
  const lockPath = join(directory, 'lock.json');
  const invoke = () => spawnSync(process.execPath, [
    '--import', 'tsx', 'scripts/npm-audit-public-diagnostics.ts',
    reportPath, lockPath, 'runtime',
  ], { cwd: process.cwd(), encoding: 'utf8' });
  try {
    writeFileSync(reportPath, 'not-json-secret-marker');
    writeFileSync(lockPath, JSON.stringify({ lockfileVersion: 3, packages: {} }));
    let result = invoke();
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '[dependency-audit-diagnostic] scope=runtime status=unavailable code=REPORT_UNAVAILABLE_OR_INVALID\n');
    assert.doesNotMatch(result.stdout, /secret-marker/u);

    writeFileSync(reportPath, JSON.stringify({ auditReportVersion: 2, vulnerabilities: {} }));
    writeFileSync(lockPath, 'not-json-private-marker');
    result = invoke();
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '[dependency-audit-diagnostic] scope=runtime status=unavailable code=LOCKFILE_UNAVAILABLE_OR_INVALID\n');
    assert.doesNotMatch(result.stdout, /private-marker/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
