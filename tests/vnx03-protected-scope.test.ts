import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const qualifiedBase = 'f48475a748315d1d8d9722412207f41b8890ad10';
const qualifiedHead = '4f388cbdd53c74cf5b855cff1fbc5282ed957e2a';
const pr137Public = 'c49b18ccc4df713e212e8e4f2f05100638aee317';
const pr137LocalEquivalent = '998d496ef041d8c3154b2eaa9fa3ca4667ed1b37';
const pr137Tree = '064415e3dbb4a7d4ac1498c24808a01342de2359';

function historicalFixtureRef() {
  for (const ref of [pr137Public, pr137LocalEquivalent]) {
    try {
      execFileSync('git', ['-C', root, 'cat-file', '-e', `${ref}^{commit}`], { stdio: 'ignore' });
      const tree = execFileSync('git', ['-C', root, 'rev-parse', `${ref}^{tree}`], { encoding: 'utf8' }).trim();
      if (tree === pr137Tree) return ref;
    } catch {
      // Continue only to the other explicitly admitted identity.
    }
  }
  throw new Error('VNX03_PR137_HISTORICAL_FIXTURE_UNAVAILABLE');
}

function fixture(ref?: string) {
  const parent = mkdtempSync(join(tmpdir(), 'vnx03-scope-'));
  const repository = join(parent, 'repo');
  execFileSync('git', ['clone', '--quiet', '--no-hardlinks', root, repository]);
  execFileSync('git', ['checkout', '--quiet', '--detach', ref ?? historicalFixtureRef()], { cwd: repository });
  const guard = join(repository, 'scripts/vnx03/verify-protected-scope.sh');
  copyFileSync(join(root, 'scripts/vnx03/verify-protected-scope.sh'), guard);
  chmodSync(guard, 0o755);
  execFileSync('git', ['config', 'user.email', 'vnx03-synthetic@example.invalid'], { cwd: repository });
  execFileSync('git', ['config', 'user.name', 'VNX03 Synthetic'], { cwd: repository });
  return { parent, repository, guard };
}

function commit(repository: string, path: string, contents: string) {
  const target = join(repository, path);
  mkdirSync(resolve(target, '..'), { recursive: true });
  writeFileSync(target, contents);
  execFileSync('git', ['add', path], { cwd: repository });
  execFileSync('git', ['commit', '--quiet', '-m', 'synthetic scope mutation'], { cwd: repository });
}

function commitMany(repository: string, changes: ReadonlyArray<{ path: string; contents: string }>) {
  for (const change of changes) {
    const target = join(repository, change.path);
    mkdirSync(resolve(target, '..'), { recursive: true });
    const existing = (() => { try { return readFileSync(target, 'utf8'); } catch { return ''; } })();
    writeFileSync(target, existing + change.contents);
    execFileSync('git', ['add', change.path], { cwd: repository });
  }
  execFileSync('git', ['commit', '--quiet', '-m', 'synthetic combined scope mutation'], { cwd: repository });
}

function run(repository: string, guard: string, base: string) {
  return spawnSync('bash', [guard], {
    cwd: repository,
    env: { ...process.env, VNX03_BASE_SHA: base },
    encoding: 'utf8',
  });
}

test('VNX-03 co-modification guard admits historical qualified N15, harness-only and runtime-only changes', () => {
  {
    const value = fixture(qualifiedHead);
    try {
      assert.equal(run(value.repository, value.guard, qualifiedBase).status, 0, 'historical qualified N15');
      const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: value.repository, encoding: 'utf8' }).trim();
      const harness = 'tests/vnx03/synthetic-scope-marker.txt';
      commit(value.repository, harness, 'synthetic harness-only change\n');
      assert.equal(run(value.repository, value.guard, base).status, 0, 'harness-only');
    } finally {
      rmSync(value.parent, { recursive: true, force: true });
    }
  }

  {
    const value = fixture();
    try {
      const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: value.repository, encoding: 'utf8' }).trim();
      commit(value.repository, 'src/synthetic-vnx03-runtime-only.ts', 'export const runtimeOnly = true;\n');
      assert.equal(run(value.repository, value.guard, base).status, 0, 'runtime-only');
    } finally {
      rmSync(value.parent, { recursive: true, force: true });
    }
  }
});

test('VNX-03 co-modification guard rejects unrelated runtime and migration drift with harness changes', () => {
  for (const scenario of [
    { path: 'src/synthetic-vnx03-runtime-drift.ts', contents: 'export const drift = true;\n', base: 'head', code: 'VNX03_N15_BASE_MIGRATION_COUNT_INVALID' },
    { path: 'prisma/migrations/20260626000000_init/migration.sql', contents: '\n-- historical mutation\n', base: qualifiedBase, code: 'VNX03_N15_HISTORICAL_MIGRATION_CHANGED' },
    { path: 'prisma/migrations/20990101000000_unapproved/migration.sql', contents: '-- additional migration\n', base: 'head', code: 'VNX03_MIGRATION_COUNT_INVALID' },
  ]) {
    const value = fixture();
    try {
      const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: value.repository, encoding: 'utf8' }).trim();
      commitMany(value.repository, [
        { path: 'tests/vnx03/synthetic-co-modification.txt', contents: 'synthetic harness delta\n' },
        { path: scenario.path, contents: scenario.contents },
      ]);
      const result = run(value.repository, value.guard, scenario.base === 'head' ? head : scenario.base);
      assert.notEqual(result.status, 0, scenario.path);
      assert.match(result.stderr, new RegExp(scenario.code, 'u'));
    } finally {
      rmSync(value.parent, { recursive: true, force: true });
    }
  }
});
