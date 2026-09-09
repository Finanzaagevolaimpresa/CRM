import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'n15-rollback-boundary-'));
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'N15 Synthetic',
    GIT_AUTHOR_EMAIL: 'n15@example.test',
    GIT_COMMITTER_NAME: 'N15 Synthetic',
    GIT_COMMITTER_EMAIL: 'n15@example.test',
  };
  const git = (...args: string[]) => execFileSync('git', [
    '-C', root, '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args,
  ], { encoding: 'utf8', env, timeout: 10_000 }).trim();
  const write = (path: string, value: string) => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), value);
  };
  const commit = (message: string) => {
    git('add', '.'); git('commit', '--quiet', '-m', message); return git('rev-parse', 'HEAD');
  };
  try {
    git('init', '--quiet', '--template=');
    for (let i = 0; i < 43; i++) {
      write('prisma/migrations/202608' + String(i).padStart(8, '0') + '_synthetic/migration.sql', '-- invented migration\n');
    }
    const source43 = commit('synthetic schema 43');
    write('prisma/migrations/20260909120000_n15_dedicated_communication_persistence_v1/migration.sql', '-- invented N15 migration\n');
    const source44 = commit('synthetic schema 44');
    write('README.md', 'invented application-only change\n');
    const steady44 = commit('synthetic later schema 44');
    write('prisma/migrations/20260800000000_synthetic/migration.sql', '-- altered invented history\n');
    const modified44 = commit('synthetic invalid history change');
    const bin = join(root, 'test-bin');
    mkdirSync(bin);
    const scriptRoot = join(root, 'scripts/n05');
    mkdirSync(scriptRoot, { recursive: true });
    for (const name of ['restore-drill.sh', 'lib.sh']) {
      copyFileSync(resolve('scripts/n05', name), join(scriptRoot, name));
    }
    return { root, env, git, source43, source44, steady44, modified44, bin, scriptRoot };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

test('N15 CI selects the actual rollback count for PR bases and later main pushes', () => {
  const f = fixture();
  try {
    f.git('checkout', '--quiet', '--detach', f.steady44);
    writeFileSync(join(f.bin, 'npm'), '#!/usr/bin/env bash\nset -euo pipefail\n[[ "$*" == "run test:n05:restore" ]]\nprintf "SELECTED|%s|%s|%s\\n" "$ROLLBACK_COMMIT" "$ROLLBACK_TREE" "$EXPECTED_ROLLBACK_MIGRATION_COUNT"\n', { mode: 0o755 });
    const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
    const step = ci.match(/      - name: N05 synthetic backup, full restore and N-1 rollback drill\n[\s\S]*?        run: \|\n([\s\S]*?)(?=\n      - name:)/u)?.[1];
    assert.ok(step, 'execute the actual CI selection block');
    const command = step.replace(/^          /gmu, '')
      .replaceAll('$' + '{{ github.run_id }}', 'synthetic')
      .replaceAll('$' + '{{ github.run_attempt }}', '1');
    for (const [base, expectedCommit, count] of [
      [f.source43, f.source43, '43'],
      [f.source44, f.source44, '44'],
      ['', f.source44, '44'],
    ]) {
      const result = spawnSync('bash', ['-euo', 'pipefail', '-c', command], {
        cwd: f.root, env: { ...f.env, PATH: f.bin + ':' + process.env.PATH, PR_BASE_SHA: base },
        encoding: 'utf8', timeout: 10_000,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), 'SELECTED|' + expectedCommit + '|' + f.git('rev-parse', expectedCommit + '^{tree}') + '|' + count);
    }
    const missing = spawnSync('bash', ['-euo', 'pipefail', '-c', command], {
      cwd: f.root, env: { ...f.env, PATH: f.bin + ':' + process.env.PATH, PR_BASE_SHA: '0'.repeat(40) },
      encoding: 'utf8', timeout: 10_000,
    });
    assert.notEqual(missing.status, 0);
    assert.doesNotMatch(missing.stdout, /SELECTED/u);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('N15 restore preflight qualifies 43 to 44 and unchanged 44 to 44 without allocating resources', () => {
  const f = fixture();
  try {
    // Execute the real preflight and stop at its first resource allocation.
    writeFileSync(join(f.bin, 'mktemp'), '#!/usr/bin/env bash\nprintf "MIGRATION_PREFLIGHT_ACCEPTED\\n" >&2\nexit 97\n', { mode: 0o755 });
    writeFileSync(join(f.bin, 'docker'), '#!/usr/bin/env bash\nprintf "UNEXPECTED_DOCKER_CALL\\n" >&2\nexit 98\n', { mode: 0o755 });
    const run = (source: string, rollback: string, current: string, previous: string) => spawnSync('bash', [join(f.scriptRoot, 'restore-drill.sh')], {
      cwd: f.root,
      env: {
        ...f.env, PATH: f.bin + ':' + process.env.PATH,
        SOURCE_COMMIT: source, SOURCE_TREE: f.git('rev-parse', source + '^{tree}'),
        ROLLBACK_COMMIT: rollback, ROLLBACK_TREE: f.git('rev-parse', rollback + '^{tree}'),
        EXPECTED_MIGRATION_COUNT: current, EXPECTED_ROLLBACK_MIGRATION_COUNT: previous,
        N05_RUN_ID: 'n15-synthetic-boundary',
      },
      encoding: 'utf8', timeout: 10_000,
    });
    for (const [source, rollback, current, previous] of [
      [f.source43, f.source43, '43', '43'],
      [f.source44, f.source43, '44', '43'],
      [f.steady44, f.source44, '44', '44'],
    ]) {
      const result = run(source, rollback, current, previous);
      assert.equal(result.status, 97, result.stderr);
      assert.match(result.stderr, /MIGRATION_PREFLIGHT_ACCEPTED/u);
      assert.doesNotMatch(result.stderr, /UNEXPECTED_DOCKER_CALL/u);
    }
    for (const [source, rollback, current, previous, code] of [
      [f.steady44, f.source44, '44', '43', 'ROLLBACK_SOURCE_MIGRATION_COUNT_MISMATCH'],
      [f.source43, f.source44, '43', '44', 'ROLLBACK_SCHEMA_AHEAD_OF_SOURCE'],
      [f.modified44, f.source43, '44', '43', 'HISTORICAL_MIGRATION_CHANGED'],
      [f.modified44, f.source44, '44', '44', 'ROLLBACK_MIGRATIONS_CHANGED'],
      [f.steady44, f.source44, '44', '45', 'RESTORE_DRILL_ROLLBACK_MIGRATION_COUNT_UNQUALIFIED'],
    ]) {
      const result = run(source, rollback, current, previous);
      assert.equal(result.status, 1, result.stderr);
      assert.ok(result.stderr.includes('N05_FAILED|code=' + code), result.stderr);
      assert.doesNotMatch(result.stdout + result.stderr, /MIGRATION_PREFLIGHT_ACCEPTED|UNEXPECTED_DOCKER_CALL/u);
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
