import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

const source = readFileSync(join(process.cwd(), 'tests/personal-calendar/google-transport-guard.cjs'), 'utf8');
test('The CI server guard blocks Google before fetch, records no OAuth data and cannot load outside the test perimeter', async () => {
  const records: Record<string, unknown>[] = [];
  let delegated = 0;
  const environment = { APP_ENV: 'test', RUN_DB_TESTS: '1', AI_ORCHESTRATOR_DB_TEST_SENTINEL: 'FAI_CRM_EPHEMERAL_TEST_ONLY_V1',
    APP_ORIGIN: 'http://localhost:3059', FLOW_EVIDENCE: '/synthetic-guard-only' };
  const world = (env = environment) => ({ process: { env, pid: 123 }, URL,
    fetch: (async () => { delegated++; return new Response('synthetic-only'); }) as typeof fetch,
    require: (name: string) => {
      if (name === 'node:assert/strict') return assert;
      if (name === 'node:path') return { join };
      if (name === 'node:fs') return { appendFileSync: (_path: string, text: string) => { records.push(JSON.parse(text)); } };
      throw new Error('UNEXPECTED_GUARD_IMPORT');
    } });
  const context = world(); runInNewContext(source, context);
  for (const host of ['accounts.google.com', 'oauth2.googleapis.com', 'openidconnect.googleapis.com', 'www.googleapis.com'])
    await assert.rejects(context.fetch(new URL('https://' + host + '/secret-code-synthetic?code=DO_NOT_RECORD'), { headers: { Authorization: 'DO_NOT_RECORD' } }), /SYNTHETIC_GOOGLE_HTTP_FORBIDDEN/);
  assert.equal(delegated, 0);
  assert.equal(records.filter(row => row.event === 'GOOGLE_HTTP_BLOCKED').length, 4);
  assert(!JSON.stringify(records).includes('DO_NOT_RECORD'));
  assert(!JSON.stringify(records).includes('secret-code-synthetic'));
  await context.fetch(new URL('http://localhost:3059/api/health'));
  assert.equal(delegated, 1);
  for (const env of [{ ...environment, APP_ENV: 'production' }, { ...environment, RUN_DB_TESTS: '0' },
    { ...environment, APP_ORIGIN: 'https://real.invalid' }, { ...environment, AI_ORCHESTRATOR_DB_TEST_SENTINEL: 'wrong' }])
    assert.throws(() => runInNewContext(source, world(env)));
});
