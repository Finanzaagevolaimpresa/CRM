import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { syntheticPerson } from '../selective-sharing/fixtures';
import { collectionKey } from '../payment-collection/fixture';
import { clientProof } from '../selective-clients/fixtures';
import { initializeCommercialLeadInboxItem, assignCommercialLeadInboxItem, saveSetterCall } from '../../src/lib/commercial-lead-inbox';
import { saveCalendarAvailability, saveLeadAppointment, synchronizeLeadAppointment } from '../../src/lib/personal-calendar';
import { defaultCalendarAvailability, type AppointmentCommand } from '../../src/lib/personal-calendar-contract';
import { GoogleCalendarAdapter } from '../../src/lib/google-calendar-adapter';
import { prepareSetterCommand, type SetterCommand } from '../../src/lib/lead-setter-contract';
import { confirmRecordUpdate, previewRecordUpdate, readRecordUpdateSetup } from '../../src/lib/record-updates';

const db = new PrismaClient(), enabled = process.env.RUN_DB_TESTS === '1';
type Person = Awaited<ReturnType<typeof syntheticPerson>>;
let admin: Person, setter: Person, other: Person, calendarId: string;
const actor = (person: Person) => ({ userId: person.user.id, sessionId: person.session.sessionId! });
before(async () => {
  if (!enabled) return;
  await assertAiOrchestratorEphemeralDatabaseIdentity(db); assert.equal(process.env.APP_ENV, 'test');
  await collectionKey(db);
  admin = await syntheticPerson(db, 'R2 admin sintetico', 'admin');
  setter = await syntheticPerson(db, 'R2 setter sintetico', 'commerciale');
  other = await syntheticPerson(db, 'R2 altro referente sintetico', 'commerciale');
  calendarId = await saveCalendarAvailability(db, setter.session, defaultCalendarAvailability);
  if (!await db.commercialLeadSlaPolicyVersion.count({ where: { status: 'ACTIVE' } })) await db.commercialLeadSlaPolicyVersion.create({ data: {
    policyCode: 'COMMERCIAL_FIRST_RESPONSE', version: 1, status: 'ACTIVE', calendarCode: 'CONTINUOUS_24X7', timezoneCode: 'UTC', responseTargetSeconds: 3600, createdById: admin.user.id } });
});
after(() => db.$disconnect());

async function lead() {
  const row = await db.lead.create({ data: { firstName: 'Persona', lastName: 'Sintetica', companyName: 'R2 ' + randomUUID(), source: 'CRM', leadSource: 'manuale' } });
  const item = await initializeCommercialLeadInboxItem(db, { leadId: row.id, actor: actor(admin), attribution: { originKind: 'MANUAL_CRM' }, reasonCode: 'MANUAL_INTAKE' });
  await assignCommercialLeadInboxItem(db, { leadId: row.id, actor: { ...actor(admin), requireManualAdmin: true }, expectedInboxVersion: item!.version, targetUserId: setter.user.id });
  return row.id;
}
async function booking(leadId: string, local: string, patch: Partial<SetterCommand> = {}): Promise<SetterCommand> {
  const [current, item, appointment] = await Promise.all([db.lead.findUniqueOrThrow({ where: { id: leadId } }),
    db.commercialLeadInboxItem.findUniqueOrThrow({ where: { leadId } }), db.leadAppointment.findUnique({ where: { leadId } })]);
  return { id: randomUUID(), leadId, version: item.version, leadVersion: current.updatedAt.toISOString(), outcome: appointment?.status === 'BOOKED' ? 'VIDEO_DEFERRED' : 'VIDEO_BOOKED',
    nextKind: 'VIDEO', nextLocal: local, details: null, appointment: { id: appointment?.id ?? randomUUID(), calendarId: appointment?.calendarId ?? calendarId,
      expectedVersion: appointment?.version ?? 0, durationMinutes: 30 }, ...patch };
}
const panel = (input: SetterCommand): AppointmentCommand => ({ ...input.appointment!, leadId: input.leadId, leadVersion: input.leadVersion,
  operation: 'BOOK', startLocal: input.nextLocal });
