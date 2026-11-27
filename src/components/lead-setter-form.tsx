'use client';
import { useState, useSyncExternalStore, useTransition, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useInteractiveReady } from './interactive-ready-marker';
import { saveSetterCallAction } from '@/lib/lead-setter-actions';
import { assistanceOptions, riskFields, riskOrigins, setterFields, setterOutcomes, type SetterDetails, type SetterOutcome, type SetterCommand } from '@/lib/lead-setter-contract';
import { LeadAppointmentFields, type AppointmentChoice, type CalendarChoice } from './lead-appointment-fields';

type Props = { leadId: string; actorId: string; confirmedIds: string[]; initialId: string; version: number | null; leadVersion: string; scheduledVideo: boolean;
  defaults: Partial<SetterDetails>; calendars: CalendarChoice[]; appointment: AppointmentChoice | null; legacyDate: string | null };
const inputClass = 'block w-full rounded-xl border p-2';
const pendingEvent = 'fai-lead-setter-receipt';
function subscribePending(notify: () => void) {
  window.addEventListener(pendingEvent, notify);
  return () => window.removeEventListener(pendingEvent, notify);
}
function rememberCommand(scope: string, id: string | null) {
  try {
    if (id) sessionStorage.setItem(scope, id);
    else sessionStorage.removeItem(scope);
    window.dispatchEvent(new Event(pendingEvent));
  } catch {
    // The in-memory command and server history remain available.
  }
}
export function LeadSetterForm({ leadId, actorId, confirmedIds, initialId, version, leadVersion, scheduledVideo, defaults, calendars, appointment, legacyDate }: Props) {
  const router = useRouter();
  const ready = useInteractiveReady();
  const [id, setId] = useState(initialId);
  const scope = 'fai.setter.command.v1:' + actorId + ':' + leadId;
  const pendingId = useSyncExternalStore(subscribePending, () => {
    try { return sessionStorage.getItem(scope); } catch { return null; }
  }, () => null);
  const persisted = !!pendingId && confirmedIds.includes(pendingId);
  const [outcome, setOutcome] = useState<SetterOutcome>('UNREACHABLE');
  const [next, setNext] = useState<SetterCommand['nextKind']>('CALLBACK');
  const [saved, setSaved] = useState(false), [pending, start] = useTransition();
  const [message, setMessage] = useState('');
  function changeOutcome(value: SetterOutcome) {
    setOutcome(value);
    setNext(value === 'VIDEO_BOOKED' || value === 'VIDEO_DEFERRED' ? 'VIDEO' : 'CALLBACK');
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready || pending || saved || persisted) return;
    const data = new FormData(event.currentTarget);
    const field = (name: string) => String(data.get(name) ?? '');
    const details = Object.fromEntries(Object.keys(setterFields).map(key => [key, field(key)]));
    const risks = Object.fromEntries(Object.keys(riskFields).map(key => [key, {
      origin: field(key + 'Origin') || 'UNKNOWN', finding: field(key + 'Finding'), source: field(key + 'Source'), date: field(key + 'Date'),
    }]));
    const assessment = outcome === 'UNREACHABLE' ? null : { ...details, ...risks, assistance: field('assistance') || 'UNKNOWN' } as SetterDetails;
    const commandId = pendingId || id;
    rememberCommand(scope, commandId);
    const value = { id: commandId, leadId, leadVersion, version, outcome, nextKind: next, nextLocal: field('nextLocal'), details: assessment,
      ...(next === 'VIDEO' ? { appointment: { id: appointment?.id ?? commandId, calendarId: field('calendar'),
        expectedVersion: appointment?.version ?? 0, durationMinutes: Number(field('duration')) } } : {}) };
    start(async () => {
      try {
        const result = await saveSetterCallAction(value);
        setMessage(result.message);
        if (result.ok) { setSaved(true); router.refresh(); }
      } catch { setMessage('Esito da verificare. Rileggi lo storico prima di iniziare una nuova chiamata. La scheda conserva le scelte.'); }
    });
  }
  if (saved || persisted) return <div><p role="status">{message || 'Chiamata e prossimo passo salvati. La ricevuta è presente nello storico.'}</p><button type="button" className="underline" onClick={() => {
    rememberCommand(scope,null); setId(crypto.randomUUID()); changeOutcome('UNREACHABLE'); setSaved(false); setMessage('');
  }}>Registra un’altra telefonata</button></div>;
  return <form method="post" onSubmit={submit} aria-busy={pending}><fieldset className="crm-space-y-3" disabled={!ready || pending}>
    <label>Esito<select aria-label="Esito" className={inputClass} value={outcome} onChange={e => changeOutcome(e.target.value as SetterOutcome)}>
      {Object.entries(setterOutcomes).filter(([key]) => scheduledVideo ? key !== 'VIDEO_BOOKED'
        : !['VIDEO_HELD','VIDEO_ABSENT','VIDEO_DEFERRED'].includes(key)).map(([key,label]) => <option key={key} value={key}>{label}</option>)}
    </select></label>
    {outcome !== 'UNREACHABLE' && <><div className="grid gap-3 md:grid-cols-2">
      {Object.entries(setterFields).map(([key,label]) => <label key={key}>{label}
        <textarea className={inputClass} name={key} maxLength={1600} rows={2}
          required={key === 'consultantSummary' && (outcome === 'CONTACT' || outcome === 'VIDEO_HELD')}
          defaultValue={defaults[key as keyof typeof setterFields] ?? ''}/></label>)}</div>
      <fieldset><legend>Informazioni creditizie</legend>{Object.entries(riskFields).map(([key,label]) => <fieldset key={key} className="my-3 rounded-xl border p-3">
        <legend>{label}</legend><div className="grid gap-2 md:grid-cols-2">
          <label>Origine {label}<select name={key+'Origin'} className={inputClass} defaultValue="UNKNOWN">
            {Object.entries(riskOrigins).map(([o,t]) => <option key={o} value={o}>{t}</option>)}</select></label>
          <label>Riscontro {label}<input name={key+'Finding'} className={inputClass} maxLength={1600}/></label>
          <label>Fonte {label}<input name={key+'Source'} className={inputClass} maxLength={1600}/></label>
          <label>Data {label}<input type="date" name={key+'Date'} className={inputClass}/></label>
        </div></fieldset>)}</fieldset>
      <label>Disponibilità per l’assistenza<select className={inputClass} name="assistance">
        {Object.entries(assistanceOptions).map(([k,v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      <p>Quando emerge un percorso adatto e il contatto sceglie l’affiancamento, il budget minimo indicativo è di 3.000–3.500 € oltre IVA.</p></>}
    <label>Prossimo passo<select aria-label="Prossimo passo" className={inputClass} value={next} onChange={e => setNext(e.target.value as SetterCommand['nextKind'])}>
      {['VIDEO_BOOKED','VIDEO_DEFERRED'].includes(outcome) ? <option value="VIDEO">Videochiamata</option> : <>
        <option value="CALLBACK">Richiamo</option>{!['UNREACHABLE','VIDEO_ABSENT'].includes(outcome) && <option value="NONE">Nessuna ulteriore azione prevista</option>}</>}
    </select></label>
    {next === 'VIDEO' ? <div className="grid gap-3 md:grid-cols-3">
      <LeadAppointmentFields calendars={calendars} appointment={appointment} assignedToId={actorId} legacyDate={legacyDate} setter />
      {!calendars.length && <div className="md:col-span-3"><p>Il referente deve prima salvare le proprie fasce in <Link href="/calendars" target="_blank" className="underline">Calendari</Link>. Le informazioni della chiamata restano in questa scheda.</p>
        <button type="button" className="underline" onClick={() => router.refresh()}>Rileggi calendari disponibili</button></div>}
    </div> : next === 'CALLBACK' && <label>Data del richiamo<input name="nextLocal" type="date" className={inputClass} required/></label>}
    <button className="rounded-xl bg-blue-900 px-4 py-2 font-bold text-white" disabled={pending || next === 'VIDEO' && !calendars.length}>
      {pending ? 'Salvataggio in corso…' : 'Salva chiamata e prossimo passo'}</button>
    {message && <p role="status">{message}</p>}
    {pendingId && <button type="button" className="underline" disabled={pending} onClick={() => router.refresh()}>Rileggi esito del salvataggio</button>}
  </fieldset></form>;
}
