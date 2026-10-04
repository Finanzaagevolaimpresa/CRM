import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

export function bindHistoricalPostcssToolchain(app: string) {
  const directory = join(app, 'node_modules/.cache/r106-historical-postcss');
  assert.equal(createHash('sha256').update(readFileSync(join(directory, 'package-lock.json'))).digest('hex'),
    'ed90c9daff9986071da926b3c5b75c769ba35319bd19563b6c49d9a86821559d');
  const require = createRequire(join(directory, 'package.json'));
  assert.equal(require('tailwindcss/package.json').version, '3.4.19');
  assert.equal(require('autoprefixer/package.json').version, '10.5.2');
  const config = join(app, 'postcss.config.js');
  assert.equal(readFileSync(config, 'utf8').trim(), 'module.exports = { plugins: { tailwindcss: {}, autoprefixer: {} } };');
  // Only resolve the archived config's unchanged plugins against its compiler.
  // CSS, application source, schema and all database assertions stay unchanged.
  writeFileSync(config, `module.exports = ${JSON.stringify({ plugins: {
    [require.resolve('tailwindcss')]: {}, [require.resolve('autoprefixer')]: {},
  } })};\n`);
}
