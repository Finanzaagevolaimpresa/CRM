import { execFileSync } from 'node:child_process';
import { verifyPerimeterSchema } from '../r05/verify-perimeter-schema.mjs';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function requireCondition(value, code) { if (!value) throw new Error(code); }
try {
  const commit = process.env.VNX03_EXPECTED_SOURCE_COMMIT, tree = process.env.VNX03_EXPECTED_SOURCE_TREE;
  requireCondition(/^[0-9a-f]{40}$/u.test(commit ?? ''), 'VNX03_CANDIDATE_COMMIT_REQUIRED');
  requireCondition(/^[0-9a-f]{40}$/u.test(tree ?? ''), 'VNX03_CANDIDATE_TREE_REQUIRED');
  requireCondition(git('rev-parse', 'HEAD') === commit, 'VNX03_CANDIDATE_COMMIT_MISMATCH');
  requireCondition(git('rev-parse', 'HEAD^{tree}') === tree, 'VNX03_CANDIDATE_TREE_MISMATCH');
  requireCondition(git('status', '--porcelain=v2', '--untracked-files=all') === '', 'VNX03_CANDIDATE_WORKTREE_DIRTY');
  process.stdout.write(`${JSON.stringify({ profile: 'candidate-schema48', ...verifyPerimeterSchema() })}\n`);
} catch (error) {
  const code = error instanceof Error && /^VNX03_[A-Z_]+$/u.test(error.message) ? error.message : 'VNX03_CANDIDATE_SCHEMA48_VERIFICATION_FAILED';
  process.stderr.write(`${code}\n`); process.exitCode = 1;
}
