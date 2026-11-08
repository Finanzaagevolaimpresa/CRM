import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

assert.equal(process.env.CI, 'true');
assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.env.APP_ENV, 'test');
const url = new URL(process.env.DATABASE_URL);
assert.equal(url.hostname, '127.0.0.1');
assert.equal(url.port, '5432');
assert.equal(url.pathname, '/fai_crm_test');
// The previously qualified client is used only by historical schema69..75
// fixture jobs. Its generator lives beside the ordinary schema, so it writes
// the same local node_modules client; workflows regenerate the current client
// before applying schema76 or running current application tests.
const baseline = '1a5195730b1b396354ec405118bcbb8187c72311';
execFileSync('git', ['merge-base', '--is-ancestor', baseline, 'HEAD']);
const source = execFileSync('git', ['cat-file', 'blob', baseline + ':prisma/schema.prisma'], { encoding: 'utf8' }).replaceAll('\r\n', '\n');
const sha256 = createHash('sha256').update(source).digest('hex');
assert.equal(sha256, '70b33b7dc441cacd5f07f9a20031f0de168b97f151549ed8b4438adffa8fc814');
const path = resolve('prisma/.ci-qualified-schema75.prisma');
if (existsSync(path)) assert.equal(readFileSync(path, 'utf8'), source);
else writeFileSync(path, source, { flag: 'wx' });
execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'generate', '--schema', path], { stdio: 'inherit' });
console.log(JSON.stringify({ protocol: 'CI_HISTORICAL_PRISMA_CLIENT', baseline, schema: 75, sha256, productionContact: false }));
