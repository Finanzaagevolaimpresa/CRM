/* Synthetic server fetch boundary. No real Google or other external request is allowed. */
/* eslint-disable @typescript-eslint/no-require-imports -- Node --require preload. */
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { appendFileSync } = require('node:fs');
const { join } = require('node:path');
assert.equal(process.env.APP_ENV, 'test');
assert.equal(process.env.RUN_DB_TESTS, '1');
assert.equal(process.env.AI_ORCHESTRATOR_DB_TEST_SENTINEL, 'FAI_CRM_EPHEMERAL_TEST_ONLY_V1');
assert.equal(process.env.GOOGLE_CALENDAR_OAUTH_CLIENT_ID, 'synthetic-calendar-ci-client');
assert.equal(process.env.GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET, 'synthetic-calendar-ci-secret');
assert.equal(process.env.GOOGLE_CALENDAR_TOKEN_KEY, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
assert.equal(process.env.GOOGLE_CALENDAR_PILOT_USER_ID, 'f0000000-2026-4000-8000-000000000101');
assert(['localhost', '127.0.0.1'].includes(new URL(process.env.APP_ORIGIN).hostname));
assert(['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL).hostname));
assert(process.env.FLOW_EVIDENCE);
const record = event => appendFileSync(join(process.env.FLOW_EVIDENCE, 'simulator.jsonl'), JSON.stringify({ event }) + '\n');
const json = (body, status = 200) => Response.json(body, { status });
const original = globalThis.fetch;
const scopes = 'openid https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.events.freebusy https://www.googleapis.com/auth/calendar.calendarlist.readonly';
globalThis.fetch = async function(input, init) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (['localhost', '127.0.0.1'].includes(url.hostname)) return original.call(this, input, init);
  if (url.href === 'https://oauth2.googleapis.com/token' && init?.method === 'POST') {
    const body = new URLSearchParams(init.body);
    assert.equal(body.get('client_id'), process.env.GOOGLE_CALENDAR_OAUTH_CLIENT_ID);
    assert.equal(body.get('client_secret'), process.env.GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET);
    assert.equal(body.get('redirect_uri'), process.env.GOOGLE_CALENDAR_OAUTH_REDIRECT_URI);
    assert.equal(body.get('grant_type'), 'authorization_code');
    const challenge = createHash('sha256').update(body.get('code_verifier') || '').digest('base64url');
    const code = body.get('code');
    if (code === 'SYNTHETIC_PROVIDER_ERROR') {
      record('TOKEN_ERROR'); return json({ error: 'SYNTHETIC_PRIVATE_PROVIDER_ERROR' }, 400);
    }
    assert(code === 'SYNTHETIC.' + challenge, 'SYNTHETIC_PKCE_MISMATCH');
    record('TOKEN_PKCE_VERIFIED');
    return json({ access_token: 'SYNTHETIC_ACCESS', refresh_token: 'SYNTHETIC_REFRESH', token_type: 'Bearer', expires_in: 3600, scope: scopes });
  }
  if (url.href === 'https://openidconnect.googleapis.com/v1/userinfo') {
    record('PROFILE_READ'); return json({ sub: 'synthetic-calendar-subject' });
  }
  if (url.href === 'https://www.googleapis.com/calendar/v3/users/me/calendarList/primary') {
    record('CALENDAR_READ'); return json({ id: 'synthetic-calendar@invalid.test', primary: true, accessRole: 'owner' });
  }
  if (url.href === 'https://www.googleapis.com/calendar/v3/freeBusy' && init?.method === 'POST') {
    record('AVAILABILITY_READ'); return json({ calendars: { 'synthetic-calendar@invalid.test': { busy: [] } } });
  }
  record('EXTERNAL_REQUEST_BLOCKED');
  throw new Error('SYNTHETIC_EXTERNAL_REQUEST_FORBIDDEN');
};
record('INSTALLED');
