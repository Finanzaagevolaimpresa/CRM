import { Prisma, type PrismaClient } from '@prisma/client';
import type { AuthSession } from './auth';
import { hasPermission } from './permission-evaluator';
import { leadVisibilityWhere } from './core-query-policy';
import { isTechnicalAccount } from './technical-confidentiality';
import { currentRecordUpdateUser, recordUpdatePermission } from './record-update-context';
import { updateActor } from './record-updates';
import { nextConcurrencyTimestamp, withSerializableTransaction } from './serializable';
import { appointmentCommandSchema, appointmentInterval, availabilitySchema, CalendarError, intervalsOverlap, withinAvailability } from './personal-calendar-contract';
import type { GoogleCalendarAdapter } from './google-calendar-adapter';
import { stopPendingWorkflowExecutions } from './workflow-executions';

export async function saveCalendarAvailability(db: PrismaClient, claimed: AuthSession, raw: unknown) {
  const availability = availabilitySchema.parse(raw);
  return withSerializableTransaction(db, async tx => {
    const auth = await updateActor(tx, claimed);
    if (!recordUpdatePermission(auth.actor, 'lead.read')) throw new CalendarError('DENIED');
    const row = await tx.personalCalendar.upsert({ where: { userId: auth.actor.id },
      create: { userId: auth.actor.id, availability, mode: 'LOCAL' }, update: { availability } });
    await tx.auditLog.create({ data: { actorId: auth.actor.id, event: 'personal_calendar_availability_saved', entityType: 'PersonalCalendar', entityId: row.id,
      after: { timezone: 'Europe/Rome', bands: availability.length } } });
    await auth.finish();
    return row.id;
  });
}

export async function listBookableCalendars(db: PrismaClient, claimed: AuthSession) {
  if (isTechnicalAccount(claimed) || !hasPermission(claimed, 'lead.read')) return [];
  const calendars = await db.personalCalendar.findMany({ where: { user: { active: true, deletedAt: null } },
    include: { user: { select: { name: true } } }, orderBy: { user: { name: 'asc' } } });
  const admitted = await Promise.all(calendars.map(async row => {
    const user = await currentRecordUpdateUser(db, row.userId);
    return user && recordUpdatePermission(user, 'lead.read') ? row : null;
  }));
  return admitted.flatMap(row => row ? [{ id: row.id, userId: row.userId, name: row.user.name, availability: row.availability, mode: row.mode }] : []);
}

