import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, appendFileSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import test from 'node:test';

test('M4 exact schema binding rejects changed prefix, schema, DDL and an extra migration', () => {
  const source = resolve(import.meta.dirname, '..'), temporary = mkdtempSync(join(tmpdir(), 'm4-schema-guard-')), root = join(temporary, 'repository');
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const commit = () => { git('add', '--all'); git('-c', 'user.name=Synthetic M4', '-c', 'user.email=m4@invalid.test', '-c', 'commit.gpgSign=false', 'commit', '-m', 'Synthetic guard fixture'); };
  const check = () => spawnSync(process.execPath, ['scripts/m4/verify-schema.mjs'], { cwd: root, encoding: 'utf8' });
  try {
    execFileSync('git', ['-c', 'core.autocrlf=false', 'clone', '--shared', '--no-hardlinks', source, root], { stdio: 'pipe' });
    git('config', 'core.autocrlf', 'false');
    assert.equal(check().status, 0, check().stderr);
    for (const [path, code] of [
      ['prisma/schema.prisma', 'M4_SCHEMA_HASH'],
      ['prisma/migrations/20260927010000_approved_manual_communications_v1/migration.sql', 'M4_MIGRATION_HASH'],
      ['prisma/migrations/20260924100000_admin_client_read_perimeters_v1/migration.sql', 'M4_HISTORICAL_PREFIX'],
    ]) {
      const target = join(root, path), before = readFileSync(target);
      appendFileSync(target, '\n-- changed synthetic fixture\n');
      assert.notEqual(check().status, 0);
      commit(); assert.match(check().stderr, new RegExp(code));
      writeFileSync(target, before); commit();
      const restored = check(); assert.equal(restored.status, 0, restored.stderr);
    }
    const extra = join(root, 'prisma/migrations/20990101000000_unapproved'); mkdirSync(extra);
    writeFileSync(join(extra, 'migration.sql'), '-- unapproved\n'); commit(); assert.match(check().stderr, /M4_EXACT_MIGRATION_SET/);
  } finally {
    assert.equal(dirname(root), temporary); assert.ok(temporary.startsWith(join(tmpdir(), 'm4-schema-guard-')));
    rmSync(temporary, { recursive: true, force: true });
  }
});
