import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CalendarError, intervalsOverlap } from './personal-calendar-contract';

const base = 'https://www.googleapis.com/calendar/v3';
const busySchema = z.object({ start: z.string().datetime({ offset: true }), end: z.string().datetime({ offset: true }) });
const eventSchema = z.object({ id: z.string(), etag: z.string(), status: z.string().optional(),
  start: z.object({ dateTime: z.string().datetime({ offset: true }) }).optional(),
  end: z.object({ dateTime: z.string().datetime({ offset: true }) }).optional(),
  extendedProperties: z.object({ private: z.object({ faiAppointment: z.string() }).passthrough() }).optional(),
}).passthrough();
export function googleAppointmentId(id: string) { return 'fai' + createHash('sha256').update(id).digest('hex'); }
export type GoogleCalendarAuthorization = { userId: string; calendarId: string; accessToken: string };
export type GoogleEventInput = { id: string; startsAt: Date; endsAt: Date; cancelled: boolean };

/** The caller supplies an already authorized, per-person credential. No global
 * credential fallback and no guest invitations are supported by this adapter. */
export class GoogleCalendarAdapter {
  constructor(private auth: GoogleCalendarAuthorization, private transport: typeof fetch = fetch) {
    if (!auth.userId || !auth.calendarId || !auth.accessToken || /[\r\n]/.test(auth.accessToken)) throw new CalendarError('UNCONNECTED');
  }
  owns(userId: string, calendarId: string) { return this.auth.userId === userId && this.auth.calendarId === calendarId; }
  private async request(path: string, init: RequestInit = {}) {
    try { return await this.transport(base + path, { ...init, cache: 'no-store', redirect: 'error',
      signal: AbortSignal.timeout(10_000), headers: { Authorization: 'Bearer ' + this.auth.accessToken,
        'Content-Type': 'application/json', ...init.headers } }); }
    catch { throw new CalendarError('UNCERTAIN'); }
  }
  async freeBusy(startsAt: Date, endsAt: Date) {
    const result = await this.request('/freeBusy', { method: 'POST', body: JSON.stringify({
      timeMin: startsAt.toISOString(), timeMax: endsAt.toISOString(), timeZone: 'Europe/Rome', items: [{ id: this.auth.calendarId }],
    }) });
    if (!result.ok) throw new CalendarError(result.status === 401 || result.status === 403 ? 'UNCONNECTED' : 'UNCERTAIN');
    const body = z.object({ calendars: z.record(z.string(), z.object({ errors: z.array(z.unknown()).optional(), busy: z.array(busySchema).optional() })) }).parse(await result.json());
    const calendar = body.calendars[this.auth.calendarId];
    if (!calendar || calendar.errors?.length || !calendar.busy) throw new CalendarError('UNCERTAIN');
    return calendar.busy.map(row => ({ startsAt: new Date(row.start), endsAt: new Date(row.end) }));
  }
  async assertAvailable(startsAt: Date, endsAt: Date, ownAppointmentId?: string) {
    const interval = { startsAt, endsAt };
    const busy = (await this.freeBusy(startsAt, endsAt)).filter(row => intervalsOverlap(interval, row));
    if (!busy.length) return;
    if (!ownAppointmentId) throw new CalendarError('BUSY');
    const eventId = googleAppointmentId(ownAppointmentId);
    const events = '/calendars/' + encodeURIComponent(this.auth.calendarId) + '/events';
    const found = await this.request(events + '/' + eventId);
    if (!found.ok) throw new CalendarError(found.status === 404 || found.status === 410 ? 'BUSY' : 'UNCERTAIN');
    const own = eventSchema.parse(await found.json());
    if (own.id !== eventId || own.extendedProperties?.private.faiAppointment !== ownAppointmentId
      || (Array.isArray(own.attendees) && own.attendees.length)) throw new CalendarError('DENIED');
    if (own.status === 'cancelled' || own.transparency === 'transparent' || !own.start?.dateTime || !own.end?.dateTime) throw new CalendarError('BUSY');
    const ownStart = new Date(own.start.dateTime).getTime(), ownEnd = new Date(own.end.dateTime).getTime();
    // Free/busy merges occupied intervals. Never subtract the old slot blindly:
    // another event can occupy all or part of the very same interval.
    if (busy.some(row => Math.max(row.startsAt.getTime(), startsAt.getTime()) < ownStart
      || Math.min(row.endsAt.getTime(), endsAt.getTime()) > ownEnd)) throw new CalendarError('BUSY');
    const listedEvent = z.object({ id: z.string(), etag: z.string().optional(), status: z.string().optional(), transparency: z.string().optional(),
      extendedProperties: z.object({ private: z.record(z.string(), z.string()).optional() }).optional() });
    const pageSchema = z.object({ accessRole: z.enum(['owner', 'writer']), items: z.array(listedEvent), nextPageToken: z.string().optional() });
    const seenPages = new Set<string>(); let token: string | undefined, ownSeen = false;
    do {
      const query = new URLSearchParams({ timeMin: startsAt.toISOString(), timeMax: endsAt.toISOString(), singleEvents: 'true',
        showDeleted: 'false', showHiddenInvitations: 'true', timeZone: 'Europe/Rome', maxResults: '2500',
        fields: 'accessRole,nextPageToken,items(id,etag,status,transparency,extendedProperties/private/faiAppointment)' });
      if (token) query.set('pageToken', token);
      const result = await this.request(events + '?' + query);
      if (!result.ok) throw new CalendarError('UNCERTAIN');
      const page = pageSchema.parse(await result.json());
      for (const event of page.items) {
        if (event.status === 'cancelled' || event.transparency === 'transparent') continue;
        if (event.id !== eventId) throw new CalendarError('BUSY');
        if (event.etag !== own.etag || event.extendedProperties?.private?.faiAppointment !== ownAppointmentId) throw new CalendarError('UNCERTAIN');
        ownSeen = true;
      }
      token = page.nextPageToken;
      if (token && (seenPages.has(token) || seenPages.size >= 10)) throw new CalendarError('UNCERTAIN');
      if (token) seenPages.add(token);
    } while (token);
    if (!ownSeen) throw new CalendarError('UNCERTAIN');
  }
  async synchronize(input: GoogleEventInput) {
    const eventId = googleAppointmentId(input.id);
    const events = '/calendars/' + encodeURIComponent(this.auth.calendarId) + '/events';
    const path = events + '/' + eventId;
    const found = await this.request(path);
    if (!found.ok && found.status !== 404 && found.status !== 410) throw new CalendarError('UNCERTAIN');
    const current = found.ok ? eventSchema.parse(await found.json()) : null;
    if (current && current.extendedProperties?.private.faiAppointment !== input.id) throw new CalendarError('DENIED');
    if (current && Array.isArray(current.attendees) && current.attendees.length) throw new CalendarError('DENIED');
    if (input.cancelled) {
      if (!current || current.status === 'cancelled') return { eventId, etag: current?.etag ?? null };
      const removed = await this.request(path + '?sendUpdates=none', { method: 'DELETE', headers: { 'If-Match': current.etag } });
      if (!removed.ok && removed.status !== 404 && removed.status !== 410) throw new CalendarError('UNCERTAIN');
      return { eventId, etag: null };
    }
    if (current?.status === 'cancelled') throw new CalendarError('STALE');
    if (current && current.start?.dateTime && current.end?.dateTime
      && new Date(current.start.dateTime).getTime() === input.startsAt.getTime()
      && new Date(current.end.dateTime).getTime() === input.endsAt.getTime()) return { eventId, etag: current.etag };
    await this.assertAvailable(input.startsAt, input.endsAt, current ? input.id : undefined);
    const body = { ...(current ?? {}), id: eventId, summary: 'Appuntamento FAI',
      start: { dateTime: input.startsAt.toISOString(), timeZone: 'Europe/Rome' },
      end: { dateTime: input.endsAt.toISOString(), timeZone: 'Europe/Rome' },
      extendedProperties: { private: { faiAppointment: input.id } } };
    const saved = await this.request((current ? path : events) + '?sendUpdates=none', { method: current ? 'PUT' : 'POST',
      headers: current ? { 'If-Match': current.etag } : {}, body: JSON.stringify(body) });
    // A timeout/409 is reconciled by GET on the same deterministic event ID.
    if (!saved.ok) throw new CalendarError('UNCERTAIN');
    const event = eventSchema.parse(await saved.json());
    if (event.id !== eventId || event.extendedProperties?.private.faiAppointment !== input.id) throw new CalendarError('UNCERTAIN');
    return { eventId, etag: event.etag };
  }
}
