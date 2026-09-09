import assert from 'node:assert/strict';
import test from 'node:test';
import { npmAuditPublicDiagnostics } from '../scripts/npm-audit-public-diagnostics';

test('npm audit diagnostics expose only public package, version, advisory and fix fields', () => {
  const report = JSON.stringify({
    auditReportVersion: 2,
    vulnerabilities: {
      synthetic: {
        name: 'synthetic', range: '<2.0.0',
        via: [{ source: 12345, url: 'https://github.com/advisories/GHSA-xxxx-yyyy-zzzz' }],
        fixAvailable: { name: 'synthetic', version: '2.0.0', isSemVerMajor: true },
      },
    },
  });
  const lock = JSON.stringify({ lockfileVersion: 3, packages: {
    '': { name: 'fixture' },
    'node_modules/synthetic': { version: '1.2.3', resolved: 'https://registry.npmjs.org/synthetic/-/synthetic-1.2.3.tgz' },
  } });
  assert.deepEqual(npmAuditPublicDiagnostics(report, lock), [{
    package: 'synthetic', installedVersions: ['1.2.3'], affectedRange: '<2.0.0',
    advisoryReferences: ['https://github.com/advisories/GHSA-xxxx-yyyy-zzzz', 'npm:12345'],
    fixAvailable: { package: 'synthetic', version: '2.0.0', semverMajor: true },
  }]);
  assert.doesNotMatch(JSON.stringify(npmAuditPublicDiagnostics(report, lock)), /resolved|registry/u);
});

test('npm audit diagnostics reject malformed or unsafe public fields', () => {
  assert.throws(() => npmAuditPublicDiagnostics(JSON.stringify({
    auditReportVersion: 2,
    vulnerabilities: { synthetic: { name: 'synthetic', range: '<2', via: [], fixAvailable: false, secret: 'not-read' } },
  }), JSON.stringify({ lockfileVersion: 2, packages: {} })), /NPM_AUDIT_DIAGNOSTIC_INPUT_INVALID/u);
});
