'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { saveAvailabilityAction } from '@/lib/personal-calendar-actions';
import type { CalendarAvailability } from '@/lib/personal-calendar-contract';

const weekdays = ['Domenica', 'Lunedì', 'Martedì', 'Mercoledì', 'Giovedì', 'Venerdì', 'Sabato'];
const time = (value: number) => String(Math.floor(value / 60)).padStart(2, '0') + ':' + String(value % 60).padStart(2, '0');
export function PersonalCalendarAvailability({ initial }: { initial: CalendarAvailability }) {
  const [message, setMessage] = useState(''), [pending, start] = useTransition(), router = useRouter();
  const [bands, setBands] = useState(() => initial.map((row, index) => ({ ...row, key: 'initial-' + index })));
  return <form onSubmit={event => { event.preventDefault(); const form = new FormData(event.currentTarget);
    const minute = (value: FormDataEntryValue | null) => { const [h, m] = String(value).split(':').map(Number); return h * 60 + m; };
    const rows = weekdays.flatMap((_, weekday) => form.has('day-' + weekday)
      ? Array.from({ length: Math.max(1, bands.filter(row => row.weekday === weekday).length) }, (_, index) => ({ weekday,
        startMinute: minute(form.get(`start-${weekday}-${index}`)), endMinute: minute(form.get(`end-${weekday}-${index}`)) })) : []);
    start(async () => { const result = await saveAvailabilityAction(rows); setMessage(result.message); if (result.ok) router.refresh(); });
  }} className="crm-space-y-3">
    <p className="text-sm text-slate-600">Fasce settimanali nel fuso Europe/Rome. Il calendario usa gli appuntamenti e i richiami già presenti nelle schede.</p>
    {weekdays.map((label, weekday) => { const configured = bands.filter(item => item.weekday === weekday);
      const visible = configured.length ? configured : [{ weekday, startMinute: 540, endMinute: 1080, key: 'default-' + weekday }];
      return <fieldset key={weekday} className="flex flex-wrap items-start gap-3 rounded-xl border p-3">
        <legend className="px-1"><label><input type="checkbox" name={'day-' + weekday} defaultChecked={initial.some(row => row.weekday === weekday)} /> {label}</label></legend>
        <div className="grid gap-2">{visible.map((row, index) => <div key={row.key} className="flex flex-wrap items-center gap-3">
          <label>Da <input type="time" name={`start-${weekday}-${index}`} defaultValue={time(row.startMinute)} required className="rounded border p-1" /></label>
          <label>A <input type="time" name={`end-${weekday}-${index}`} defaultValue={time(row.endMinute)} required className="rounded border p-1" /></label>
          {configured.length > 1 && <button type="button" onClick={() => setBands(current => current.filter(item => item !== row))} className="text-sm underline">Rimuovi fascia</button>}
        </div>)}</div>
        <button type="button" disabled={bands.length >= 28} onClick={() => setBands(current => [...current, ...(configured.length ? [] : visible), { weekday, startMinute: 540, endMinute: 1080, key: crypto.randomUUID() }])} className="text-sm underline">Aggiungi fascia</button>
      </fieldset>; })}
    <button disabled={pending} className="rounded-xl bg-fai-blue px-4 py-2 font-bold text-white">{pending ? 'Salvataggio…' : 'Salva le mie fasce'}</button>
    <p role="status">{message}</p>
  </form>;
}
