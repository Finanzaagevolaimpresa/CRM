import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, appendFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import test from 'node:test';
import { baseline, perimeterMigration } from '../scripts/r05/verify-perimeter-schema.mjs';

test('schema48 bank admits only the pinned additive migration and rejects identity, dirty and historical changes', () => {
  const source = resolve(import.meta.dirname, '..');
  const temporary = mkdtempSync(join(tmpdir(), 'r05-perimeter-guard-'));
  const root = join(temporary, 'repository');
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const commit = () => {
    git('add', '--all');
    git('-c', 'user.name=Synthetic guard', '-c', 'user.email=guard@r05.invalid', '-c', 'commit.gpgSign=false', 'commit', '-m', 'Synthetic guard fixture');
  };
  try {
    execFileSync('git', ['clone', '--shared', '--no-hardlinks', '--no-checkout', source, root], { stdio: 'pipe' });
    git('config', 'core.autocrlf', 'false');
    git('checkout', '--detach', baseline);
    const migration = `prisma/migrations/${perimeterMigration}/migration.sql`;
    for (const path of ['prisma/schema.prisma', migration, 'scripts/r05/verify-perimeter-schema.mjs', 'scripts/vnx03/verify-candidate-perimeter-scope.mjs']) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      copyFileSync(join(source, path), join(root, path));
    }
    commit();
    const check = (changes = {}) => spawnSync(process.execPath, ['scripts/vnx03/verify-candidate-perimeter-scope.mjs'], {
      cwd: root, encoding: 'utf8', env: { ...process.env,
        VNX03_EXPECTED_SOURCE_COMMIT: git('rev-parse', 'HEAD'), VNX03_EXPECTED_SOURCE_TREE: git('rev-parse', 'HEAD^{tree}'), ...changes },
    });
    const initial = check();
    assert.equal(initial.status, 0, initial.stderr);
    assert.equal(JSON.parse(initial.stdout).historicalMigrationPrefixUnchanged, 47);
    assert.equal(JSON.parse(initial.stdout).migrations, 48);
    for (const field of ['COMMIT', 'TREE']) {
      assert.match(check({ [`VNX03_EXPECTED_SOURCE_${field}`]: '' }).stderr, new RegExp(`${field}_REQUIRED`));
      assert.match(check({ [`VNX03_EXPECTED_SOURCE_${field}`]: '0'.repeat(40) }).stderr, new RegExp(`${field}_MISMATCH`));
    }
    const schema = readFileSync(join(root, 'prisma/schema.prisma'));
    appendFileSync(join(root, 'prisma/schema.prisma'), '\n// unauthorized schema\n');
    assert.match(check().stderr, /WORKTREE_DIRTY/u);
    commit();
    assert.match(check().stderr, /SCHEMA48_VERIFICATION_FAILED/u);
    writeFileSync(join(root, 'prisma/schema.prisma'), schema); commit();
    assert.equal(check().status, 0);
    const ddl = readFileSync(join(root, migration));
    appendFileSync(join(root, migration), '\n-- unauthorized additive DDL\n'); commit();
    assert.match(check().stderr, /SCHEMA48_VERIFICATION_FAILED/u);
    writeFileSync(join(root, migration), ddl); commit();
    const historical = git('ls-tree', '-r', '--name-only', baseline, '--', 'prisma/migrations').split('\n').find(path => path.endsWith('/migration.sql'));
    const old = readFileSync(join(root, historical));
    appendFileSync(join(root, historical), '\n-- unauthorized historical DDL\n'); commit();
    assert.match(check().stderr, /SCHEMA48_VERIFICATION_FAILED/u);
    writeFileSync(join(root, historical), old); commit();
    assert.equal(check().status, 0);
    mkdirSync(join(root, 'prisma/migrations/20990101000000_unapproved'));
    writeFileSync(join(root, 'prisma/migrations/20990101000000_unapproved/migration.sql'), '-- unapproved\n'); commit();
    assert.match(check().stderr, /SCHEMA48_VERIFICATION_FAILED/u);
  } finally {
    // Only this freshly allocated synthetic fixture, never a source worktree.
    assert.equal(dirname(root), temporary);
    assert.ok(temporary.startsWith(join(tmpdir(), 'r05-perimeter-guard-')));
    rmSync(temporary, { recursive: true, force: true });
  }
});
