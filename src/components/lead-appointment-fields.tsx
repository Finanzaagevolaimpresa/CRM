'use client';
import { useId } from 'react';
import { romeDateTimeInput } from '@/lib/rome-date-time';

export type CalendarChoice = { id: string; userId: string; name: string };
export type AppointmentChoice = { id: string; calendarId: string; version: number; startsAt: string; endsAt: string; status: string };

/** Both forms describe the same reservation command, with the same explicit
 * person, Rome wall clock and duration. No calendar is invented on submit. */
export function LeadAppointmentFields({ calendars, appointment, assignedToId, legacyDate, setter = false }: {
  calendars: CalendarChoice[]; appointment: AppointmentChoice | null; assignedToId: string | null; legacyDate?: string | null; setter?: boolean;
}) {
  const calendarId = useId(), timeId = useId(), durationId = useId();
  return <>
    <div className="grid gap-1 text-sm font-bold"><label htmlFor={calendarId}>{setter ? 'Referente della videochiamata' : 'Referente'}</label>
      <select id={calendarId} name="calendar" required defaultValue={appointment?.calendarId ?? calendars.find(row => row.userId === assignedToId)?.id ?? ''}
        className="rounded border p-2" disabled={Boolean(appointment)}>
        <option value="" disabled>Scegli il referente</option>
        {calendars.map(calendar => <option key={calendar.id} value={calendar.id}>{calendar.name}</option>)}
      </select>{appointment && <input type="hidden" name="calendar" value={appointment.calendarId} />}</div>
    <div className="grid gap-1 text-sm font-bold"><label htmlFor={timeId}>{setter ? 'Data e ora della videochiamata (Roma)' : 'Data e ora di Roma'}</label>
      <input id={timeId} type="datetime-local" name={setter ? 'nextLocal' : 'start'} defaultValue={romeDateTimeInput(appointment?.startsAt ?? legacyDate).slice(0, 16)} required className="rounded border p-2" /></div>
    <div className="grid gap-1 text-sm font-bold"><label htmlFor={durationId}>{setter ? 'Durata della videochiamata (minuti)' : 'Durata (minuti)'}</label>
      <input id={durationId} type="number" name="duration" min="15" max="180" step="15" defaultValue={appointment ? (Date.parse(appointment.endsAt) - Date.parse(appointment.startsAt)) / 60_000 : 30} required className="rounded border p-2" /></div>
  </>;
}
