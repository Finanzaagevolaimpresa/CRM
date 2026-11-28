import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { before, after, test } from 'node:test';
import { PrismaClient, type RoleCode } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from './db/ai-orchestrator-db-test-guard';
import { syntheticPerson, syntheticSession } from './selective-sharing/fixtures';
import { beginGoogleCalendarConnection, cancelGoogleCalendarConnection, completeGoogleCalendarConnection, connectedCalendarAdapter,
  decryptCalendarSecret, type CalendarOAuthConfig } from '../src/lib/google-calendar-oauth';

const db = new PrismaClient(), enabled = process.env.RUN_DB_TESTS === '1';
const options = { skip: !enabled };
const expectedScopes = ['openid', 'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.events.freebusy', 'https://www.googleapis.com/auth/calendar.calendarlist.readonly'];
type Person = Awaited<ReturnType<typeof syntheticPerson>>;
before(async () => {
  if (!enabled) return;
  assert.equal(process.env.APP_ENV, 'test');
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
});
after(async () => { await db.$disconnect(); });

async function fixture(role: RoleCode = 'commerciale') {
  const person = await syntheticPerson(db, 'Pilot Calendar · solo test', role);
  const config: CalendarOAuthConfig = { clientId: 'synthetic-only-client', clientSecret: 'synthetic-only-secret',
    redirectUri: 'http://localhost:3059/settings/integrations/google-calendar/callback', key: randomBytes(32), pilotUserId: person.user.id };
  return { person, config };
}
function fakeGoogle(person: Person, afterExchange?: () => Promise<void>) {
  const calls: { url: string; grant: string | null }[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = String(input), fields = new URLSearchParams(String(init?.body ?? ''));
    calls.push({ url, grant: fields.get('grant_type') });
    if (url === 'https://oauth2.googleapis.com/token') {
      assert.equal(init?.redirect, 'error');
      await afterExchange?.();
      return Response.json({ access_token: 'synthetic-access-' + person.user.id, refresh_token: 'synthetic-refresh-' + person.user.id,
        token_type: 'Bearer', expires_in: 3600, scope: expectedScopes.join(' ') });
    }
    if (url === 'https://openidconnect.googleapis.com/v1/userinfo') return Response.json({ sub: 'synthetic-subject-' + person.user.id });
    if (url === 'https://www.googleapis.com/calendar/v3/users/me/calendarList/primary')
      return Response.json({ id: 'synthetic-calendar-' + person.user.id, primary: true, accessRole: 'owner' });
    throw new Error('UNEXPECTED_SYNTHETIC_GOOGLE_REQUEST');
  };
  return { calls, transport };
}
async function counts(ids: string[]) {
  return Promise.all([db.googleCalendarOAuthState.count({ where: { userId: { in: ids } } }),
    db.googleCalendarCredential.count({ where: { userId: { in: ids } } }), db.personalCalendar.count({ where: { userId: { in: ids } } }),
    db.auditLog.count({ where: { actorId: { in: ids }, event: 'google_calendar_connected' } })]);
}
async function start(person: Person, config: CalendarOAuthConfig) {
  const url = new URL(await beginGoogleCalendarConnection(db, person.session, config));
  assert.equal(url.origin, 'https://accounts.google.com');
  assert.deepEqual(url.searchParams.get('scope')?.split(' '), expectedScopes);
  assert.equal(url.searchParams.get('include_granted_scopes'), 'false');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  return { state: url.searchParams.get('state')!, code: 'synthetic-only-authorization-code' };
}

test('Calendar pilot perimeter denies other users, privileged roles and current technical membership before state or provider access', options, async () => {
  const { person, config } = await fixture();
  const others = await Promise.all(['commerciale', 'admin', 'consulente', 'backoffice'].map(role =>
    syntheticPerson(db, 'Pilot Calendar · solo test', role as RoleCode)));
  const google = fakeGoogle(person), ids = [person.user.id, ...others.map(row => row.user.id)];
  const before = await counts(ids);
  for (const other of others) {
    await assert.rejects(beginGoogleCalendarConnection(db, other.session, config));
    await assert.rejects(completeGoogleCalendarConnection(db, other.session, { state: 'a'.repeat(43), code: 'synthetic-code' }, config, google.transport));
    await assert.rejects(connectedCalendarAdapter(db, other.user.id, config, google.transport));
  }
  // Matching the configured ID cannot turn a fresh Admin or technician into the commercial pilot.
  for (const other of others.filter(row => row.user.role !== 'commerciale'))
    await assert.rejects(beginGoogleCalendarConnection(db, { ...other.session, role: 'commerciale' }, { ...config, pilotUserId: other.user.id }));
  await db.userPermissionOverride.create({ data: { userId: person.user.id, permission: 'technical.write', allowed: true } });
  await assert.rejects(beginGoogleCalendarConnection(db, person.session, config));
  assert.deepEqual(await counts(ids), before);
  assert.equal(google.calls.length, 0);
});

