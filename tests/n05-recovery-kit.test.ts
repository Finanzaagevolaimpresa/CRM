import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('N05 recovery kit rejects unsafe identities, archives, destinations and interrupted copies', () => {
  const result = spawnSync('python3', ['-B', 'tests/n05/test_recovery_kit.py'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
