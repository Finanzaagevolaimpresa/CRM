import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('N05 recovery kit rejects unsafe identities, archives, destinations and interrupted copies', () => {
  const result = spawnSync('python3', ['-B', 'tests/n05/test_recovery_kit.py'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('N05 backup image check drains the producer and rejects missing images or producer failures', () => {
  const result = spawnSync('python3', ['-B', 'tests/n05/test_backup_compose_images.py'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
