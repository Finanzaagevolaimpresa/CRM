import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { receipt } from './next-glob-guard.mjs';
import config from '../eslint.config.mjs';

assert.ok(Array.isArray(config));
const require = createRequire(import.meta.url);
const { getRootDirs } = require('@next/eslint-plugin-next/dist/utils/get-root-dirs.js');
for (const cwd of [process.cwd(), '/synthetic/crm', 'C:\\synthetic\\crm']) {
  assert.deepEqual(getRootDirs({ cwd, settings: {} }), [cwd]);
  assert.deepEqual(getRootDirs({ cwd, settings: { next: {} } }), [cwd]);
}
console.log(JSON.stringify(receipt));
