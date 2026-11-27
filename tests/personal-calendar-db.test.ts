import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from './db/ai-orchestrator-db-test-guard';
import { syntheticPerson } from './selective-sharing/fixtures';
import { saveCalendarAvailability, saveLeadAppointment, synchronizeLeadAppointment, assertPipelineAppointmentUnchanged } from '../src/lib/personal-calendar';
import { defaultCalendarAvailability, pipelineNextActionDate, type AppointmentCommand } from '../src/lib/personal-calendar-contract';
import { romeDateTimeInput } from '../src/lib/rome-date-time';
import { beginGoogleCalendarConnection, completeGoogleCalendarConnection, decryptCalendarSecret, type CalendarOAuthConfig } from '../src/lib/google-calendar-oauth';
import { getInternalNotifications, getInternalNotificationCount, markInternalNotificationRead } from '../src/lib/internal-notifications';
import { GoogleCalendarAdapter } from '../src/lib/google-calendar-adapter';

const enabled = process.env.RUN_DB_TESTS === '1', db = new PrismaClient();
type Person = Awaited<ReturnType<typeof syntheticPerson>>;
let owner: Person, other: Person, tech: Person, calendarId: string;
const day = new Date(Date.now() + 7 * 86400_000);
while (day.getUTCDay() !== 1) day.setUTCDate(day.getUTCDate() + 1);
const monday = day.toISOString().slice(0, 10);
before(async () => {
  if (!enabled) return;
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  assert.equal(process.env.APP_ENV, 'test');
  owner = await syntheticPerson(db, 'Ivo calendario sintetico', 'commerciale');
  other = await syntheticPerson(db, 'Altro calendario sintetico', 'commerciale');
  tech = await syntheticPerson(db, 'Tecnico calendario sintetico', 'consulente');
  calendarId = await saveCalendarAvailability(db, owner.session, defaultCalendarAvailability);
  await saveCalendarAvailability(db, tech.session, defaultCalendarAvailability);
});
after(async () => { await db.$disconnect(); });
async function newLead() {
  return db.lead.create({ data: { firstName: 'Appuntamento', lastName: 'Sintetico', assignedToId: owner.user.id, leadSource: 'manuale' } });
}
async function command(leadId: string, patch: Partial<AppointmentCommand> = {}): Promise<AppointmentCommand> {
  const [lead, appointment] = await Promise.all([db.lead.findUniqueOrThrow({ where: { id: leadId } }), db.leadAppointment.findUnique({ where: { leadId } })]);
  return { id: appointment?.id ?? randomUUID(), leadId, calendarId, expectedVersion: appointment?.version ?? 0,
    leadVersion: lead.updatedAt.toISOString(), operation: 'BOOK', startLocal: monday + 'T10:00', durationMinutes: 30, ...patch };
}

test('Calendar persistence rejects another role and occupied slots, handles replay/move/cancel without duplicate lead or event', { skip: !enabled }, async () => {
  const lead = await newLead(), input = await command(lead.id);
  await assert.rejects(saveLeadAppointment(db, other.session, input));
  await assert.rejects(saveLeadAppointment(db, tech.session, input));
  const booked = await saveLeadAppointment(db, owner.session, input);
  const replay = await saveLeadAppointment(db, owner.session, input);
  assert.equal(replay.id, booked.id); assert.equal(replay.version, booked.version);
  const second = await newLead();
  await assert.rejects(saveLeadAppointment(db, owner.session, await command(second.id)), { message: 'BUSY' });
  const moved = await saveLeadAppointment(db, owner.session, await command(lead.id, { startLocal: monday + 'T11:00' }));
  assert.equal(moved.id, booked.id); assert.equal(moved.generation, booked.generation);
  assert.equal(moved.version, booked.version + 1);
  const afterMove = await db.lead.findUniqueOrThrow({ where: { id: lead.id } });
  assert.equal(afterMove.setterNextKind, 'VIDEO'); assert.equal(afterMove.nextActionDate?.getTime(), moved.startsAt.getTime());
  const cancelled = await saveLeadAppointment(db, owner.session, await command(lead.id, { operation: 'CANCEL' }));
  await saveLeadAppointment(db, owner.session, await command(lead.id, { operation: 'CANCEL' }));
  assert.equal(cancelled.status, 'CANCELLED');
  assert.equal(await db.leadAppointment.count({ where: { leadId: lead.id } }), 1);
  assert.equal((await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).nextActionDate, null);
  const rebook = await saveLeadAppointment(db, owner.session, await command(lead.id, { startLocal: monday + 'T12:00' }));
  assert.equal(rebook.generation, booked.generation + 1);
});

