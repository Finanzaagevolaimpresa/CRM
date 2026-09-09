import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('N15 resolver validation accepts reordered equivalent scopes and emits finite failures', () => {
  const source = readFileSync('scripts/n15-resolve-dependency-patch.sh', 'utf8');
  const blocks = [...source.matchAll(/node - [^\n]+ <<'NODE'\n([\s\S]*?)\nNODE/gu)];
  assert.equal(blocks.length, 2);
  const directory = mkdtempSync(join(tmpdir(), 'n15-resolver-validation-'));
  const validator = join(directory, 'validator.cjs');
  const originalPath = join(directory, 'original.json');
  const resultPath = join(directory, 'result.json');
  const lockPath = join(directory, 'lock.json');
  const original = {
    scripts: { test: 'synthetic' },
    dependencies: { alpha: '1.0.0', next: '16.3.0', prisma: '5.22.0' },
    devDependencies: { beta: '1.0.0', 'eslint-config-next': '16.3.0', tsx: '^4.19.2' },
  };
  const result = {
    devDependencies: { tsx: '^4.19.2', 'eslint-config-next': '16.3.4', beta: '1.0.0' },
    dependencies: { prisma: '5.22.0', next: '16.3.4', alpha: '1.0.0' },
    scripts: { test: 'synthetic' },
  };
  const packageRecord = (version: string) => ({
    version,
    resolved: `https://registry.npmjs.org/synthetic/-/synthetic-${version}.tgz`,
    integrity: 'sha512-YQ==',
  });
  const lock = {
    packages: {
      '': {
        dependencies: { next: '16.3.4', prisma: '5.22.0', alpha: '1.0.0' },
        devDependencies: { tsx: '^4.19.2', beta: '1.0.0', 'eslint-config-next': '16.3.4' },
      },
      'node_modules/next': packageRecord('16.3.4'),
      'node_modules/@next/env': packageRecord('16.3.4'),
      'node_modules/eslint-config-next': packageRecord('16.3.4'),
      'node_modules/sharp': packageRecord('0.35.4'),
      'node_modules/js-yaml': packageRecord('4.3.2'),
    },
  };
  try {
    writeFileSync(validator, blocks[1][1]);
    writeFileSync(originalPath, JSON.stringify(original));
    writeFileSync(resultPath, JSON.stringify(result));
    writeFileSync(lockPath, JSON.stringify(lock));
    const invoke = () => spawnSync(process.execPath, [validator, originalPath, resultPath, lockPath], { encoding: 'utf8' });
    assert.equal(invoke().status, 0, 'property order must not affect equivalence');

    const invalid = structuredClone(result);
    const invalidDependencies = invalid.dependencies as Record<string, string>;
    invalidDependencies.unqualified = '1.0.0';
    writeFileSync(resultPath, JSON.stringify(invalid));
    const rejected = invoke();
    assert.notEqual(rejected.status, 0);
    assert.equal(rejected.stderr, 'N15_DEPENDENCY_PATCH_ERROR|code=PACKAGE_DELTA_INVALID\n');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
