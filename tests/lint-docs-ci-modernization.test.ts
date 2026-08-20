import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

const read = (path: string) => readFileSync(path, 'utf8');

test('N08 enforces a zero-warning lint and canonical typecheck contract', () => {
  const packageJson = JSON.parse(read('package.json')) as {
    scripts: Record<string, string>;
  };
  assert.equal(packageJson.scripts.lint, 'eslint . --max-warnings 0');
  assert.equal(packageJson.scripts.typecheck, 'tsc --noEmit --incremental false');
  assert.equal(packageJson.scripts['verify:quality'], 'npm run lint && npm test && npm run typecheck');

  const eslintConfig = read('eslint.config.mjs');
  assert.doesNotMatch(eslintConfig, /["']prefer-const["']\s*:\s*["']off["']/);
  assert.doesNotMatch(eslintConfig, /["']react-hooks\/purity["']\s*:\s*["']off["']/);
});

test('N08 CI resolves Node from the repository and preserves the full release gate', () => {
  assert.equal(read('.nvmrc').trim(), '22');
  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, /node-version-file:\s*\.nvmrc/);
  assert.match(ci, /cache-dependency-path:\s*package-lock\.json/);
  assert.match(ci, /run:\s*npm run typecheck/);
  assert.match(ci, /run:\s*npm run lint/);
  assert.match(ci, /Apply exactly 38 database migrations/);
  assert.match(ci, /Run PostgreSQL integration tests/);
  assert.match(ci, /Docker production application and worker packaging smoke test/);
  assert.match(ci, /N05 synthetic backup, full restore and N-1 rollback drill/);
  assert.doesNotMatch(ci, /^\s+- master\s*$/m);
});

test('N08 remains migration-free, dependency-free and documented', () => {
  const migrations = readdirSync('prisma/migrations', { withFileTypes: true })
    .filter((entry) => entry.isDirectory());
  assert.equal(migrations.length, 38);

  const documentation = read('docs/n08-lint-debt-documentation-ci-modernization-v1.md');
  assert.match(documentation, /nessuna modifica a `prisma\/schema\.prisma`/);
  assert.match(documentation, /nessuna modifica a `package-lock\.json`/);
  assert.match(documentation, /nessun provider esterno, worker, dispatch o egress abilitato/);

});
