/* Isolated test preload: no real provider request may leave this process. */
/* eslint-disable @typescript-eslint/no-require-imports -- Node --require entry point. */
const assert = require('node:assert/strict');
const { appendFileSync } = require('node:fs');
const { join } = require('node:path');
assert.equal(process.env.APP_ENV, 'test');
assert.equal(process.env.RUN_DB_TESTS, '1');
assert.equal(process.env.AI_ORCHESTRATOR_DB_TEST_SENTINEL, 'FAI_CRM_EPHEMERAL_TEST_ONLY_V1');
assert.equal(process.env.GOOGLE_CALENDAR_PILOT_USER_ID, 'f0000000-2026-4000-8000-000000000301');
assert(['localhost','127.0.0.1'].includes(new URL(process.env.DATABASE_URL).hostname));
assert.equal(new URL(process.env.DATABASE_URL).pathname, '/fai_crm_test');
assert(['localhost','127.0.0.1'].includes(new URL(process.env.APP_ORIGIN).hostname));
assert(process.env.AGENDA_EVIDENCE);
const record = event => appendFileSync(join(process.env.AGENDA_EVIDENCE, 'provider-boundary.jsonl'), JSON.stringify({ event }) + '\n');
const original = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.origin === 'https://www.googleapis.com' && url.pathname === '/calendar/v3/freeBusy' && !url.search) {
    assert.equal(init.method, 'POST'); assert.equal(new Headers(init.headers).get('authorization'), 'Bearer agenda-synthetic-access');
    const body = JSON.parse(init.body);
    assert.deepEqual(body.items, [{ id: 'agenda-synthetic-primary' }]); assert.equal(body.timeZone, 'Europe/Rome');
    assert(Number.isFinite(Date.parse(body.timeMin)) && Number.isFinite(Date.parse(body.timeMax)));
    if (body.timeMin === '2030-06-16T22:00:00.000Z') {
      record('SYNTHETIC_FREEBUSY_UNAVAILABLE'); return Response.json({}, { status: 503 });
    }
    const intervals = [{ start: '2030-06-03T09:30:00Z', end: '2030-06-03T10:30:00Z' },
      { start: '2030-06-04T22:00:00Z', end: '2030-06-05T22:00:00Z' }];
    record('SYNTHETIC_FREEBUSY');
    return Response.json({ calendars: { 'agenda-synthetic-primary': { busy: intervals.filter(row => row.start < body.timeMax && row.end > body.timeMin) } } });
  }
  if (!['localhost','127.0.0.1','[::1]'].includes(url.hostname)) {
    record('EXTERNAL_REQUEST_BLOCKED'); throw new Error('AGENDA_REAL_NETWORK_FORBIDDEN');
  }
  return original(input, init);
};
record('INSTALLED');
