import { z } from 'zod';
import { resolveRomeDateTime, romeDateTimeInput } from './rome-date-time';

export const availabilitySchema = z.array(z.object({
  weekday: z.number().int().min(0).max(6), startMinute: z.number().int().min(0).max(1439),
  endMinute: z.number().int().min(1).max(1440),
}).strict().refine(row => row.endMinute > row.startMinute, 'La fascia deve terminare dopo il suo inizio.')).max(28)
  .superRefine((rows, ctx) => {
    for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++)
      if (rows[i].weekday === rows[j].weekday && rows[i].startMinute < rows[j].endMinute && rows[j].startMinute < rows[i].endMinute)
        ctx.addIssue({ code: 'custom', message: 'Le fasce della stessa giornata si sovrappongono.' });
  });
export type CalendarAvailability = z.infer<typeof availabilitySchema>;
export const defaultCalendarAvailability: CalendarAvailability = [1, 2, 3, 4, 5].map(weekday => ({ weekday, startMinute: 540, endMinute: 1080 }));
export const appointmentCommandSchema = z.object({
  id: z.string().uuid(), leadId: z.string().min(1).max(128), calendarId: z.string().min(1).max(128),
  expectedVersion: z.number().int().min(0), leadVersion: z.string().datetime(),
  operation: z.enum(['BOOK', 'CANCEL']), startLocal: z.string().max(19), durationMinutes: z.number().int().min(15).max(180),
}).strict();
export type AppointmentCommand = z.infer<typeof appointmentCommandSchema>;
export class CalendarError extends Error {
  constructor(readonly code: 'DENIED' | 'STALE' | 'BUSY' | 'OUTSIDE_HOURS' | 'INVALID' | 'UNCONNECTED' | 'UNCERTAIN') { super(code); }
}
/** Pipeline forms declare their wall-clock zone. The locked persisted instant
 * remains exact when only notes/priority change, including the autumn overlap. */
export function pipelineNextActionDate(raw: unknown, current: Date | null, timezone: unknown): Date | null {
  if (timezone !== null && timezone !== undefined && timezone !== 'Europe/Rome') throw new CalendarError('INVALID');
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw !== 'string') throw new CalendarError('INVALID');
  if (timezone === 'Europe/Rome') {
    const shown = romeDateTimeInput(current);
    if (current && (raw === shown || raw === shown.slice(0, 16))) return new Date(current.getTime());
    const resolved = resolveRomeDateTime(raw);
    if (resolved.kind !== 'unique') throw new CalendarError('INVALID');
    return new Date(resolved.instants[0]);
  }
  // Legacy API callers must name an actual instant; the host timezone is never
  // used to interpret an unmarked datetime-local value.
  const explicit = z.string().datetime({ offset: true }).safeParse(raw);
  if (!explicit.success) throw new CalendarError('INVALID');
  return new Date(explicit.data);
}
export function appointmentInterval(local: string, durationMinutes: number) {
  const resolved = resolveRomeDateTime(local);
  if (resolved.kind !== 'unique' || !Number.isInteger(durationMinutes) || durationMinutes < 15 || durationMinutes > 180) throw new CalendarError('INVALID');
  const startsAt = new Date(resolved.instants[0]), endsAt = new Date(startsAt.getTime() + durationMinutes * 60_000);
  return { startsAt, endsAt };
}
export function intervalsOverlap(a: { startsAt: Date; endsAt: Date }, b: { startsAt: Date; endsAt: Date }) {
  return a.startsAt < b.endsAt && b.startsAt < a.endsAt;
}
export function withinAvailability(availability: unknown, interval: { startsAt: Date; endsAt: Date }) {
  const parsed = availabilitySchema.safeParse(availability);
  if (!parsed.success) return false;
  const start = romeDateTimeInput(interval.startsAt), end = romeDateTimeInput(interval.endsAt);
  if (start.slice(0, 10) !== end.slice(0, 10)) return false;
  const weekday = new Date(start.slice(0, 10) + 'T12:00:00Z').getUTCDay();
  const minute = (s: string) => Number(s.slice(11, 13)) * 60 + Number(s.slice(14, 16));
  return parsed.data.some(row => row.weekday === weekday && minute(start) >= row.startMinute && minute(end) <= row.endMinute);
}
export const calendarSyncLabels: Record<string, string> = {
  LOCAL: 'Salvato nel CRM · Google non collegato', PENDING: 'Salvato · sincronizzazione in attesa',
  SYNCED: 'Sincronizzato', ERROR: 'Sincronizzazione in errore', UNCERTAIN: 'Esito da riconciliare',
};
