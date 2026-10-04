import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('the actual Next lint consumer keeps its default-root contract and no braces path remains', () => {
  const result = spawnSync(process.execPath, ['scripts/verify-next-glob-contract.mjs'], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 60_000,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const receipt = JSON.parse(result.stdout.trim());
  assert.equal(receipt.status, 'PASS');
  assert.equal(receipt.rootMode, 'default-only');
});
