import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

// Historical startup tests reuse today's Next/Prisma runtime, but their archived
// CSS still requires the immutable pre-migration compiler. Never install it in
// the candidate dependency tree or substitute historical business source.
assert.equal(process.platform, 'linux', 'The archived application startup harness runs on Linux.');
const baseline = '85fa76d3d1c110da44c892859a70f9151b79cb7f';
const lockSha256 = 'ed90c9daff9986071da926b3c5b75c769ba35319bd19563b6c49d9a86821559d';
const directory = resolve('node_modules/.cache/r106-historical-postcss');
const files = ['package.json', 'package-lock.json'].map(name => ({
  name, bytes: execFileSync('git', ['show', `${baseline}:${name}`], { maxBuffer: 1024 * 1024 }),
}));
assert.equal(createHash('sha256').update(files[1].bytes).digest('hex'), lockSha256);
mkdirSync(directory, { recursive: true });
for (const { name, bytes } of files) {
  const target = join(directory, name);
  if (existsSync(target)) assert.ok(readFileSync(target).equals(bytes), 'Unexpected historical fixture metadata.');
  else writeFileSync(target, bytes, { flag: 'wx' });
}
execFileSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--fund=false'], {
  cwd: directory, stdio: 'pipe', timeout: 180_000, maxBuffer: 2 * 1024 * 1024,
});
const require = createRequire(join(directory, 'package.json'));
assert.equal(require('tailwindcss/package.json').version, '3.4.19');
assert.equal(require('autoprefixer/package.json').version, '10.5.2');
assert.ok(readFileSync(join(directory, 'package-lock.json')).equals(files[1].bytes));
console.log(JSON.stringify({ status: 'HISTORICAL_POSTCSS_READY', baseline, lockSha256, tailwind: '3.4.19', autoprefixer: '10.5.2', scope: 'isolated archived startup fixtures only' }));