test('Two concurrent requests for the same person and interval reserve at most one appointment', { skip: !enabled }, async () => {
  const first = await newLead(), second = await newLead();
  const inputs = await Promise.all([command(first.id, { startLocal: monday + 'T14:00' }), command(second.id, { startLocal: monday + 'T14:00' })]);
  const results = await Promise.allSettled(inputs.map(input => saveLeadAppointment(db, owner.session, input)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(await db.leadAppointment.count({ where: { leadId: { in: [first.id, second.id] }, status: 'BOOKED' } }), 1);
});

test('Pipeline notes and priority preserve a booked video, while changing or clearing its date rolls back', { skip: !enabled }, async () => {
  const lead = await newLead(), booked = await saveLeadAppointment(db, owner.session, await command(lead.id, { startLocal: monday + 'T15:00' }));
  const applyPipeline = (local: string, notes: string) => db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Lead" WHERE id=${lead.id} FOR UPDATE`;
    const current = await tx.lead.findUniqueOrThrow({ where: { id: lead.id } });
    const date = pipelineNextActionDate(local, current.nextActionDate, 'Europe/Rome');
    await assertPipelineAppointmentUnchanged(tx, current, date);
    return tx.lead.update({ where: { id: lead.id }, data: { notes, priority: 'alta', nextActionDate: date, nextAction: date } });
  });
  const saved = await applyPipeline(romeDateTimeInput(booked.startsAt).slice(0, 16), 'Note aggiornate senza spostamento');
  assert.equal(saved.priority, 'alta'); assert.equal(saved.notes, 'Note aggiornate senza spostamento');
  assert.equal(saved.nextActionDate?.getTime(), booked.startsAt.getTime());
  await assert.rejects(applyPipeline(monday + 'T15:15', 'Tentativo non ammesso'), { message: 'BUSY' });
  await assert.rejects(applyPipeline('', 'Tentativo cancellazione non ammesso'), { message: 'BUSY' });
  assert.deepEqual(await db.lead.findUniqueOrThrow({ where: { id: lead.id } }), saved);
  assert.deepEqual(await db.leadAppointment.findUniqueOrThrow({ where: { leadId: lead.id } }), booked);
});

test('Notice click decreases count exactly once, preserves queue and read history, and rechecks current ownership', { skip: !enabled }, async () => {
  const lead = await newLead();
  await db.lead.update({ where: { id: lead.id }, data: { nextActionDate: new Date(Date.now() - 3600_000), setterNextKind: 'CALLBACK' } });
  const rows = await getInternalNotifications(owner.session), notice = rows.find(row => row.href === '/leads/' + lead.id)!;
  assert(notice);
  assert.equal(rows.length, await getInternalNotificationCount(owner.session));
  assert.equal(await markInternalNotificationRead(other.session, notice.id), null);
  await Promise.all([markInternalNotificationRead(owner.session, notice.id), markInternalNotificationRead(owner.session, notice.id)]);
  assert.equal(await getInternalNotificationCount(owner.session), rows.length - 1);
  await markInternalNotificationRead(owner.session, notice.id);
  assert.equal(await getInternalNotificationCount(owner.session), rows.length - 1);
  assert.equal(await db.internalNotificationRead.count({ where: { recipientId: owner.user.id, notificationId: notice.id } }), 1);
  assert((await getInternalNotifications(owner.session, { state: 'read' })).some(row => row.id === notice.id));
  assert.equal((await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).setterNextKind, 'CALLBACK');
  await db.lead.update({ where: { id: lead.id }, data: { companyName: 'Etichetta corrente sintetica' } });
  assert.equal((await getInternalNotifications(owner.session, { state: 'read' })).find(row => row.id === notice.id)?.title, 'Etichetta corrente sintetica');
  await db.lead.update({ where: { id: lead.id }, data: { status: 'perso' } });
  assert((await getInternalNotifications(owner.session, { state: 'read' })).some(row => row.id === notice.id));
  await db.lead.update({ where: { id: lead.id }, data: { assignedToId: other.user.id } });
  assert(!(await getInternalNotifications(owner.session, { state: 'read' })).some(row => row.id === notice.id));
  assert.equal(await markInternalNotificationRead(owner.session, notice.id), null);
});

