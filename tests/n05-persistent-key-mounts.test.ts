import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('N05 persistent key mounts reject unsafe configuration, files and provenance', () => {
  const result = spawnSync('python3', ['-B', 'tests/n05/test_key_mounts.py'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
