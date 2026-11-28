import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { syntheticPerson } from '../selective-sharing/fixtures';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { resolveRomeDateTime, romeDateTimeInput } from '../../src/lib/rome-date-time';

export const calendarPilotId = 'f0000000-2026-4000-8000-000000000101';
export const calendarSetterId = 'f0000000-2026-4000-8000-000000000102';
const privateLeadId = 'f0000000-2026-4000-8000-000000000201';
const privateMarker = 'CALENDAR_PRIVATE_LEAD_PERIMETER_R01';
export type CalendarPerimeterFixture = {
  synthetic: true; pilotId: string; setterId: string; adminId: string; otherId: string; technicalId: string;
  inactiveId: string; deletedId: string; date: string; privateLeadId: string; privateMarker: string;
};

export async function provisionCalendarPerimeter(db: PrismaClient): Promise<CalendarPerimeterFixture> {
  assert.equal(process.env.APP_ENV, 'test');
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  assert.equal(process.env.GOOGLE_CALENDAR_PILOT_USER_ID, calendarPilotId);
  assert.equal(process.env.CALENDAR_SETTER_USER_ID, calendarSetterId);
  const fixed = async (id: string, name: string) => {
    const email = id + '@calendar-perimeter.invalid.test';
    const prior = await db.user.findUnique({ where: { id } });
    if (prior) {
      assert.equal(prior.email, email); assert.equal(prior.name, name); assert.equal(prior.role, 'commerciale');
      assert.equal(prior.active, true); assert.equal(prior.deletedAt, null);
      return prior;
    }
    return db.user.create({ data: { id, email, name, role: 'commerciale', passwordHash: 'synthetic-calendar-not-for-login' } });
  };
  const pilot = await fixed(calendarPilotId, 'Pilot calendario · sintetico');
  const setter = await fixed(calendarSetterId, 'Setter calendario autorizzata · sintetico');
  const [admin, other, technical, inactive, deleted] = await Promise.all([
    syntheticPerson(db, 'Admin perimetro calendario · sintetico', 'admin'),
    syntheticPerson(db, 'Altro commerciale calendario · sintetico', 'commerciale'),
    syntheticPerson(db, 'Tecnico perimetro calendario · sintetico', 'consulente'),
    syntheticPerson(db, 'CALENDAR_INACTIVE_EXCLUDED', 'commerciale'),
    syntheticPerson(db, 'CALENDAR_DELETED_EXCLUDED', 'commerciale'),
  ]);
  await db.user.update({ where: { id: inactive.user.id }, data: { active: false } });
  await db.user.update({ where: { id: deleted.user.id }, data: { deletedAt: new Date() } });
  for (const [userId, startMinute] of [[pilot.id, 540], [setter.id, 660], [other.user.id, 780], [technical.user.id, 900], [admin.user.id, 1020]] as const) {
    const availability = [{ weekday: 1, startMinute, endMinute: startMinute + 60 }];
    // Restore only this verified synthetic fixture's edited bands on rerun.
    await db.personalCalendar.upsert({ where: { userId }, create: { userId, mode: 'LOCAL', availability }, update: { availability } });
  }
  const priorLead = await db.lead.findUnique({ where: { id: privateLeadId } });
  let date: string;
  if (priorLead) {
    assert.equal(priorLead.companyName, privateMarker); assert.equal(priorLead.assignedToId, pilot.id);
    assert.equal(priorLead.notes, 'CALENDAR_PRIVATE_NOTE'); assert.equal(priorLead.setterNextKind, 'VIDEO');
    assert.equal(priorLead.deletedAt, null); assert(priorLead.nextActionDate);
    date = romeDateTimeInput(priorLead.nextActionDate).slice(0, 10);
  } else {
    // Prior failed runs are evidence: preserve their rows and allocate a free
    // week once. Subsequent runs reuse this fixed case and its original date.
    const day = new Date(Date.now() + 7 * 86_400_000);
    while (day.getUTCDay() !== 1) day.setUTCDate(day.getUTCDate() + 1);
    date = '';
    for (let attempt = 0; attempt < 52; attempt++, day.setUTCDate(day.getUTCDate() + 7)) {
      const candidate = day.toISOString().slice(0, 10);
      const next = new Date(day.getTime() + 7 * 86_400_000).toISOString().slice(0, 10);
      const from = resolveRomeDateTime(candidate + 'T00:00'), until = resolveRomeDateTime(next + 'T00:00');
      assert(from.kind === 'unique'); assert(until.kind === 'unique');
      const gte = new Date(from.instants[0]), lt = new Date(until.instants[0]);
      const legacy = await db.lead.count({ where: { assignedToId: pilot.id, deletedAt: null, nextActionDate: { gte, lt } } });
      const managed = await db.leadAppointment.count({ where: { calendar: { userId: pilot.id }, startsAt: { lt }, endsAt: { gt: gte } } });
      if (!legacy && !managed) { date = candidate; break; }
    }
    assert(date, 'SYNTHETIC_CALENDAR_FREE_WEEK_REQUIRED');
  }
  // A legacy appointment without a PersonalCalendar relation still occupies
  // the pilot's CRM calendar; viewing its time must not grant Lead access.
  const at = resolveRomeDateTime(date + 'T09:15'); assert(at.kind === 'unique');
  const lead = priorLead ?? await db.lead.create({ data: { id: privateLeadId, firstName: 'Persona', lastName: 'Sintetica', companyName: privateMarker,
    notes: 'CALENDAR_PRIVATE_NOTE', assignedToId: pilot.id, setterNextKind: 'VIDEO', nextActionDate: new Date(at.instants[0]) } });
  return { synthetic: true, pilotId: pilot.id, setterId: setter.id, adminId: admin.user.id, otherId: other.user.id,
    technicalId: technical.user.id, inactiveId: inactive.user.id, deletedId: deleted.user.id,
    date, privateLeadId: lead.id, privateMarker };
}

export function readCalendarPerimeterFixture(): CalendarPerimeterFixture {
  assert(process.env.FLOW_EVIDENCE, 'FLOW_EVIDENCE_REQUIRED');
  const value = JSON.parse(readFileSync(join(process.env.FLOW_EVIDENCE, 'calendar-perimeter-fixture.json'), 'utf8')) as CalendarPerimeterFixture;
  assert.equal(value.synthetic, true); assert.equal(value.pilotId, calendarPilotId); assert.equal(value.setterId, calendarSetterId);
  assert.equal(process.env.GOOGLE_CALENDAR_PILOT_USER_ID, calendarPilotId);
  assert.equal(process.env.CALENDAR_SETTER_USER_ID, calendarSetterId);
  return value;
}
