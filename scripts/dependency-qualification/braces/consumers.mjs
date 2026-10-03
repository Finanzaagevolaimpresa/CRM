import assert from 'node:assert/strict';
import { createRequire, Module } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { root, work, evidence, json } from './paths.mjs';

const variant = process.argv[2];
assert.ok(['baseline', 'candidate'].includes(variant));
const loadModule = createRequire(join(root, 'package.json'));
const replacement = loadModule(join(work, variant));
const consumers = new Set();
const originalLoad = Module._load;
Module._load = function (name, parent, ...args) {
  if (name === 'braces') {
    for (const consumer of ['micromatch', 'chokidar']) {
      if (parent.filename.includes(`${sep}${consumer}${sep}`)) consumers.add(consumer);
    }
    return replacement;
  }
  return originalLoad.call(this, name, parent, ...args);
};
const micromatch = loadModule('micromatch');
const chokidar = loadModule('chokidar');
const lock = json(join(root, 'package-lock.json'));
const fastGlobPaths = Object.keys(lock.packages).filter(path => path.endsWith('node_modules/fast-glob')).sort();
assert.equal(fastGlobPaths.length, 2, 'CRM consumer graph changed');
const fixture = join(work, `fixture-${variant}`);
mkdirSync(fixture);
for (const file of ['a.txt', 'b.txt', 'excluded.md']) writeFileSync(join(fixture, file), 'synthetic fixture\n', { flag: 'wx' });
const expansion = micromatch.braceExpand('src/{a,b}.{ts,tsx}');
const globs = fastGlobPaths.map(path => {
  const fg = loadModule(join(root, path));
  const installedVersion = json(join(root, path, 'package.json')).version;
  assert.equal(installedVersion, lock.packages[path].version);
  return { path, version: installedVersion, files: fg.sync('{a,b}.txt', { cwd: fixture }).sort() };
});
const watched = [];
const watcher = chokidar.watch('{a,b}.txt', { cwd: fixture, ignoreInitial: false });
await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('watcher ready timeout')), 5000);
  watcher.on('add', file => watched.push(file.replaceAll('\\', '/')));
  watcher.once('error', error => { clearTimeout(timeout); reject(error); });
  watcher.once('ready', () => { clearTimeout(timeout); resolve(); });
}).finally(async () => { await watcher.close(); Module._load = originalLoad; });
const report = {
  variant, substitution: 'test-process-only; installed packages unchanged',
  versions: Object.fromEntries(['micromatch', 'chokidar'].map(name => [name, loadModule(`${name}/package.json`).version])),
  consumers: [...consumers].sort(), outputs: { expansion, globs, watched: watched.sort() },
};
writeFileSync(join(evidence, `consumers-${variant}.json`), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(report));
