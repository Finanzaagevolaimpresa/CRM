import assert from 'node:assert/strict';
import { createRequire, Module } from 'node:module';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { work, evidence, manifest } from './paths.mjs';

const variant = process.argv[2];
assert.ok(['baseline', 'candidate', 'upstream'].includes(variant));
const upstreamRequire = createRequire(join(work, 'upstream/package.json'));
const Mocha = upstreamRequire('mocha');
const bashPath = upstreamRequire('bash-path');
const originalLoad = Module._load;
// Resolve only the upstream runner helpers from its clean, independently locked
// installation. The package under test uses the CRM's locked fill-range.
Module._load = function (name, parent, ...args) {
  if (name === 'mocha') return Mocha;
  if (name === 'bash-path') return bashPath;
  return originalLoad.call(this, name, parent, ...args);
};
const testRoot = join(work, variant, 'test');
const testFiles = readdirSync(testRoot).filter(file => file.endsWith('.js')).sort();
assert.equal(testFiles.length, variant === 'upstream' ? manifest.referenceTestFiles : manifest.releaseTestFiles);
const failures = [];
const pending = [];
const mocha = new Mocha({ timeout: 5000, reporter: function (runner) {
  runner.on('fail', (test, error) => failures.push({ title: test.fullTitle(), message: error.message }));
  runner.on('pending', test => pending.push(test.fullTitle()));
} });
if (testFiles.includes('mocha-initialization.js')) mocha.addFile(join(testRoot, 'mocha-initialization.js'));
for (const file of testFiles) if (file !== 'mocha-initialization.js') mocha.addFile(join(testRoot, file));
const runner = mocha.run(count => {
  const report = { variant, node: process.version, testFiles, stats: runner.stats, failures, pending };
  writeFileSync(join(evidence, `upstream-${variant}.json`), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ variant, ...runner.stats }));
  Module._load = originalLoad;
  if (count !== 0 || runner.stats.tests === 0 || runner.stats.pending !== 0 || runner.stats.passes !== runner.stats.tests) process.exitCode = 1;
});
