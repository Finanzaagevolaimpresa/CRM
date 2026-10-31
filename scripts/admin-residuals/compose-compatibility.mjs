import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const git = (args, options = {}) => execFileSync('git', args, { encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], ...options }).trim();
const candidate = git(['rev-parse', process.argv[2] ?? 'HEAD']);
assert.match(candidate, /^[a-f0-9]{40}$/);
const baseline = 'bbc76e18a64b8e3ff75c51fe7d966ae31e5f2fd2';
git(['merge-base', '--is-ancestor', baseline, candidate]);
const baselineTree = git(['rev-parse', baseline + '^{tree}']);
assert.equal(baselineTree, '8d4573601abfd8e7e86f56608cf3181275b5b641');
const read = file => execFileSync('git', ['show', candidate + ':' + file], { encoding: 'utf8', windowsHide: true });
const hash = value => createHash('sha256').update(value).digest('hex');
const binding = JSON.parse(read('scripts/admin-residuals/schema-binding.json'));
assert.equal(binding.baseline, baseline);
assert.equal(hash(read('prisma/migrations/' + binding.migration + '/migration.sql')), binding.migrationSha256);
const paths = [
  'package.json', 'package-lock.json', 'eslint.config.mjs', 'scripts/lint-minimatch-compat.mjs',
  'src/lib/private-document-versions.ts', 'src/lib/technical-document-acquisition-persistence.ts',
  'src/lib/technical-document-acquired-access.ts', 'src/lib/selective-client-documents.ts',
  'src/lib/admin-practice-formalization-store.ts', 'src/lib/admin-operational-link-contract.ts',
  'src/lib/practice-readiness.ts', 'src/lib/ordinary-email-activation.ts', 'src/app/acquired-documents/[id]/route.ts',
  'src/app/clients/[id]/acquired-documents/page.tsx', 'src/app/practice-readiness/page.tsx',
  'scripts/m4/verify-schema.mjs', 'scripts/admin-residuals/schema-binding.json',
  'prisma/migrations/' + binding.migration + '/migration.sql',
];
const temporary = mkdtempSync(join(tmpdir(), 'fai-admin-compat-index-'));
try {
  const index = join(temporary, 'index'), env = { ...process.env, GIT_INDEX_FILE: index };
  git(['read-tree', baseline], { env });
  const files = paths.map(path => {
    const original = read(path);
    let content = original;
    const omittedLink = path === 'src/app/clients/[id]/acquired-documents/page.tsx' ? 'Carica o ripristina una versione privata'
      : path === 'src/app/practice-readiness/page.tsx' ? 'Rettifica contratto, versione firmata e servizio collegato' : null;
    if (omittedLink) {
      const lines = content.split('\n');
      assert.equal(lines.filter(line => line.includes(omittedLink)).length, 1);
      content = lines.filter(line => !line.includes(omittedLink)).join('\n');
    }
    const blob = git(['hash-object', '-w', '--stdin'], { input: content });
    git(['update-index', '--add', '--cacheinfo', '100644,' + blob + ',' + path], { env });
    return { path, sourceSha256: hash(original), compatibilitySha256: hash(content), blob };
  });
  const tree = git(['write-tree'], { env });
  const date = git(['show', '-s', '--format=%cI', candidate]);
  const commitEnv = { ...env, GIT_AUTHOR_NAME: 'FAI Compatibility Builder', GIT_AUTHOR_EMAIL: 'compatibility@invalid.test',
    GIT_COMMITTER_NAME: 'FAI Compatibility Builder', GIT_COMMITTER_EMAIL: 'compatibility@invalid.test',
    GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  const commit = git(['-c', 'commit.gpgSign=false', 'commit-tree', tree, '-p', baseline],
    { env: commitEnv, input: 'Compatibility readers for Admin residual candidate ' + candidate + '\n\nRetain schema74 provenance and prior individual permissions; new residual writers are absent.\n' });
  assert.equal(git(['rev-parse', commit + '^{tree}']), tree);
  const changed = git(['diff-tree', '--no-commit-id', '--name-only', '-r', baseline, commit, '--', ...paths]).split('\n').filter(Boolean);
  assert.deepEqual(changed.sort(), [...paths].sort());
  console.log(JSON.stringify({ protocol: 'ADMIN_RESIDUAL_COMPATIBILITY_SOURCE_V1', baseline, baselineTree,
    candidate, candidateTree: git(['rev-parse', candidate + '^{tree}']), commit, tree, schema: 74, sqlSha256: binding.migrationSha256,
    files, newResidualWritersExposed: false, originalSourceRowsRewritten: false, productionContact: false }));
} finally {
  assert.equal(dirname(temporary), resolve(tmpdir()));
  assert(temporary.startsWith(join(tmpdir(), 'fai-admin-compat-index-')));
  rmSync(temporary, { recursive: true, force: true });
}