test('A correctly configured pilot preserves single-use session-bound OAuth and exact existing scopes', options, async () => {
  const { person, config } = await fixture(), google = fakeGoogle(person);
  const input = await start(person, config), anotherSession = await syntheticSession(db, person.user);
  await assert.rejects(completeGoogleCalendarConnection(db, anotherSession.session, input, config, google.transport));
  await assert.rejects(completeGoogleCalendarConnection(db, person.session, input, { ...config, pilotUserId: 'other-synthetic-id' }, google.transport));
  assert.equal(google.calls.length, 0);
  const result = await completeGoogleCalendarConnection(db, person.session, input, config, google.transport);
  await assert.rejects(completeGoogleCalendarConnection(db, person.session, input, config, google.transport));
  assert.equal(google.calls.filter(call => call.grant === 'authorization_code').length, 1);
  assert.deepEqual(await counts([person.user.id]), [1, 1, 1, 1]);
  const stored = await db.googleCalendarCredential.findUniqueOrThrow({ where: { userId: person.user.id } });
  assert.equal(decryptCalendarSecret(stored.accessTokenCiphertext, 'access:' + person.user.id, config.key), 'synthetic-access-' + person.user.id);
  assert.equal((await db.personalCalendar.findUniqueOrThrow({ where: { id: result } })).userId, person.user.id);
  const adapter = await connectedCalendarAdapter(db, person.user.id, config, google.transport);
  assert(adapter.owns(person.user.id, 'synthetic-calendar-' + person.user.id));
  assert.equal(google.calls.length, 3); // token, identity and primary-calendar reads only; no event or refresh.
});

test('Cancellation uses the original pilot session and consumes the attempt exactly once without credentials', options, async () => {
  const { person, config } = await fixture(), input = await start(person, config), google = fakeGoogle(person);
  const second = await syntheticSession(db, person.user);
  await assert.rejects(cancelGoogleCalendarConnection(db, second.session, input.state, config));
  await assert.rejects(cancelGoogleCalendarConnection(db, person.session, input.state, { ...config, pilotUserId: 'another-pilot' }));
  await cancelGoogleCalendarConnection(db, person.session, input.state, config);
  await assert.rejects(cancelGoogleCalendarConnection(db, person.session, input.state, config));
  await assert.rejects(completeGoogleCalendarConnection(db, person.session, input, config, google.transport));
  assert.equal(google.calls.length, 0);
  assert.deepEqual(await counts([person.user.id]), [1, 0, 0, 0]);
});

test('Current pilot revocation before callback cannot consume a state or exchange its code', options, async () => {
  for (const change of ['inactive', 'role', 'permission'] as const) {
    const { person, config } = await fixture(), google = fakeGoogle(person), input = await start(person, config);
    if (change === 'inactive') await db.user.update({ where: { id: person.user.id }, data: { active: false } });
    else if (change === 'role') await db.user.update({ where: { id: person.user.id }, data: { role: 'admin' } });
    else await db.userPermissionOverride.create({ data: { userId: person.user.id, permission: 'lead.read', allowed: false } });
    await assert.rejects(completeGoogleCalendarConnection(db, person.session, input, config, google.transport));
    const state = await db.googleCalendarOAuthState.findUniqueOrThrow({ where: { stateHash: createHash('sha256').update(input.state).digest('hex') } });
    assert.equal(state.consumedAt, null); assert.equal(google.calls.length, 0);
    assert.deepEqual(await counts([person.user.id]), [1, 0, 0, 0]);
  }
});

test('Revocation during a simulated code exchange prevents credential persistence and a blind callback retry', options, async () => {
  const { person, config } = await fixture(), input = await start(person, config);
  const google = fakeGoogle(person, async () => { await db.user.update({ where: { id: person.user.id }, data: { active: false } }); });
  await assert.rejects(completeGoogleCalendarConnection(db, person.session, input, config, google.transport));
  const state = await db.googleCalendarOAuthState.findUniqueOrThrow({ where: { stateHash: createHash('sha256').update(input.state).digest('hex') } });
  assert(state.consumedAt);
  assert.deepEqual(await counts([person.user.id]), [1, 0, 0, 0]);
  const attempts = google.calls.length;
  await assert.rejects(completeGoogleCalendarConnection(db, person.session, input, config, google.transport));
  assert.equal(google.calls.length, attempts);
  assert.equal(google.calls.filter(call => call.grant === 'authorization_code').length, 1);
});

test('Credential refresh rechecks configured identity and fresh permissions before any external call', options, async () => {
  const { person, config } = await fixture(), google = fakeGoogle(person);
  await completeGoogleCalendarConnection(db, person.session, await start(person, config), config, google.transport);
  await db.googleCalendarCredential.update({ where: { userId: person.user.id }, data: { expiresAt: new Date(0) } });
  const before = await db.googleCalendarCredential.findUniqueOrThrow({ where: { userId: person.user.id } }), attempts = google.calls.length;
  await assert.rejects(connectedCalendarAdapter(db, person.user.id, { ...config, pilotUserId: 'other-synthetic-id' }, google.transport));
  await db.userPermissionOverride.create({ data: { userId: person.user.id, permission: 'lead.read', allowed: false } });
  await assert.rejects(connectedCalendarAdapter(db, person.user.id, config, google.transport));
  assert.equal(google.calls.length, attempts);
  assert.deepEqual(await db.googleCalendarCredential.findUniqueOrThrow({ where: { userId: person.user.id } }), before);
});

test('An unconfigured Calendar remains dormant without changing OAuth state, calendars or credentials', options, async () => {
  const { person } = await fixture(), google = fakeGoogle(person), before = await counts([person.user.id]);
  await assert.rejects(beginGoogleCalendarConnection(db, person.session, null));
  await assert.rejects(completeGoogleCalendarConnection(db, person.session, { state: 'a'.repeat(43), code: 'synthetic-code' }, null, google.transport));
  await assert.rejects(connectedCalendarAdapter(db, person.user.id, null, google.transport));
  assert.equal(google.calls.length, 0); assert.deepEqual(await counts([person.user.id]), before);
});
