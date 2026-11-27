'use client';
import { useId, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { saveAppointmentAction, reconcileAppointmentAction } from '@/lib/personal-calendar-actions';
import { calendarSyncLabels } from '@/lib/personal-calendar-contract';
import { romeDateTimeInput } from '@/lib/rome-date-time';

export type LeadAppointmentFormProps = { leadId: string; leadVersion: string; assignedToId: string | null; legacyDate: string | null;
  calendars: { id: string; userId: string; name: string }[]; appointment: { id: string; calendarId: string; version: number;
    startsAt: string; endsAt: string; status: string; syncState: string; syncError: string | null } | null };
export function LeadAppointmentForm({ leadId, leadVersion, calendars, appointment, assignedToId, legacyDate }: LeadAppointmentFormProps) {
  const calendarFieldId = useId();
  const [id] = useState(() => appointment?.id ?? crypto.randomUUID()), [pending, start] = useTransition();
  const [message, setMessage] = useState(''), router = useRouter();
  if (!calendars.length) return <p>Il referente deve prima salvare le proprie fasce in Calendari.</p>;
  return <div className="crm-space-y-3">
    {appointment && <p role="status" className="rounded-xl bg-slate-50 p-3">{appointment.status === 'CANCELLED' ? 'Appuntamento annullato. ' : appointment.status === 'COMPLETED' ? 'Appuntamento svolto. ' : ''}{calendarSyncLabels[appointment.syncState] ?? 'Stato da verificare'}{appointment.syncError === 'BUSY' ? ' · La fascia Google è occupata: sposta l’appuntamento.' : appointment.syncError ? ' · Verifica il collegamento e riconcilia l’esito prima di riprovare.' : ''}</p>}
    <form className="grid gap-3 md:grid-cols-3" onSubmit={event => { event.preventDefault(); const form = new FormData(event.currentTarget);
      const operation = (event.nativeEvent as SubmitEvent).submitter?.getAttribute('value') === 'CANCEL' ? 'CANCEL' : 'BOOK';
      start(async () => { const result = await saveAppointmentAction({ id, leadId, leadVersion, calendarId: form.get('calendar'),
        expectedVersion: appointment?.version ?? 0, operation, startLocal: form.get('start'), durationMinutes: Number(form.get('duration')) });
        setMessage(result.message); if (result.ok) router.refresh(); });
    }}>
      <div className="grid gap-1 text-sm font-bold"><label htmlFor={calendarFieldId}>Referente</label><select id={calendarFieldId} name="calendar" defaultValue={appointment?.calendarId ?? calendars.find(row => row.userId === assignedToId)?.id} className="rounded border p-2" disabled={Boolean(appointment)}>
        {calendars.map(calendar => <option key={calendar.id} value={calendar.id}>{calendar.name}</option>)}
      </select>{appointment && <input type="hidden" name="calendar" value={appointment.calendarId} />}</div>
      <label className="grid gap-1 text-sm font-bold">Data e ora di Roma<input type="datetime-local" name="start" defaultValue={romeDateTimeInput(appointment?.startsAt ?? legacyDate).slice(0, 16)} required className="rounded border p-2" /></label>
      <label className="grid gap-1 text-sm font-bold">Durata (minuti)<input type="number" name="duration" min="15" max="180" step="15" defaultValue={appointment ? (Date.parse(appointment.endsAt) - Date.parse(appointment.startsAt)) / 60_000 : 30} required className="rounded border p-2" /></label>
      <div className="flex flex-wrap gap-3 md:col-span-3">
        <button disabled={pending} type="submit" value="BOOK" className="rounded-xl bg-fai-blue px-4 py-2 font-bold text-white">{pending ? 'Salvataggio…' : appointment?.status === 'BOOKED' ? 'Sposta appuntamento' : 'Fissa appuntamento'}</button>
        {appointment?.status === 'BOOKED' && <button disabled={pending} type="submit" value="CANCEL" formNoValidate className="rounded-xl border px-4 py-2 font-bold">Annulla appuntamento</button>}
      </div>
    </form>
    {appointment && ['PENDING', 'ERROR', 'UNCERTAIN'].includes(appointment.syncState) && <button disabled={pending} onClick={() => start(async () => {
      const result = await reconcileAppointmentAction(appointment.id); setMessage(result.message); router.refresh();
    })} className="font-bold underline">Verifica sincronizzazione</button>}
    <p role="status">{message}</p>
  </div>;
}
