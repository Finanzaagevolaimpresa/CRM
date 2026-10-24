import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const archivedRevisions = new Set([
  '9697bd4e3fa69a7712ce7218da7237d909fa66de', // PR86
  '77828266853c935cf6805cc546ceafdab43d310d', // PR88
  'fc35c2c6feb0927f4170d0be3893d9c9ba6cbcd5', // PR90
]);
const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

// Only the three archived startup fixtures need Zod 3. Its locked installation
// already exists inside the historical PostCSS cache. Never change the current
// application's package resolution, business source or type-checking policy.
export function bindHistoricalZodToolchain(app: string, revision: string) {
  assert.ok(archivedRevisions.has(revision), 'Unknown historical application');
  assert.notEqual(resolve(app), resolve('.'), 'The current application cannot use historical Zod');
  assert.equal(digest(join(app, 'package.json')),
    'a104f2603ae6759b39891c15e5b00b05f1fde8f1776c025bdb7da1593fdca429');
  const configPath = join(app, 'tsconfig.json');
  assert.equal(digest(configPath), 'da1974bdf2b669c72a33bc107bb00fd1e5520dbc151bbeaf982483d066871ab7');
  assert.equal(digest(join(app, 'src/lib/ai-orchestrator/job-planner.ts')),
    'c7c363cf26207e2feb6362e430018f849876cccb6592bf36fbc226ac1ddfb6bf');

  const historicalDirectory = join(app, 'node_modules/.cache/r106-historical-postcss');
  assert.equal(digest(join(historicalDirectory, 'package-lock.json')),
    'ed90c9daff9986071da926b3c5b75c769ba35319bd19563b6c49d9a86821559d');
  const historicalRequire = createRequire(join(historicalDirectory, 'package.json'));
  const candidateRequire = createRequire(join(app, 'package.json'));
  assert.equal(historicalRequire('zod/package.json').version, '3.25.76');
  assert.equal(candidateRequire('zod/package.json').version, '4.6.7');

  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.equal(config.compilerOptions.strict, true);
  assert.equal(config.compilerOptions.paths.zod, undefined);
  // Next and tsc both resolve this archived dependency through the same path.
  config.compilerOptions.paths.zod = ['./node_modules/.cache/r106-historical-postcss/node_modules/zod'];
  writeFileSync(configPath, `${JSON.stringify(config)}\n`);
  console.log(JSON.stringify({ status: 'HISTORICAL_ZOD_BOUND', revision,
    archivedZod: '3.25.76', candidateZod: '4.6.7', applicationSourceChanged: false,
    strictTypecheck: true, scope: 'isolated archived startup fixture only' }));
}
