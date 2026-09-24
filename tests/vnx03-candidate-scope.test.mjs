import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, appendFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import test from 'node:test';

test('candidate bank rejects wrong identity, dirty files, historical byte changes and a new migration', () => {
  const source = resolve(import.meta.dirname, '..');
  const temporary = mkdtempSync(join(tmpdir(), 'vnx03-candidate-guard-'));
  const root = join(temporary, 'repository');
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const commit = () => {
    git('add', '--all');
    git('-c', 'user.name=Synthetic guard', '-c', 'user.email=guard@vnx03.invalid',
      '-c', 'commit.gpgSign=false', 'commit', '-m', 'Synthetic guard fixture');
  };
  try {
    execFileSync('git', ['clone', '--shared', '--no-hardlinks', '--no-checkout', source, root], { stdio: 'pipe' });
    git('config', 'core.autocrlf', 'false');
    git('checkout', '--detach', '8d87d7c0c1377e686ad9c3a9e15a48de6a7ec749');
    copyFileSync(join(source, 'scripts/vnx03/verify-candidate-scope.mjs'), join(root, 'scripts/vnx03/verify-candidate-scope.mjs'));
    commit();
    const check = (changes = {}) => spawnSync(process.execPath, ['scripts/vnx03/verify-candidate-scope.mjs'], {
      cwd: root, encoding: 'utf8', env: {
        ...process.env, VNX03_EXPECTED_SOURCE_COMMIT: git('rev-parse', 'HEAD'),
        VNX03_EXPECTED_SOURCE_TREE: git('rev-parse', 'HEAD^{tree}'), ...changes,
      },
    });
    const initial = check();
    assert.equal(initial.status, 0, initial.stderr);
    assert.equal(JSON.parse(initial.stdout).migrations, 47);
    for (const [field, value, code] of [
      ['COMMIT', '', 'COMMIT_REQUIRED'], ['TREE', '', 'TREE_REQUIRED'],
      ['COMMIT', '0'.repeat(40), 'COMMIT_MISMATCH'], ['TREE', '0'.repeat(40), 'TREE_MISMATCH'],
    ]) {
      const result = check({ [`VNX03_EXPECTED_SOURCE_${field}`]: value });
      assert.equal(result.status, 1);
      assert.match(result.stderr, new RegExp(`VNX03_CANDIDATE_${code}`));
    }
    appendFileSync(join(root, 'prisma/schema.prisma'), '\n// synthetic unauthorized change\n');
    assert.match(check().stderr, /VNX03_CANDIDATE_WORKTREE_DIRTY/u);
    commit();
    assert.match(check().stderr, /VNX03_CANDIDATE_HISTORICAL_SCHEMA_CHANGED/u);
    writeFileSync(join(root, 'prisma/schema.prisma'), execFileSync('git', ['-C', root,
      'show', '8d87d7c0c1377e686ad9c3a9e15a48de6a7ec749:prisma/schema.prisma']));
    commit();
    assert.equal(check().status, 0);
    const migration = git('ls-tree', '-r', '--name-only', 'HEAD', '--', 'prisma/migrations')
      .split('\n').find(path => path.endsWith('/migration.sql'));
    assert.ok(migration);
    appendFileSync(join(root, migration), '\n-- altered historical migration\n');
    commit();
    assert.match(check().stderr, /VNX03_CANDIDATE_HISTORICAL_SCHEMA_CHANGED/u);
    mkdirSync(join(root, 'prisma/migrations/20990101000000_synthetic_unapproved'));
    appendFileSync(join(root, 'prisma/migrations/20990101000000_synthetic_unapproved/migration.sql'), '-- synthetic\n');
    commit();
    assert.match(check().stderr, /VNX03_CANDIDATE_MIGRATION_COUNT_INVALID/u);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
