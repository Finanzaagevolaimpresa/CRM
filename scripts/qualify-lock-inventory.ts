import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DependencyAuditGateError, NPM_AUDIT_POLICY, parseNpmLockInventory, provisionPinnedOsvScanner, runDependencyAuditGate, runOsvFallback } from './npm-audit-gate';

async function main() {
  const inventory = parseNpmLockInventory(readFileSync('package-lock.json'));
  const scanner = await provisionPinnedOsvScanner();
  const scannerOptions = {
    osvBinaryPath: scanner.binaryPath,
    osvConfigPath: scanner.configPath,
    expectedOsvBinarySha256: scanner.expectedBinarySha256,
  };
  try {
    await runOsvFallback(scannerOptions);
    console.log(JSON.stringify({ status: 'REAL_OSV_INVENTORY_PASS', entries: inventory.entryCount, uniquePackages: inventory.coordinates.size }));

    // This deliberately vulnerable lock exists only in the ignored CI fixture.
    // npm generates its real metadata; no vulnerable code is installed or run.
    const root = process.cwd();
    const fixture = resolve('node_modules/.cache/tooling-r106/alias-counterproof');
    mkdirSync(fixture, { recursive: true });
    writeFileSync(resolve(fixture, 'package.json'), JSON.stringify({
      name: 'crm-audit-alias-counterproof', version: '1.0.0', private: true,
      devDependencies: { 'innocent-alias': 'npm:braces@3.0.3' },
    }) + '\n');
    execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--fund=false', `--registry=${NPM_AUDIT_POLICY.registryUrl}`], {
      cwd: fixture, timeout: 120_000, stdio: 'pipe',
    });
    const lockfilePath = resolve(fixture, 'package-lock.json');
    const counterproof = parseNpmLockInventory(readFileSync(lockfilePath));
    assert.ok(counterproof.coordinates.has(JSON.stringify(['braces', '3.0.3'])));
    assert.ok(!counterproof.coordinates.has(JSON.stringify(['innocent-alias', '3.0.3'])));
    try {
      process.chdir(fixture);
      await assert.rejects(runDependencyAuditGate(), error => error instanceof DependencyAuditGateError
        && error.code === 'VULNERABILITIES_AT_OR_ABOVE_LOW' && error.scope === 'complete');
    } finally { process.chdir(root); }
    await assert.rejects(runOsvFallback({ ...scannerOptions, lockfilePath }), error => error instanceof DependencyAuditGateError
      && error.code === 'OSV_FINDINGS_DETECTED');
    console.log(JSON.stringify({ status: 'REAL_ALIAS_COUNTERPROOF_PASS', actualPackage: 'braces@3.0.3', alias: 'innocent-alias', npmBlocked: true, osvBlocked: true }));
  } finally {
    await scanner.cleanup();
  }
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : 'LOCK_INVENTORY_QUALIFICATION_FAILED');
  process.exitCode = 1;
});
