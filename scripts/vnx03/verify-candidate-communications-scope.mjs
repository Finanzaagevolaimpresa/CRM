import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { verifyCommunicationSchema } from '../m4/verify-schema.mjs';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const receipt = verifyCommunicationSchema();
assert.equal(git('rev-parse', 'HEAD'), process.env.VNX03_EXPECTED_SOURCE_COMMIT, 'M4_CANDIDATE_COMMIT');
assert.equal(git('rev-parse', 'HEAD^{tree}'), process.env.VNX03_EXPECTED_SOURCE_TREE, 'M4_CANDIDATE_TREE');
assert.equal(git('status', '--porcelain=v2', '--untracked-files=all'), '', 'M4_CANDIDATE_DIRTY');
process.stdout.write(JSON.stringify({ ...receipt, profile: 'candidate-schema49' }) + '\n');
