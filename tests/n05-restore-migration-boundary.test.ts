import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('N15 CI pins the historical PR137 source and C136 rollback for schema-44 recovery', () => {
  const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
  const start = ci.indexOf('      - name: N05 synthetic backup, full restore and N-1 rollback drill');
  const end = ci.indexOf('\n      - name: Remove tracked-only source worktree', start);
  const step = start >= 0 && end > start ? ci.slice(start, end) : '';
  assert.ok(step, 'inspect the actual historical N05 CI block');
  assert.match(step, /git worktree add --detach "\$historical_source" c49b18ccc4df713e212e8e4f2f05100638aee317/u);
  assert.match(step, /rev-parse HEAD\^\{tree\}.*064415e3dbb4a7d4ac1498c24808a01342de2359/u);
  assert.match(step, /rollback_commit=71d238b27efde1afb708e25d0fe035c0c69dc303/u);
  assert.match(step, /EXPECTED_MIGRATION_COUNT=44/u);
  assert.match(step, /EXPECTED_ROLLBACK_MIGRATION_COUNT="\$rollback_migration_count"/u);
  assert.doesNotMatch(step, /PR_BASE_SHA|mv prisma\/migrations|intake-migration-45/u);
});
