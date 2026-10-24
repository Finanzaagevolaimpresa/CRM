import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import { bindHistoricalZodToolchain } from './db/historical-zod-toolchain';

test('historical Zod cannot be bound to the current application or an unknown revision', () => {
  const config = readFileSync('tsconfig.json');
  const pkg = readFileSync('package.json');
  assert.throws(() => bindHistoricalZodToolchain(resolve('.'),
    '77828266853c935cf6805cc546ceafdab43d310d'), /current application cannot/);
  assert.throws(() => bindHistoricalZodToolchain(resolve('src'), '0'.repeat(40)), /Unknown historical/);
  assert.ok(config.equals(readFileSync('tsconfig.json')));
  assert.ok(pkg.equals(readFileSync('package.json')));
});

test('candidate resolution stays on patched Zod without a TypeScript dependency alias', () => {
  const require = createRequire(resolve('package.json'));
  assert.equal(require('zod/package.json').version, '4.6.7');
  const config = JSON.parse(readFileSync('tsconfig.json', 'utf8'));
  assert.equal(config.compilerOptions.paths.zod, undefined);
  assert.equal(config.compilerOptions.paths['zod/*'], undefined);
  let validatedElements = 0;
  const z = require('zod').z;
  const schema = z.array(z.string().refine(() => { validatedElements++; return true; })).max(1);
  assert.equal(schema.safeParse(['synthetic-a', 'synthetic-b']).success, false);
  assert.equal(validatedElements, 0);
});
