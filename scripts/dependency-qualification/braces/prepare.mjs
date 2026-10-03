import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { source, root, work, evidence, hash, json, manifest } from './paths.mjs';

assert.equal(process.versions.node.split('.')[0], '22', 'Qualification requires Node 22');
const upstream = join(work, 'upstream');
const git = args => execFileSync('git', ['-C', upstream, ...args]);
assert.equal(git(['rev-parse', 'HEAD']).toString().trim(), manifest.upstreamHead);
assert.equal(hash(readFileSync(join(source, 'upstream.patch'))), manifest.patchSha256);
assert.equal(hash(git(['diff', '--no-color', '--no-ext-diff', '--abbrev=40', '--unified=0', manifest.upstreamBase, manifest.upstreamHead, '--', ...manifest.patchFiles])), manifest.patchSha256);
assert.equal(hash(readFileSync(join(source, 'backport.patch'))), manifest.backportPatchSha256);
const changes = patch => {
  const result = {};
  let current;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = line.split(' ')[2].slice(2);
      result[current] = [];
    } else if (/^[+-]/.test(line) && !/^(---|\+\+\+)/.test(line)) result[current].push(line);
  }
  return result;
};
assert.deepEqual(changes(readFileSync(join(source, 'backport.patch'), 'utf8')), changes(readFileSync(join(source, 'upstream.patch'), 'utf8')), 'Backport must contain exactly the upstream security changes');
assert.equal(json(join(root, 'node_modules/braces/package.json')).version, '3.0.3');
assert.equal(json(join(root, 'package-lock.json')).packages['node_modules/braces'].integrity, manifest.npmIntegrity);
mkdirSync(evidence, { recursive: true });
const receipt = {
  phase: 'PREPARED_NOT_ADOPTED', node: process.version,
  crmHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim(),
  crmLockSha256: hash(readFileSync(join(root, 'package-lock.json'))),
  ...manifest, files: {}, upstreamTestFiles: {},
};
for (const variant of ['baseline', 'candidate']) {
  const target = join(work, variant);
  assert.equal(existsSync(target), false, `Refuse to overwrite ${variant}`);
  mkdirSync(target);
  receipt.files[variant] = {};
  for (const [file, expected] of Object.entries(manifest.files)) {
    const original = readFileSync(join(root, 'node_modules/braces', file));
    assert.equal(hash(original), expected.baseline, `npm source drift: ${file}`);
    const bytes = original;
    mkdirSync(dirname(join(target, file)), { recursive: true });
    writeFileSync(join(target, file), bytes, { flag: 'wx' });
    receipt.files[variant][file] = hash(bytes);
  }
  // Both complete test trees are immutable upstream sources. No test is edited.
  const revision = manifest.upstreamRelease;
  const files = git(['ls-tree', '-r', '--name-only', revision, '--', 'test']).toString().trim().split('\n');
  assert.equal(files.length, manifest.releaseTestFiles, 'Unexpected released test inventory');
  receipt.upstreamTestFiles[variant] = {};
  for (const file of files) {
    assert.match(file, /^test\/[a-z.-]+\.js$/);
    const bytes = git(['show', `${revision}:${file}`]);
    mkdirSync(dirname(join(target, file)), { recursive: true });
    writeFileSync(join(target, file), bytes, { flag: 'wx' });
    receipt.upstreamTestFiles[variant][file] = hash(bytes);
  }
}
// Backport only the security diff. Copying entire upstream files would silently
// introduce unrelated, unreleased parser changes. The fixed directory stays in
// the ignored test cache; neither installed braces nor CRM's lock is patched.
const applyArgs = ['apply', '--unidiff-zero', '--directory=node_modules/.cache/braces-qualification/candidate'];
execFileSync('git', ['-c', 'core.autocrlf=false', ...applyArgs, '--check', join(source, 'backport.patch')], { cwd: root });
execFileSync('git', ['-c', 'core.autocrlf=false', ...applyArgs, join(source, 'backport.patch')], { cwd: root });
for (const [file, expected] of Object.entries(manifest.files)) {
  const actual = hash(readFileSync(join(work, 'candidate', file)));
  assert.equal(actual, expected.candidate, `minimal backport drift: ${file}`);
  receipt.files.candidate[file] = actual;
}
const referenceTests = git(['ls-tree', '-r', '--name-only', manifest.upstreamHead, '--', 'test']).toString().trim().split('\n');
assert.equal(referenceTests.length, manifest.referenceTestFiles);
receipt.upstreamTestFiles.upstream = Object.fromEntries(referenceTests.map(file => [file, hash(git(['show', `${manifest.upstreamHead}:${file}`]))]));
writeFileSync(join(evidence, 'provenance.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ phase: receipt.phase, node: receipt.node, crmHead: receipt.crmHead, patchFiles: manifest.patchFiles.length, releaseTestFilesPerVariant: manifest.releaseTestFiles, referenceTestFiles: manifest.referenceTestFiles }));
