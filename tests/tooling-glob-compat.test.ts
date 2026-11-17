import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('the published glob replacement preserves actual TypeScript projects, imports and lint denials', () => {
  const result = spawnSync(process.execPath, ['scripts/qualify-tooling-glob.mjs'], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 120_000,
  });
  assert.equal(result.status, 0, result.stdout + '\n' + result.stderr);
  const proof = JSON.parse(result.stdout.trim());
  assert.equal(proof.status, 'PASS');
  assert.equal(proof.actualParserProjects, 2);
  assert.equal(proof.actualAliasResolutions, 2);
  assert.equal(proof.actualEslintPositiveAndNegative, true);
  assert.equal(proof.originalConsumersUnmodified, true);
  assert.equal(proof.scannerExceptions, 0);
  assert.equal(proof.repeatedExtglobBounded, true);
});
