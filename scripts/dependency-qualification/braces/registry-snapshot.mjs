import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { evidence, root, json } from './paths.mjs';

mkdirSync(evidence, { recursive: true });
const specs = ['braces@3', 'micromatch@4', 'chokidar@3', 'fast-glob@3', 'tailwindcss@3', 'eslint-config-next@16', '@next/eslint-plugin-next@16'];
const observations = [];
for (const spec of specs) {
  const raw = execFileSync('npm', ['view', spec, 'version', 'dependencies', '--json', '--registry=https://registry.npmjs.org/', '--fetch-retries=1', '--fetch-timeout=30000'], { cwd: root, timeout: 90000, maxBuffer: 4 * 1024 * 1024 });
  const versions = JSON.parse(raw.toString());
  observations.push({ spec, versions });
}
const lock = json(join(root, 'package-lock.json'));
const installedPaths = Object.entries(lock.packages)
  .filter(([path]) => /node_modules\/(braces|micromatch|chokidar|fast-glob|tailwindcss|eslint-config-next|@next\/eslint-plugin-next)$/.test(path))
  .map(([path, value]) => ({ path, version: value.version, dependencies: value.dependencies }));
writeFileSync(join(evidence, 'registry-compatible-versions.json'), JSON.stringify({ observedUtc: new Date().toISOString(), installedPaths, observations }, null, 2) + '\n', { flag: 'wx' });
for (const observation of observations) {
  const list = Array.isArray(observation.versions) ? observation.versions : [observation.versions];
  const latest = list.toSorted((a, b) => a.version.localeCompare(b.version, 'en', { numeric: true })).at(-1);
  console.log(JSON.stringify({ spec: observation.spec, versionsReturned: list.length, latest }));
}
