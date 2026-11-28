import assert from 'node:assert/strict';
import { PrismaClient, type RoleCode } from '@prisma/client';
import { hash } from 'bcryptjs';
import { encryptCalendarSecret } from '../../src/lib/google-calendar-oauth';
import { defaultCalendarAvailability } from '../../src/lib/personal-calendar-contract';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';

export const agendaIds = { pilot: 'f0000000-2026-4000-8000-000000000301', setter: 'f0000000-2026-4000-8000-000000000302',
  admin: 'agenda-admin-synthetic', other: 'agenda-other-synthetic', technical: 'agenda-technical-synthetic', foreignTechnical: 'agenda-foreign-technical-synthetic' };
export const agendaDate = '2030-06-03';
export const agendaPrivateMarker = 'AGENDA_CONTATTO_RISERVATO';
export async function provisionAgenda(db: PrismaClient) {
  assert.equal(process.env.APP_ENV, 'test'); await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  assert.equal(process.env.GOOGLE_CALENDAR_PILOT_USER_ID, agendaIds.pilot);
  assert.equal(process.env.CALENDAR_SETTER_USER_ID, agendaIds.setter);
  const passwordHash = await hash('Synthetic-only-Agenda-2030', 4);
  for (const [key, id] of Object.entries(agendaIds)) {
    const role: RoleCode = key === 'admin' ? 'admin' : key.toLowerCase().includes('technical') ? 'consulente' : 'commerciale';
    const email = 'agenda-' + key + '@agenda.invalid.test', name = 'Agenda ' + key + ' · sintetico';
    const user = await db.user.upsert({ where: { id }, create: { id, name, email, role, passwordHash }, update: {} });
    assert.equal(user.email, email); assert.equal(user.role, role); assert.equal(user.name, name);
    await db.personalCalendar.upsert({ where: { userId: id }, create: { userId: id, availability: defaultCalendarAvailability }, update: {} });
  }
  const pilotCalendar = await db.personalCalendar.update({ where: { userId: agendaIds.pilot }, data: {
    mode: 'GOOGLE', googleCalendarId: 'agenda-synthetic-primary', credentialReference: 'GOOGLE_CALENDAR:' + agendaIds.pilot } });
  const key = Buffer.alloc(32);
  await db.googleCalendarCredential.upsert({ where: { userId: agendaIds.pilot }, create: { userId: agendaIds.pilot,
    googleSubject: 'AGENDA_SYNTHETIC_SUBJECT', accessTokenCiphertext: encryptCalendarSecret('agenda-synthetic-access', 'access:' + agendaIds.pilot, key),
    refreshTokenCiphertext: encryptCalendarSecret('agenda-synthetic-refresh', 'refresh:' + agendaIds.pilot, key),
    expiresAt: new Date(Date.now() + 86_400_000), scopes: 'synthetic-test-only' }, update: {} });
  const technicalCalendar = await db.personalCalendar.findUniqueOrThrow({ where: { userId: agendaIds.technical } });
  const rows = [
    { id: 'agenda-booked', firstName: 'Ada', lastName: 'Esempio', companyName: 'Officina Dimostrativa', day: '03', hour: '07:00', status: 'BOOKED', calendar: pilotCalendar.id },
    { id: 'agenda-cancelled', firstName: 'Luca', lastName: 'Demo', companyName: 'Laboratorio Sintetico', day: '05', hour: '08:00', status: 'CANCELLED', calendar: pilotCalendar.id },
    { id: 'agenda-completed', firstName: 'Marta', lastName: 'Campione', companyName: 'Studio Dimostrativo', day: '06', hour: '09:00', status: 'COMPLETED', calendar: pilotCalendar.id },
    { id: 'agenda-technical-private', firstName: agendaPrivateMarker, lastName: 'Persona', companyName: agendaPrivateMarker, day: '03', hour: '09:00', status: 'BOOKED', calendar: technicalCalendar.id },
  ];
  for (const [index, row] of rows.entries()) {
    const startsAt = new Date('2030-06-' + row.day + 'T' + row.hour + ':00Z');
    const lead = await db.lead.upsert({ where: { id: row.id }, create: { id: row.id, firstName: row.firstName, lastName: row.lastName,
      companyName: row.companyName, assignedToId: row.id === 'agenda-technical-private' ? agendaIds.setter : agendaIds.pilot, setterNextKind: 'VIDEO', nextActionDate: startsAt,
      notes: 'AGENDA_PRIVATE_NOTE_EXCLUDED' }, update: {} });
    assert.equal(lead.firstName, row.firstName);
    await db.leadAppointment.upsert({ where: { leadId: lead.id }, create: { id: 'f0000000-2030-4000-8000-' + String(index + 1).padStart(12, '0'),
      leadId: lead.id, calendarId: row.calendar, startsAt, endsAt: new Date(startsAt.getTime() + 45 * 60_000), status: row.status,
      createdById: agendaIds.setter, updatedById: agendaIds.setter }, update: {} });
    // Completed/cancelled cases no longer carry the matching upcoming action.
    if (row.status !== 'BOOKED') await db.lead.update({ where: { id: lead.id }, data: { nextActionDate: null } });
  }
  await db.lead.upsert({ where: { id: 'agenda-legacy-call' }, create: { id: 'agenda-legacy-call', firstName: 'Bruno', lastName: 'Prova',
    companyName: 'Impresa Esempio', assignedToId: agendaIds.pilot, setterNextKind: 'CALLBACK', nextActionDate: new Date('2030-06-04T13:00:00Z') }, update: {} });
  for (const [suffix, owner] of [['own', agendaIds.technical], ['foreign', agendaIds.foreignTechnical]] as const) {
    const client = await db.client.upsert({ where: { id: 'agenda-client-' + suffix }, create: {
      id: 'agenda-client-' + suffix, type: 'societa', displayName: 'Cliente tecnico ' + suffix + ' sintetico', consultantId: owner }, update: {} });
    await db.technicalPractice.upsert({ where: { id: 'agenda-practice-' + suffix }, create: { id: 'agenda-practice-' + suffix,
      clientId: client.id, technicalOwnerId: owner, title: suffix === 'own' ? 'Pratica agenda assegnata' : 'AGENDA_PRATICA_ALTRUI',
      practiceType: 'test-sintetico', targetEntity: 'Ente sintetico', createdById: agendaIds.admin }, update: {} });
  }
}
