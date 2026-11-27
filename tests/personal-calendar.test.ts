import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { appointmentInterval, availabilitySchema, defaultCalendarAvailability, intervalsOverlap, withinAvailability, pipelineNextActionDate } from '../src/lib/personal-calendar-contract';
import { GoogleCalendarAdapter, googleAppointmentId } from '../src/lib/google-calendar-adapter';
import { calendarOAuthConfig, encryptCalendarSecret, decryptCalendarSecret } from '../src/lib/google-calendar-oauth';
import { notificationOccurrenceId, notificationSnapshot, notificationSourceId, unreadNotifications } from '../src/lib/internal-notification-read-contract';

test('Rome availability rejects gaps, ambiguous autumn hours, overlaps and back-to-back conflict only when real', () => {
  assert.throws(() => appointmentInterval('2027-03-28T02:30', 30));
  assert.throws(() => appointmentInterval('2027-10-31T02:30', 30));
  const morning = appointmentInterval('2027-01-11T09:00', 30);
  assert(withinAvailability(defaultCalendarAvailability, morning));
  assert(!withinAvailability(defaultCalendarAvailability, appointmentInterval('2027-01-11T17:45', 30)));
  assert(!withinAvailability(defaultCalendarAvailability, appointmentInterval('2027-01-10T10:00', 30)));
  assert(!intervalsOverlap(morning, appointmentInterval('2027-01-11T09:30', 30)));
  assert(intervalsOverlap(morning, appointmentInterval('2027-01-11T09:15', 30)));
  assert(!availabilitySchema.safeParse([{ weekday: 1, startMinute: 540, endMinute: 660 }, { weekday: 1, startMinute: 600, endMinute: 700 }]).success);
});