export async function saveLeadAppointment(db: PrismaClient, claimed: AuthSession, raw: unknown, provider?: GoogleCalendarAdapter) {
  const input = appointmentCommandSchema.parse(raw);
  return withSerializableTransaction(db, async tx => {
    const auth = await updateActor(tx, claimed);
    if (isTechnicalAccount(auth.actor) || !recordUpdatePermission(auth.actor, 'lead.write')) throw new CalendarError('DENIED');
    // A shared calendar lock serializes reservations for different leads as well
    // as two edits of the same lead. The transaction also protects local queues.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'fai-calendar:' + input.calendarId}, 0))`;
    await tx.$queryRaw`SELECT id FROM "Lead" WHERE id=${input.leadId} FOR UPDATE`;
    const lead = await tx.lead.findFirst({ where: { id: input.leadId, deletedAt: null, AND: [leadVisibilityWhere(auth.actor)],
      ...(input.operation === 'BOOK' ? { status: { notIn: ['archiviato', 'perso', 'vinto', 'cliente_acquisito', 'non_qualificato'] } } : {}) } });
    const calendar = await tx.personalCalendar.findUnique({ where: { id: input.calendarId } });
    if (!lead || !calendar) throw new CalendarError('DENIED');
    const owner = await currentRecordUpdateUser(tx, calendar.userId);
    if (!owner || !recordUpdatePermission(owner, 'lead.read')) throw new CalendarError('DENIED');
    const current = await tx.leadAppointment.findUnique({ where: { leadId: lead.id } });
    if (current && (current.id !== input.id || current.calendarId !== calendar.id)) throw new CalendarError('STALE');
    const interval = input.operation === 'BOOK' ? appointmentInterval(input.startLocal, input.durationMinutes) : null;
    if (current && ((input.operation === 'CANCEL' && current.status === 'CANCELLED')
      || (interval && current.status === 'BOOKED' && current.startsAt.getTime() === interval.startsAt.getTime() && current.endsAt.getTime() === interval.endsAt.getTime()))) {
      await auth.finish(); return current;
    }
    if ((current?.version ?? 0) !== input.expectedVersion || lead.updatedAt.toISOString() !== input.leadVersion) throw new CalendarError('STALE');
    if (input.operation === 'CANCEL' && !current) throw new CalendarError('STALE');
    if (input.operation === 'CANCEL' && current?.status !== 'BOOKED') throw new CalendarError('STALE');
    const newGeneration = Boolean(interval && current && current.status !== 'BOOKED');
    if (newGeneration && current && !['LOCAL', 'SYNCED'].includes(current.syncState)) throw new CalendarError('UNCERTAIN');
    if (interval) {
      if (interval.startsAt <= new Date() || !withinAvailability(calendar.availability, interval)) throw new CalendarError('OUTSIDE_HOURS');
      const overlap = await tx.leadAppointment.findFirst({ where: { calendarId: calendar.id, status: 'BOOKED', id: { not: input.id },
        startsAt: { lt: interval.endsAt }, endsAt: { gt: interval.startsAt } }, select: { id: true } });
      if (overlap) throw new CalendarError('BUSY');
      // The legacy next-action calendar is still authoritative for pre-existing
      // video calls. Importing one on this lead preserves its scheduled instant.
      const legacy = await tx.lead.findMany({ where: { assignedToId: calendar.userId, id: { not: lead.id }, deletedAt: null,
        setterNextKind: 'VIDEO', nextActionDate: { gte: new Date(interval.startsAt.getTime() - 30 * 60_000), lt: interval.endsAt } },
        select: { id: true, nextActionDate: true } });
      if (legacy.some(row => row.nextActionDate && intervalsOverlap(interval, { startsAt: row.nextActionDate, endsAt: new Date(row.nextActionDate.getTime() + 30 * 60_000) }))) throw new CalendarError('BUSY');
      if (calendar.mode === 'GOOGLE') {
        if (!calendar.googleCalendarId || !provider?.owns(calendar.userId, calendar.googleCalendarId)) throw new CalendarError('UNCONNECTED');
        await provider.assertAvailable(interval.startsAt, interval.endsAt,
          current?.status === 'BOOKED' ? current.id + ':' + current.generation : undefined);
      } else if (calendar.mode !== 'LOCAL') throw new CalendarError('UNCONNECTED');
    }
    const data = { ...(interval ?? {}), status: input.operation === 'CANCEL' ? 'CANCELLED' : 'BOOKED',
      syncState: calendar.mode === 'LOCAL' ? 'LOCAL' : 'PENDING', syncError: null, updatedById: auth.actor.id };
    const row = current ? await tx.leadAppointment.update({ where: { id: current.id }, data: { ...data, version: { increment: 1 },
      ...(newGeneration ? { generation: { increment: 1 }, externalEventId: null, externalEtag: null } : {}) } })
      : await tx.leadAppointment.create({ data: { id: input.id, leadId: lead.id, calendarId: calendar.id, startsAt: interval!.startsAt,
        endsAt: interval!.endsAt, createdById: auth.actor.id, ...data } });
    // A later callback may already replace the appointment in the Lead queue.
    // Cancelling the old event must not erase that independent next action.
    if (interval || (lead.setterNextKind === 'VIDEO' && lead.nextActionDate?.getTime() === current?.startsAt.getTime()))
      await tx.lead.update({ where: { id: lead.id }, data: { setterNextKind: interval ? 'VIDEO' : null,
        nextActionDate: interval?.startsAt ?? null, nextAction: interval?.startsAt ?? null,
        nextActionNote: interval ? 'Videochiamata fissata' : null, updatedAt: nextConcurrencyTimestamp(lead.updatedAt) } });
    await tx.auditLog.create({ data: { actorId: auth.actor.id, entityType: 'Lead', entityId: lead.id,
      event: input.operation === 'CANCEL' ? 'lead_appointment_cancelled' : current ? 'lead_appointment_rescheduled' : 'lead_appointment_booked',
      after: { appointmentId: row.id, calendarId: calendar.id, version: row.version, startsAt: row.startsAt.toISOString(), endsAt: row.endsAt.toISOString() } } });
    if (input.operation === 'BOOK') await stopPendingWorkflowExecutions(tx, { leadId: lead.id, reason: 'APPOINTMENT_BOOKED', evidenceId: row.id });
    await auth.finish(); return row;
  }, { timeout: 30_000 });
}

