import { execFileSync } from 'node:child_process';

// A separate bank: the historical schema44 guard and its CI job stay unchanged.
const baseline = '8d87d7c0c1377e686ad9c3a9e15a48de6a7ec749';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function requireCondition(value, code) { if (!value) throw new Error(code); }

try {
  const expectedCommit = process.env.VNX03_EXPECTED_SOURCE_COMMIT;
  const expectedTree = process.env.VNX03_EXPECTED_SOURCE_TREE;
  requireCondition(/^[0-9a-f]{40}$/u.test(expectedCommit ?? ''), 'VNX03_CANDIDATE_COMMIT_REQUIRED');
  requireCondition(/^[0-9a-f]{40}$/u.test(expectedTree ?? ''), 'VNX03_CANDIDATE_TREE_REQUIRED');
  const sourceCommit = git('rev-parse', 'HEAD');
  const sourceTree = git('rev-parse', 'HEAD^{tree}');
  requireCondition(sourceCommit === expectedCommit, 'VNX03_CANDIDATE_COMMIT_MISMATCH');
  requireCondition(sourceTree === expectedTree, 'VNX03_CANDIDATE_TREE_MISMATCH');
  requireCondition(git('status', '--porcelain=v2', '--untracked-files=all') === '', 'VNX03_CANDIDATE_WORKTREE_DIRTY');
  git('merge-base', '--is-ancestor', baseline, 'HEAD');
  const migrations = git('ls-tree', '-d', '--name-only', 'HEAD:prisma/migrations').split('\n').length;
  requireCondition(migrations === 47, 'VNX03_CANDIDATE_MIGRATION_COUNT_INVALID');
  requireCondition(git('diff', '--name-only', baseline, 'HEAD', '--', 'prisma/schema.prisma', 'prisma/migrations') === '',
    'VNX03_CANDIDATE_HISTORICAL_SCHEMA_CHANGED');
  process.stdout.write(`${JSON.stringify({
    profile: 'candidate-schema47', sourceCommit, sourceTree, migrations,
    baseline, schemaAndMigrationBytesUnchanged: true, productionContact: false,
  })}\n`);
} catch (error) {
  const code = error instanceof Error && /^VNX03_[A-Z_]+$/u.test(error.message)
    ? error.message : 'VNX03_CANDIDATE_GIT_VERIFICATION_FAILED';
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
}
