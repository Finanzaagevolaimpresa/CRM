import { resolveRomeDateTime, romeDateTimeInput, romeOffsetLabel } from './rome-date-time';

export type CalendarWeek = { startDate: string; dates: string[]; from: Date; until: Date; previous: string | null; next: string | null };
const shiftDate = (day: string, days: number) => new Date(Date.parse(day + 'T12:00:00Z') + days * 86_400_000).toISOString().slice(0, 10);
function midnight(day: string): Date | null {
  try {
    const resolved = resolveRomeDateTime(day + 'T00:00');
    return resolved.kind === 'unique' ? new Date(resolved.instants[0]) : null;
  } catch { return null; } // Extreme input years may overflow Intl's offset probes.
}
function weekStart(day: string): string | null {
  if (!midnight(day)) return null;
  const weekday = new Date(day + 'T12:00:00Z').getUTCDay();
  const monday = shiftDate(day, -(weekday + 6) % 7);
  return midnight(monday) && midnight(shiftDate(monday, 7)) ? monday : null;
}
/** A calendar week is Monday–Sunday in Rome; UTC durations may be 167 or 169 hours. */
export function calendarWeek(raw: unknown, now = new Date()): CalendarWeek {
  const startDate = (typeof raw === 'string' && weekStart(raw)) || weekStart(romeDateTimeInput(now).slice(0, 10));
  if (!startDate) throw new Error('CALENDAR_WEEK_INVALID');
  const previous = shiftDate(startDate, -7), next = shiftDate(startDate, 7);
  return { startDate, dates: Array.from({ length: 7 }, (_, index) => shiftDate(startDate, index)),
    from: midnight(startDate)!, until: midnight(next)!,
    previous: weekStart(previous) === previous ? previous : null, next: weekStart(next) === next ? next : null };
}
export function calendarWeekHref(day: string, userId?: string) {
  const params = new URLSearchParams({ date: day });
  if (userId) params.set('user', userId);
  return '/calendars?' + params.toString();
}
export function calendarClock(instant: Date): string {
  const local = romeDateTimeInput(instant);
  return resolveRomeDateTime(local).kind === 'ambiguous' ? romeOffsetLabel(instant.toISOString()) : local.slice(11, 16);
}
export type CalendarDaySlice = { date: string; time: string; continuation: boolean };
/** Split at local midnights, including all-day busy intervals, without inventing a legacy duration. */
export function calendarDaySlices(week: CalendarWeek, startsAt: Date, endsAt: Date | null): CalendarDaySlice[] {
  if (!Number.isFinite(startsAt.getTime()) || (endsAt && (!Number.isFinite(endsAt.getTime()) || endsAt <= startsAt))) return [];
  return week.dates.flatMap(date => {
    const from = midnight(date)!, until = midnight(shiftDate(date, 1))!;
    if (!endsAt) return startsAt >= from && startsAt < until ? [{ date, time: calendarClock(startsAt), continuation: false }] : [];
    if (startsAt >= until || endsAt <= from) return [];
    const start = startsAt < from ? from : startsAt, end = endsAt > until ? until : endsAt;
    const time = start.getTime() === from.getTime() && end.getTime() === until.getTime() ? 'Tutto il giorno'
      : calendarClock(start) + ' – ' + (end.getTime() === until.getTime() ? '24:00' : calendarClock(end));
    return [{ date, time, continuation: startsAt < from || endsAt > until }];
  });
}
export type CalendarAgendaEntry = { startsAt: Date; endsAt: Date | null; kind: string; status: string;
  syncLabel: string | null; contact: string | null; company: string | null; href: string | null };
type VisibleLead = { id: string; firstName: string; lastName: string; companyName: string | null };
/** This projection receives only the Lead rows admitted by the existing reader.
 * Hidden entries carry no Lead identifiers or private strings into HTML/RSC. */
export function calendarContact(lead: VisibleLead | undefined) {
  if (!lead) return { contact: null, company: null, href: null };
  const name = [lead.firstName.trim(), lead.lastName.trim()].filter(Boolean).join(' ');
  const company = lead.companyName?.trim() || null;
  return { contact: name || company || 'Scheda Lead', company: name && company !== name ? company : null,
    href: '/leads/' + encodeURIComponent(lead.id) };
}
export const calendarAppointmentLabel = (status: string) => status === 'BOOKED' ? 'Appuntamento' : status === 'COMPLETED' ? 'Svolto' : status === 'CANCELLED' ? 'Annullato' : 'Stato da verificare';
export const calendarLegacyLabel = (kind: string | null) => kind === 'VIDEO' ? 'Videochiamata' : kind === 'CALLBACK' ? 'Richiamo' : 'Prossima azione';