test('OAuth callback rejects wrong recipient, consumes state once, encrypts per-user tokens and verifies primary calendar', { skip: !enabled }, async () => {
  const config: CalendarOAuthConfig = { clientId: 'synthetic-client', clientSecret: 'synthetic-secret', pilotUserId: owner.user.id,
    redirectUri: 'http://127.0.0.1:3059/settings/integrations/google-calendar/callback', key: randomBytes(32) };
  const target = new URL(await beginGoogleCalendarConnection(db, owner.session, config));
  assert.equal(target.origin, 'https://accounts.google.com');
  assert.equal(target.searchParams.get('code_challenge_method'), 'S256');
  const state = target.searchParams.get('state')!;
  let exchanges = 0;
  const transport: typeof fetch = async (url, init) => {
    if (String(url) === 'https://oauth2.googleapis.com/token') {
      exchanges++;
      const params = new URLSearchParams(String(init?.body));
      assert.equal(params.get('grant_type'), 'authorization_code');
      assert(params.get('code_verifier')!.length >= 43);
      assert.equal(createHash('sha256').update(params.get('code_verifier')!).digest('base64url'), target.searchParams.get('code_challenge'));
      return Response.json({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', token_type: 'Bearer', expires_in: 3600, scope: target.searchParams.get('scope') });
    }
    if (String(url).endsWith('/userinfo')) return Response.json({ sub: 'synthetic-ivo-subject' });
    if (String(url).endsWith('/primary')) return Response.json({ id: 'synthetic-ivo-calendar', primary: true, accessRole: 'owner' });
    throw new Error('Unexpected external endpoint');
  };
  await assert.rejects(completeGoogleCalendarConnection(db, other.session, { state, code: 'synthetic-code' }, config, transport));
  assert.equal(exchanges, 0);
  const expired = new URL(await beginGoogleCalendarConnection(db, owner.session, config)).searchParams.get('state')!;
  await db.googleCalendarOAuthState.update({ where: { stateHash: createHash('sha256').update(expired).digest('hex') }, data: { expiresAt: new Date(Date.now() - 1) } });
  await assert.rejects(completeGoogleCalendarConnection(db, owner.session, { state: expired, code: 'synthetic-code' }, config, transport));
  assert.equal(exchanges, 0);
  await completeGoogleCalendarConnection(db, owner.session, { state, code: 'synthetic-code' }, config, transport);
  await assert.rejects(completeGoogleCalendarConnection(db, owner.session, { state, code: 'synthetic-code' }, config, transport));
  assert.equal(exchanges, 1);
  const credential = await db.googleCalendarCredential.findUniqueOrThrow({ where: { userId: owner.user.id } });
  assert.notEqual(credential.accessTokenCiphertext, 'synthetic-access');
  assert.equal(decryptCalendarSecret(credential.accessTokenCiphertext, 'access:' + owner.user.id, config.key), 'synthetic-access');
  const calendar = await db.personalCalendar.findUniqueOrThrow({ where: { userId: owner.user.id } });
  assert.equal(calendar.googleCalendarId, 'synthetic-ivo-calendar'); assert.equal(calendar.mode, 'GOOGLE');
});

test('More than 500 queue notices do not refill a truncated counter after one click', { skip: !enabled }, async () => {
  const recipient = await syntheticPerson(db, 'Destinatario oltre limite sintetico', 'commerciale');
  await db.task.createMany({ data: Array.from({ length: 503 }, (_, index) => ({ title: 'Task sintetico ' + index,
    assignedToId: recipient.user.id, createdById: recipient.user.id, dueAt: new Date(Date.now() - 60_000) })) });
  const rows = await getInternalNotifications(recipient.session);
  assert.equal(rows.length, 503); assert.equal(await getInternalNotificationCount(recipient.session), 503);
  await markInternalNotificationRead(recipient.session, rows[0].id);
  assert.equal(await getInternalNotificationCount(recipient.session), 502);
  assert.equal((await getInternalNotifications(recipient.session)).length, 502);
});

test('Persisted Google synchronization reconciles an uncertain insert, then moves/cancels the same event once', { skip: !enabled }, async () => {
  const lead = await newLead();
  let event: Record<string, unknown> | null = null, external: Record<string, unknown> | null = null,
    insertions = 0, moves = 0, cancellations = 0, loseResponse = true;
  const transport: typeof fetch = async (input, init) => {
    const url = String(input), method = init?.method ?? 'GET';
    if (url.endsWith('/freeBusy')) return Response.json({ calendars: { 'synthetic-ivo-calendar': { busy: [event, external].flatMap(row => row ? [{
      start: (row.start as { dateTime: string }).dateTime, end: (row.end as { dateTime: string }).dateTime }] : []) } } });
    if (method === 'GET' && new URL(url).pathname.endsWith('/events')) return Response.json({ accessRole: 'owner', items: [event, external].filter(Boolean) });
    if (method === 'GET') return event ? Response.json(event) : new Response(null, { status: 404 });
    if (method === 'DELETE') { cancellations++; event = null; return new Response(null, { status: 204 }); }
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    event = { ...body, etag: 'synthetic-etag-' + moves };
    if (method === 'POST') { insertions++; if (loseResponse) { loseResponse = false; throw new Error('synthetic response loss'); } }
    else if (method === 'PUT') moves++;
    return Response.json(event);
  };
  const adapter = new GoogleCalendarAdapter({ userId: owner.user.id, calendarId: 'synthetic-ivo-calendar', accessToken: 'synthetic-only' }, transport);
  const row = await saveLeadAppointment(db, owner.session, await command(lead.id, { startLocal: monday + 'T16:00' }), adapter);
  assert.equal(row.syncState, 'PENDING');
  const uncertain = await synchronizeLeadAppointment(db, owner.session, row.id, adapter);
  assert.equal(uncertain.ok, false);
  assert.equal((await db.leadAppointment.findUniqueOrThrow({ where: { id: row.id } })).syncState, 'UNCERTAIN');
  assert.equal((await synchronizeLeadAppointment(db, owner.session, row.id, adapter)).ok, true);
  assert.equal(insertions, 1);
  const synced = await db.leadAppointment.findUniqueOrThrow({ where: { id: row.id } });
  external = { id: 'external-busy', etag: 'external-etag', start: { dateTime: synced.startsAt.toISOString() },
    end: { dateTime: synced.endsAt.toISOString() } };
  await assert.rejects(saveLeadAppointment(db, owner.session, await command(lead.id, { startLocal: monday + 'T16:15' }), adapter), { message: 'BUSY' });
  assert.equal((await db.leadAppointment.findUniqueOrThrow({ where: { id: row.id } })).version, synced.version);
  external = null;
  await saveLeadAppointment(db, owner.session, await command(lead.id, { startLocal: monday + 'T16:15' }), adapter);
  assert.equal((await synchronizeLeadAppointment(db, owner.session, row.id, adapter)).ok, true);
  assert.equal(moves, 1);
  assert.equal((await db.leadAppointment.findUniqueOrThrow({ where: { id: row.id } })).externalEventId, synced.externalEventId);
  await saveLeadAppointment(db, owner.session, await command(lead.id, { operation: 'CANCEL' }), adapter);
  await synchronizeLeadAppointment(db, owner.session, row.id, adapter);
  await synchronizeLeadAppointment(db, owner.session, row.id, adapter);
  assert.equal(cancellations, 1); assert.equal(insertions, 1);
  assert.equal((await db.leadAppointment.findUniqueOrThrow({ where: { id: row.id } })).status, 'CANCELLED');
  // A previously obtained adapter does not preserve authority after its owner
  // is disabled, even when another currently admitted actor requests a sync.
  const admin = await syntheticPerson(db, 'Admin revoca calendario sintetico', 'admin');
  await db.user.update({ where: { id: owner.user.id }, data: { active: false } });
  await assert.rejects(synchronizeLeadAppointment(db, admin.session, row.id, adapter), { message: 'DENIED' });
  assert.equal(cancellations, 1);
});