async function snapshot(leadId: string) {
  return Promise.all([db.lead.findUniqueOrThrow({ where: { id: leadId } }), db.leadSetterCall.findMany({ where: { leadId } }),
    db.leadAppointment.findUnique({ where: { leadId } }), db.commercialLeadInboxItem.findUniqueOrThrow({ where: { leadId } }),
    db.commercialLeadSlaCycle.findMany({ where: { inboxItem: { leadId } } }),
    db.auditLog.findMany({ where: { entityType: 'Lead', entityId: leadId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })]);
}
async function unchanged(leadId: string, input: SetterCommand, operation: () => Promise<unknown>, message?: string) {
  const before = await snapshot(leadId), payload = structuredClone(input);
  if (message) await assert.rejects(operation(), { message }); else await assert.rejects(operation());
  assert.deepEqual(await snapshot(leadId), before); assert.deepEqual(input, payload);
}

test('R2: the same occupied CRM slot is rejected atomically through setter and appointment panel', { skip: !enabled }, async () => {
  const occupied = await lead(), requested = await lead();
  await saveLeadAppointment(db, setter.session, panel(await booking(occupied, '2030-01-07T10:00')));
  const input = await booking(requested, '2030-01-07T10:00');
  await unchanged(requested, input, () => saveLeadAppointment(db, setter.session, panel(input)), 'BUSY');
  await unchanged(requested, input, () => saveSetterCall(db, actor(setter), input), 'BUSY');
  const incomplete = { ...input, appointment: undefined };
  await unchanged(requested, incomplete, () => saveSetterCall(db, actor(setter), incomplete));
  const outside = { ...input, nextLocal: '2030-01-07T08:30' };
  await unchanged(requested, outside, () => saveSetterCall(db, actor(setter), outside), 'OUTSIDE_HOURS');
  await unchanged(requested, input, () => saveSetterCall(db, actor(other), input));
  await saveSetterCall(db, actor(setter), { ...input, nextLocal: '2030-01-07T09:00' });
  const move = await booking(requested, '2030-01-07T10:00');
  await unchanged(requested, move, () => saveSetterCall(db, actor(setter), move), 'BUSY');
  await unchanged(requested, move, () => saveLeadAppointment(db, setter.session, panel(move)), 'BUSY');
});

test('R2: a valid setter reservation and concurrent replay preserve one call, one appointment, one first response and immutable history', { skip: !enabled }, async () => {
  const id = await lead(), input = await booking(id, '2030-01-07T11:00'), payload = structuredClone(input);
  const results = await Promise.all([saveSetterCall(db, actor(setter), input), saveSetterCall(db, actor(setter), input)]);
  assert.deepEqual(results.map(r => r.replay).sort(), [false, true]); assert.deepEqual(input, payload);
  const current = await db.lead.findUniqueOrThrow({ where: { id } }), appointment = await db.leadAppointment.findUniqueOrThrow({ where: { leadId: id } });
  assert.equal(current.setterNextKind, 'VIDEO'); assert.equal(current.nextActionDate?.getTime(), appointment.startsAt.getTime());
  assert.equal(appointment.calendarId, calendarId); assert.equal(appointment.syncState, 'LOCAL');
  assert.equal(await db.leadSetterCall.count({ where: { leadId: id } }), 1);
  assert.equal(await db.commercialLeadActivity.count({ where: { inboxItem: { leadId: id }, activityType: 'FIRST_RESPONSE_RECORDED' } }), 1);
  const original = await db.leadSetterCall.findUniqueOrThrow({ where: { id: input.id } });
  await unchanged(id, input, () => saveSetterCall(db, actor(setter), { ...input, nextLocal: '2030-01-07T11:15' }));
  const moved = await booking(id, '2030-01-07T13:00'); await saveSetterCall(db, actor(setter), moved);
  assert.equal(await db.leadAppointment.count({ where: { leadId: id } }), 1);
  assert.equal((await db.leadAppointment.findUniqueOrThrow({ where: { leadId: id } })).version, appointment.version + 1);
  assert.deepEqual(await db.leadSetterCall.findUniqueOrThrow({ where: { id: input.id } }), original);
  const callback = await booking(id, '2030-01-08', { outcome: 'VIDEO_ABSENT', nextKind: 'CALLBACK', appointment: undefined });
  await saveSetterCall(db, actor(setter), callback);
  assert.equal((await db.leadAppointment.findUniqueOrThrow({ where: { leadId: id } })).status, 'CANCELLED');
  assert.equal(await db.leadSetterCall.count({ where: { leadId: id } }), 3);
});

test('R2: setter and appointment panel racing on the same person and slot commit at most one reservation', { skip: !enabled }, async () => {
  const ids = [await lead(), await lead()], calls = await Promise.all(ids.map(id => booking(id, '2030-01-07T14:00')));
  const before = await Promise.all(ids.map(snapshot));
  const results = await Promise.allSettled([saveSetterCall(db, actor(setter), calls[0]), saveLeadAppointment(db, setter.session, panel(calls[1]))]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const failed = results.findIndex(r => r.status === 'rejected'); assert.deepEqual(await snapshot(ids[failed]), before[failed]);
  assert.equal(await db.leadAppointment.count({ where: { leadId: { in: ids }, status: 'BOOKED' } }), 1);
  assert.equal(await db.leadSetterCall.count({ where: { leadId: { in: ids } } }), results[0].status === 'fulfilled' ? 1 : 0);
  const sharedId = await lead(), sameLead = await booking(sharedId, '2030-01-08T14:00');
  const sameLeadResults = await Promise.allSettled([saveSetterCall(db, actor(setter), sameLead),
    saveLeadAppointment(db, setter.session, { ...panel(sameLead), startLocal: '2030-01-08T14:15' })]);
  assert.equal(sameLeadResults.filter(r => r.status === 'fulfilled').length, 1);
  const appointment = await db.leadAppointment.findUniqueOrThrow({ where: { leadId: sharedId } });
  assert.equal(await db.leadAppointment.count({ where: { leadId: sharedId } }), 1);
  assert.equal((await db.lead.findUniqueOrThrow({ where: { id: sharedId } })).nextActionDate?.getTime(), appointment.startsAt.getTime());
  assert.equal(await db.leadSetterCall.count({ where: { leadId: sharedId } }), sameLeadResults[0].status === 'fulfilled' ? 1 : 0);
});

test('R2: Google busy blocks the setter; valid booking, lost response, move and cancellation keep one external event', { skip: !enabled }, async () => {
  const googleOwner = await syntheticPerson(db, 'R2 Google sintetico', 'commerciale');
  const googleCalendarId = await saveCalendarAvailability(db, googleOwner.session, defaultCalendarAvailability);
  await db.personalCalendar.update({ where: { id: googleCalendarId }, data: { mode: 'GOOGLE', googleCalendarId: 'r2-google-synthetic' } });
  const id = await lead(), input = await booking(id, '2030-01-07T15:00'); input.appointment!.calendarId = googleCalendarId;
  let busy = true, lost = true, event: Record<string, unknown> | null = null, inserted = 0, updated = 0, deleted = 0;
  const transport: typeof fetch = async (url, init) => {
    const method = init?.method ?? 'GET', address = String(url);
    assert(address.startsWith('https://www.googleapis.com/calendar/v3/'));
    if (address.endsWith('/freeBusy')) return Response.json({ calendars: { 'r2-google-synthetic': { busy: busy ? [{ start: '2030-01-07T14:00:00Z', end: '2030-01-07T14:30:00Z' }] : [] } } });
    if (method === 'GET') return event ? Response.json(event) : new Response(null, { status: 404 });
    if (method === 'DELETE') { deleted++; event = null; return new Response(null, { status: 204 }); }
    assert(address.includes('sendUpdates=none'));
    const body = JSON.parse(String(init?.body)); assert(!body.attendees);
    event = { ...body, etag: 'r2-' + updated };
    if (method === 'POST') { inserted++; if (lost) { lost = false; throw new Error('synthetic lost response'); } }
    if (method === 'PUT') updated++;
    return Response.json(event);
  };
  const provider = new GoogleCalendarAdapter({ userId: googleOwner.user.id, calendarId: 'r2-google-synthetic', accessToken: 'synthetic-only' }, transport);
  await unchanged(id, input, () => saveSetterCall(db, actor(setter), input), 'UNCONNECTED');
  await unchanged(id, input, () => saveSetterCall(db, actor(setter), input, provider), 'BUSY');
  await unchanged(id, input, () => saveLeadAppointment(db, setter.session, panel(input), provider), 'BUSY');
  assert.equal(inserted, 0);
  busy = false;
  const receipt = await saveSetterCall(db, actor(setter), input, provider); assert(receipt.appointmentId);
  assert.equal((await db.leadAppointment.findUniqueOrThrow({ where: { leadId: id } })).syncState, 'PENDING');
  assert.equal((await saveSetterCall(db, actor(setter), input)).replay, true);
  assert.equal((await synchronizeLeadAppointment(db, setter.session, receipt.appointmentId, provider)).ok, false);
  assert.equal((await synchronizeLeadAppointment(db, setter.session, receipt.appointmentId, provider)).ok, true);
  await saveSetterCall(db, actor(setter), input, provider); await synchronizeLeadAppointment(db, setter.session, receipt.appointmentId, provider);
  assert.equal(inserted, 1); assert.equal(await db.leadSetterCall.count({ where: { leadId: id } }), 1);
  await saveSetterCall(db, actor(setter), await booking(id, '2030-01-07T16:00'), provider);
  await synchronizeLeadAppointment(db, setter.session, receipt.appointmentId, provider); assert.equal(updated, 1);
  await saveSetterCall(db, actor(setter), await booking(id, '2030-01-08', { outcome: 'VIDEO_ABSENT', nextKind: 'CALLBACK', appointment: undefined }));
  await synchronizeLeadAppointment(db, setter.session, receipt.appointmentId, provider);
  await synchronizeLeadAppointment(db, setter.session, receipt.appointmentId, provider);
  assert.equal(deleted, 1); assert.equal(inserted, 1); assert.equal(await db.leadAppointment.count({ where: { leadId: id } }), 1);
});

test('R2: an existing immutable legacy receipt replays, while a new legacy VIDEO cannot bypass reservation', { skip: !enabled }, async () => {
  const id = await lead(), input = await booking(id, '2030-01-08T10:00', { appointment: undefined });
  const { value, nextAt } = prepareSetterCommand(input);
  await db.leadSetterCall.create({ data: { id: input.id, leadId: id, actorId: setter.user.id, outcome: value.outcome, nextKind: 'VIDEO', nextAt,
    details: {}, requestHash: createHash('sha256').update(JSON.stringify(value)).digest('hex') } });
  const before = await snapshot(id);
  assert.equal((await saveSetterCall(db, actor(setter), input)).replay, true); assert.deepEqual(await snapshot(id), before);
  await unchanged(id, input, () => saveSetterCall(db, actor(setter), { ...input, id: randomUUID() }));
});

test('R2: selected record-update commands cannot move a managed or legacy VIDEO around availability', { skip: !enabled }, async () => {
  for (const legacy of [false, true]) {
    const id = await lead();
    if (legacy) await db.lead.update({ where: { id }, data: { setterNextKind: 'VIDEO', nextActionDate: new Date('2030-01-08T13:00:00Z') } });
    else await saveSetterCall(db, actor(setter), await booking(id, '2030-01-08T13:00'));
    const setup = await readRecordUpdateSetup(db, admin.session, 'LEAD', id);
    const input = { commandId: randomUUID(), kind: 'LEAD', recordId: id, operation: 'UPDATE', expectedVersion: setup.expectedVersion, ruleVersion: 0,
      selection: { people: [setter.user.id], groups: [] }, events: ['NEXT_ACTION'], persistent: false, expiresAt: null,
      patch: { kind: 'LEAD', nextActionDate: '2030-01-08T15:00:00.000Z', nextActionNote: 'Synthetic blocked move' } };
    const preview = await previewRecordUpdate(db, admin.session, input), before = await snapshot(id);
    await assert.rejects(confirmRecordUpdate(db, admin.session, input, preview.digest, clientProof(admin)), { message: 'BUSY' });
    assert.deepEqual(await snapshot(id), before);
    assert.equal(await db.recordUpdateCommand.count({ where: { id: input.commandId } }), 0);
  }
});