test('Pipeline dates use declared Rome time in every host timezone and preserve the exact unchanged autumn instant', () => {
  const previous = process.env.TZ;
  try {
    for (const zone of ['UTC', 'America/Los_Angeles', 'Europe/Rome']) {
      process.env.TZ = zone;
      assert.equal(pipelineNextActionDate('2027-01-11T10:15', null, 'Europe/Rome')?.toISOString(), '2027-01-11T09:15:00.000Z');
      assert.equal(pipelineNextActionDate('2027-01-11T09:15:00.000Z', null, null)?.toISOString(), '2027-01-11T09:15:00.000Z');
      const recorded = new Date('2027-10-31T01:30:47.123Z');
      assert.equal(pipelineNextActionDate('2027-10-31T02:30', recorded, 'Europe/Rome')?.toISOString(), recorded.toISOString());
      assert.equal(pipelineNextActionDate('2027-10-31T02:30:47', recorded, 'Europe/Rome')?.toISOString(), recorded.toISOString());
      assert.throws(() => pipelineNextActionDate('2027-10-31T02:45', recorded, 'Europe/Rome'), { message: 'INVALID' });
      assert.throws(() => pipelineNextActionDate('2027-03-28T02:30', null, 'Europe/Rome'), { message: 'INVALID' });
      assert.throws(() => pipelineNextActionDate('2027-01-11T10:15', null, null), { message: 'INVALID' });
      assert.throws(() => pipelineNextActionDate('2027-01-11T10:15', null, 'UTC'), { message: 'INVALID' });
      assert.equal(pipelineNextActionDate('', recorded, 'Europe/Rome'), null);
    }
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});

function fakeGoogle() {
  const events = new Map<string, Record<string, unknown>>();
  const calls: { method: string; url: string; body: Record<string, unknown> | null }[] = [];
  let failAfterInsert = false;
  let busy: { start: string; end: string }[] = [];
  let busyError = false;
  let paginate = false;
  const transport: typeof fetch = async (input, init) => {
    const url = String(input), method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    calls.push({ method, url, body });
    assert(url.startsWith('https://www.googleapis.com/calendar/v3/'));
    const matchingEvents = (from: string, until: string) => [...events.values()].filter(row => {
      const start = row.start as { dateTime: string }, end = row.end as { dateTime: string };
      return row.status !== 'cancelled' && row.transparency !== 'transparent' && start.dateTime < until && end.dateTime > from;
    });
    if (url.endsWith('/freeBusy')) return Response.json({ calendars: { 'test-calendar': busyError ? { errors: [{ reason: 'forbidden' }] }
      : { busy: [...busy, ...matchingEvents(String(body!.timeMin), String(body!.timeMax)).map(row => ({
        start: (row.start as { dateTime: string }).dateTime, end: (row.end as { dateTime: string }).dateTime }))] } } });
    if (method === 'GET' && new URL(url).pathname.endsWith('/events')) {
      const params = new URL(url).searchParams, matching = matchingEvents(params.get('timeMin')!, params.get('timeMax')!);
      if (!paginate) return Response.json({ accessRole: 'owner', items: matching });
      return Response.json({ accessRole: 'owner', items: params.has('pageToken') ? matching.slice(1) : matching.slice(0, 1),
        ...(!params.has('pageToken') && matching.length > 1 ? { nextPageToken: 'second' } : {}) });
    }
    const id = url.split('/').at(-1)!.split('?')[0];
    if (method === 'GET') return events.has(id) ? Response.json(events.get(id)) : new Response(null, { status: 404 });
    if (method === 'DELETE') { events.delete(id); return new Response(null, { status: 204 }); }
    const eventId = String(body!.id), current = events.get(eventId);
    if (method === 'POST' && current) return new Response(null, { status: 409 });
    if (method === 'PUT') assert.equal((init?.headers as Record<string, string>)['If-Match'], current?.etag);
    const saved = { ...body, etag: 'etag-' + calls.length };
    events.set(eventId, saved);
    if (method === 'POST' && failAfterInsert) { failAfterInsert = false; throw new Error('synthetic lost response'); }
    return Response.json(saved);
  };
  return { transport, calls, events, setBusy: (value: typeof busy) => { busy = value; }, setBusyError: () => { busyError = true; },
    paginate: () => { paginate = true; },
    failNextInsertResponse: () => { failAfterInsert = true; } };
}

test('Google create/replay/move/cancel uses one deterministic event and no guests', async () => {
  const fake = fakeGoogle(), adapter = new GoogleCalendarAdapter({ userId: 'ivo-synthetic', calendarId: 'test-calendar', accessToken: 'synthetic-only-token' }, fake.transport);
  const event = { id: 'appointment-synthetic:1', ...appointmentInterval('2027-01-11T10:00', 30), cancelled: false };
  const first = await adapter.synchronize(event);
  assert.equal(first.eventId, googleAppointmentId(event.id));
  await adapter.synchronize(event);
  assert.equal(fake.calls.filter(call => call.method === 'POST' && !call.url.endsWith('/freeBusy')).length, 1);
  const moved = { ...event, ...appointmentInterval('2027-01-11T11:00', 45) };
  await adapter.synchronize(moved);
  assert.equal(fake.events.size, 1);
  assert.equal(fake.calls.filter(call => call.method === 'PUT').length, 1);
  await adapter.synchronize({ ...moved, cancelled: true });
  await adapter.synchronize({ ...moved, cancelled: true });
  assert.equal(fake.calls.filter(call => call.method === 'DELETE').length, 1);
  assert.equal(fake.events.size, 0);
  assert(fake.calls.filter(call => ['POST', 'PUT', 'DELETE'].includes(call.method) && !call.url.endsWith('/freeBusy')).every(call => call.url.includes('sendUpdates=none')));
  assert(fake.calls.every(call => !call.body || !('attendees' in call.body)));
});

test('An overlapping move excludes only its authenticated event and still rejects another event on a later page', async () => {
  const fake = fakeGoogle(), adapter = new GoogleCalendarAdapter({ userId: 'ivo-synthetic', calendarId: 'test-calendar', accessToken: 'synthetic-only-token' }, fake.transport);
  const event = { id: 'overlapping-move:1', ...appointmentInterval('2027-01-11T10:00', 30), cancelled: false };
  await adapter.synchronize(event);
  const moved = { ...event, ...appointmentInterval('2027-01-11T10:15', 30) };
  await adapter.assertAvailable(moved.startsAt, moved.endsAt, moved.id);
  await adapter.synchronize(moved);
  assert.equal(fake.events.size, 1);
  const overlapping = appointmentInterval('2027-01-11T10:20', 15);
  fake.events.set('external-event', { id: 'external-event', etag: 'external-etag',
    start: { dateTime: overlapping.startsAt.toISOString() }, end: { dateTime: overlapping.endsAt.toISOString() } });
  fake.paginate();
  const next = { ...event, ...appointmentInterval('2027-01-11T10:20', 15) };
  await assert.rejects(adapter.assertAvailable(next.startsAt, next.endsAt, next.id), { message: 'BUSY' });
  await assert.rejects(adapter.synchronize(next), { message: 'BUSY' });
  assert(fake.calls.some(call => call.url.includes('pageToken=second')));
  assert.equal(fake.calls.filter(call => call.method === 'PUT').length, 1);
});

test('An uncertain insert is reconciled by GET before a second write', async () => {
  const fake = fakeGoogle(), adapter = new GoogleCalendarAdapter({ userId: 'ivo-synthetic', calendarId: 'test-calendar', accessToken: 'synthetic-only-token' }, fake.transport);
  const event = { id: 'appointment-synthetic:1', ...appointmentInterval('2027-01-11T10:00', 30), cancelled: false };
  fake.failNextInsertResponse();
  await assert.rejects(adapter.synchronize(event), { message: 'UNCERTAIN' });
  await adapter.synchronize(event);
  assert.equal(fake.calls.filter(call => call.method === 'POST' && !call.url.endsWith('/freeBusy')).length, 1);
  assert.equal(fake.events.size, 1);
});

test('free/busy honors provider errors instead of treating unavailable data as free', async () => {
  const fake = fakeGoogle(), adapter = new GoogleCalendarAdapter({ userId: 'ivo-synthetic', calendarId: 'test-calendar', accessToken: 'synthetic-only-token' }, fake.transport);
  const interval = appointmentInterval('2027-01-11T10:00', 30);
  fake.setBusy([{ start: interval.startsAt.toISOString(), end: interval.endsAt.toISOString() }]);
  assert.deepEqual(await adapter.freeBusy(interval.startsAt, interval.endsAt), [interval]);
  fake.setBusyError();
  await assert.rejects(adapter.freeBusy(interval.startsAt, interval.endsAt), { message: 'UNCERTAIN' });
  assert(adapter.owns('ivo-synthetic', 'test-calendar'));
  assert(!adapter.owns('another-user', 'test-calendar'));
});

test('OAuth is dormant by default, rejects foreign callbacks and seals tokens to one user/purpose', () => {
  assert.equal(calendarOAuthConfig({}), null);
  const key = randomBytes(32), config = { FEATURE_INTEGRATIONS_ENABLED: 'true', GOOGLE_CALENDAR_INTEGRATION_MODE: 'enabled',
    GOOGLE_CALENDAR_PILOT_USER_ID: 'ivo-synthetic',
    GOOGLE_CALENDAR_OAUTH_CLIENT_ID: 'synthetic-client', GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET: 'synthetic-secret',
    GOOGLE_CALENDAR_OAUTH_REDIRECT_URI: 'http://127.0.0.1:3059/settings/integrations/google-calendar/callback',
    GOOGLE_CALENDAR_TOKEN_KEY: key.toString('base64'), APP_ORIGIN: 'http://127.0.0.1:3059' };
  assert(calendarOAuthConfig(config));
  assert.equal(calendarOAuthConfig({ ...config, APP_ORIGIN: 'https://other.invalid' }), null);
  assert.equal(calendarOAuthConfig({ ...config, FEATURE_INTEGRATIONS_ENABLED: 'false' }), null);
  const sealed = encryptCalendarSecret('synthetic-secret-only', 'access:ivo', key);
  assert(!sealed.includes('synthetic-secret-only'));
  assert.equal(decryptCalendarSecret(sealed, 'access:ivo', key), 'synthetic-secret-only');
  assert.throws(() => decryptCalendarSecret(sealed, 'access:other', key));
  assert.throws(() => decryptCalendarSecret(sealed, 'refresh:ivo', key));
  assert.throws(() => decryptCalendarSecret(sealed, 'access:ivo', randomBytes(32)));
});

test('Read receipts isolate recipient state, future queue occurrences and prevent unsafe redirects', () => {
  const date = new Date('2027-01-11T09:00:00Z'), source = 'lead-synthetic';
  const first = { id: notificationOccurrenceId(source, date) }, next = { id: notificationOccurrenceId(source, new Date(date.getTime() + 86400_000)) };
  const ownerRead = new Set([first.id]);
  assert.equal(unreadNotifications([first], ownerRead).length, 0);
  assert.equal(unreadNotifications([first], new Set()).length, 1);
  assert.deepEqual(unreadNotifications([first, next], ownerRead), [next]);
  assert.equal(notificationSourceId(first.id), notificationSourceId(next.id));
  assert(!notificationSnapshot.safeParse({ id: 'x', title: '', category: '', priority: 'media', date: null, related: null, href: '//evil.invalid' }).success);
});
