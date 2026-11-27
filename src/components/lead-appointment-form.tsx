'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { saveAppointmentAction, reconcileAppointmentAction } from '@/lib/personal-calendar-actions';
import { calendarSyncLabels } from '@/lib/personal-calendar-contract';
import { LeadAppointmentFields } from './lead-appointment-fields';

export type LeadAppointmentFormProps = { leadId: string; leadVersion: string; assignedToId: string | null; legacyDate: string | null;
  calendars: { id: string; userId: string; name: string }[]; appointment: { id: string; calendarId: string; version: number;
    startsAt: string; endsAt: string; status: string; syncState: string; syncError: string | null } | null };
export function LeadAppointmentForm({ leadId, leadVersion, calendars, appointment, assignedToId, legacyDate }: LeadAppointmentFormProps) {
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
      <LeadAppointmentFields calendars={calendars} appointment={appointment} assignedToId={assignedToId} legacyDate={legacyDate} />
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
