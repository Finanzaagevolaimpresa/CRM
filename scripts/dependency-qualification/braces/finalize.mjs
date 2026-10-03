import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { root, work, evidence, hash, json, manifest } from './paths.mjs';

const provenance = json(join(evidence, 'provenance.json'));
assert.equal(process.versions.node.split('.')[0], '22');
assert.equal(hash(readFileSync(join(root, 'package-lock.json'))), provenance.crmLockSha256);
for (const [file, expected] of Object.entries(manifest.files)) {
  assert.equal(hash(readFileSync(join(root, 'node_modules/braces', file))), expected.baseline, `installed package changed: ${file}`);
  for (const variant of ['baseline', 'candidate']) assert.equal(hash(readFileSync(join(work, variant, file))), expected[variant]);
}
const qualification = readFileSync(join(evidence, 'security-consumers.tap'), 'utf8');
assert.match(qualification, /^# tests 10$/m);
assert.match(qualification, /^# pass 10$/m);
assert.match(qualification, /^# fail 0$/m);
assert.match(qualification, /^# skipped 0$/m);
const suites = ['baseline', 'candidate', 'upstream'].map(variant => json(join(evidence, `upstream-${variant}.json`)));
for (const suite of suites) {
  assert.equal(suite.testFiles.length, suite.variant === 'upstream' ? manifest.referenceTestFiles : manifest.releaseTestFiles);
  assert.ok(suite.stats.tests > 0);
  assert.equal(suite.stats.passes, suite.stats.tests);
  assert.equal(suite.stats.failures, 0);
  assert.equal(suite.stats.pending, 0);
}
assert.equal(suites[1].stats.tests, suites[0].stats.tests, 'Both variants must run the entire released suite');
assert.ok(suites[2].stats.tests > suites[0].stats.tests, 'The complete upstream reference suite must include its added tests');
const upstreamLock = readFileSync(join(work, 'upstream/package-lock.json'));
const initialUpstreamHash = readFileSync(join(evidence, 'upstream-lock.sha256'), 'utf8').trim();
assert.equal(hash(upstreamLock), initialUpstreamHash, 'Upstream lock changed after clean installation');
execFileSync('git', ['diff', '--exit-code', '--', 'package.json', 'package-lock.json', '.github/workflows/ci.yml', 'scripts/npm-audit-gate.ts', 'prisma', 'src'], { cwd: root });
const receipt = {
  phase: 'TECHNICAL_QUALIFICATION_PASS_NOT_ADOPTED', node: process.version,
  crmHead: provenance.crmHead, crmLockSha256: provenance.crmLockSha256,
  upstreamHead: manifest.upstreamHead, upstreamLockSha256: initialUpstreamHash,
  securityConsumerTests: { passed: 10, failed: 0, skipped: 0 },
  upstream: suites.map(({ variant, stats }) => ({ variant, ...stats })),
  consumers: json(join(evidence, 'consumers-candidate.json')),
  installedBracesUnmodified: true, auditControlsUnchanged: true,
  auditResolution: 'NOT_CLAIMED; consult the separate mandatory CI audit result',
  passForMerge: false,
};
writeFileSync(join(evidence, 'result.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(receipt));