export async function synchronizeLeadAppointment(db: PrismaClient, claimed: AuthSession, id: string, provider: GoogleCalendarAdapter) {
  return withSerializableTransaction(db, async tx => {
    const auth = await updateActor(tx, claimed);
    const appointment = await tx.leadAppointment.findUnique({ where: { id }, include: { calendar: true } });
    if (!appointment || isTechnicalAccount(auth.actor) || !recordUpdatePermission(auth.actor, 'lead.write')) throw new CalendarError('DENIED');
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'fai-calendar:' + appointment.calendarId}, 0))`;
    await tx.$queryRaw`SELECT id FROM "Lead" WHERE id=${appointment.leadId} FOR UPDATE`;
    const lead = await tx.lead.findFirst({ where: { id: appointment.leadId, deletedAt: null, AND: [leadVisibilityWhere(auth.actor)] } });
    if (!lead || appointment.calendar.mode !== 'GOOGLE' || !appointment.calendar.googleCalendarId
      || !provider.owns(appointment.calendar.userId, appointment.calendar.googleCalendarId)) throw new CalendarError('DENIED');
    const owner = await currentRecordUpdateUser(tx, appointment.calendar.userId);
    if (!owner || !recordUpdatePermission(owner, 'lead.read')) throw new CalendarError('DENIED');
    // Re-read after the reservation lock; a stale sync must never overwrite a move.
    const current = await tx.leadAppointment.findUniqueOrThrow({ where: { id } });
    try {
      const result = await provider.synchronize({ id: id + ':' + current.generation, startsAt: current.startsAt, endsAt: current.endsAt, cancelled: current.status === 'CANCELLED' });
      await tx.leadAppointment.update({ where: { id }, data: { externalEventId: result.eventId, externalEtag: result.etag, syncState: 'SYNCED', syncError: null } });
      await auth.finish(); return { ok: true as const };
    } catch (error) {
      const code = error instanceof CalendarError ? error.code : 'UNCERTAIN';
      await tx.leadAppointment.update({ where: { id }, data: { syncState: code === 'UNCERTAIN' ? 'UNCERTAIN' : 'ERROR', syncError: code } });
      await auth.finish(); return { ok: false as const, code };
    }
  }, { timeout: 30_000 });
}

/** Call only after locking this Lead. Ordinary pipeline edits may retain the
 * date; moving or clearing a booked video belongs to the appointment command. */
export async function assertPipelineAppointmentUnchanged(tx: Prisma.TransactionClient,
  lead: { id: string; setterNextKind: string | null; nextActionDate: Date | null }, nextActionDate: Date | null) {
  if (lead.setterNextKind !== 'VIDEO' || lead.nextActionDate?.getTime() === nextActionDate?.getTime()) return;
  const appointment = await tx.leadAppointment.findUnique({ where: { leadId: lead.id }, select: { status: true } });
  if (appointment?.status === 'BOOKED') throw new CalendarError('BUSY');
}

/** Setter calls may close a registered appointment, but may not move it around
 * the availability and concurrency checks of saveLeadAppointment. */
export async function calendarFromSetterOutcome(tx: Prisma.TransactionClient, leadId: string, outcome: string, nextKind: string | null, nextAt: Date | null, actorId: string) {
  const current = await tx.leadAppointment.findUnique({ where: { leadId } });
  if (!current || current.status !== 'BOOKED') return;
  if (nextKind === 'VIDEO' && nextAt?.getTime() !== current.startsAt.getTime()) throw new CalendarError('BUSY');
  if (['VIDEO_HELD', 'VIDEO_ABSENT'].includes(outcome)) {
    await tx.leadAppointment.update({ where: { id: current.id }, data: { status: outcome === 'VIDEO_HELD' ? 'COMPLETED' : 'CANCELLED',
      syncState: current.syncState === 'LOCAL' ? 'LOCAL' : 'PENDING', version: { increment: 1 }, updatedById: actorId } });
  }
}
