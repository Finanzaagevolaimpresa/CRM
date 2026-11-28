/* CI-only guard for the server's actual fetch boundary. Never load in production. */
/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS is required by this isolated Node --require preload. */
const assert = require('node:assert/strict');
const { appendFileSync } = require('node:fs');
const { join } = require('node:path');
assert.equal(process.env.APP_ENV, 'test');
assert.equal(process.env.RUN_DB_TESTS, '1');
assert.equal(process.env.AI_ORCHESTRATOR_DB_TEST_SENTINEL, 'FAI_CRM_EPHEMERAL_TEST_ONLY_V1');
assert(['localhost', '127.0.0.1'].includes(new URL(process.env.APP_ORIGIN).hostname));
assert(process.env.FLOW_EVIDENCE);
const output = join(process.env.FLOW_EVIDENCE, 'calendar-provider-guard.jsonl');
const record = value => appendFileSync(output, JSON.stringify({ ...value, pid: process.pid }) + '\n');
const forbidden = new Set(['accounts.google.com', 'oauth2.googleapis.com', 'openidconnect.googleapis.com', 'www.googleapis.com']);
const original = globalThis.fetch;
assert.equal(typeof original, 'function');
globalThis.fetch = async function(input, init) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (forbidden.has(url.hostname)) {
    // Never persist a URL, authorization header, body, OAuth code or token.
    record({ event: 'GOOGLE_HTTP_BLOCKED', host: url.hostname, method: init?.method ?? 'GET' });
    throw new Error('SYNTHETIC_GOOGLE_HTTP_FORBIDDEN');
  }
  return original.call(this, input, init);
};
record({ event: 'GOOGLE_FETCH_GUARD_INSTALLED' });
