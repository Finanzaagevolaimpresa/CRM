'use client';
import { useState, useTransition, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { saveSetterCallAction } from '@/lib/lead-setter-actions';
import { assistanceOptions, riskFields, riskOrigins, setterFields, setterOutcomes, type SetterDetails, type SetterOutcome, type SetterCommand } from '@/lib/lead-setter-contract';

type Props = { leadId: string; initialId: string; version: number | null; leadVersion: string; scheduledVideo: boolean;
  defaults: Partial<SetterDetails> };
const inputClass = 'block w-full rounded-xl border p-2';
export function LeadSetterForm({ leadId, initialId, version, leadVersion, scheduledVideo, defaults }: Props) {
  const router = useRouter();
  const [id, setId] = useState(initialId);
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
    if (pending || saved) return;
    const data = new FormData(event.currentTarget);
    const field = (name: string) => String(data.get(name) ?? '');
    const details = Object.fromEntries(Object.keys(setterFields).map(key => [key, field(key)]));
    const risks = Object.fromEntries(Object.keys(riskFields).map(key => [key, {
      origin: field(key + 'Origin') || 'UNKNOWN', finding: field(key + 'Finding'), source: field(key + 'Source'), date: field(key + 'Date'),
    }]));
    const assessment = outcome === 'UNREACHABLE' ? null : { ...details, ...risks, assistance: field('assistance') || 'UNKNOWN' } as SetterDetails;
    const value = { id, leadId, leadVersion, version, outcome, nextKind: next, nextLocal: field('nextLocal'), details: assessment };
    start(async () => {
      try {
        const result = await saveSetterCallAction(value);
        setMessage(result.message);
        if (result.ok) { setSaved(true); router.refresh(); }
      } catch { setMessage('Esito da verificare. Rileggi lo storico prima di iniziare una nuova chiamata. La scheda conserva le scelte.'); }
    });
  }
  if (saved) return <div><p role="status">{message}</p><button className="underline" onClick={() => {
    setId(crypto.randomUUID()); changeOutcome('UNREACHABLE'); setSaved(false); setMessage('');
  }}>Registra un’altra telefonata</button></div>;
  return <form onSubmit={submit} className="crm-space-y-3">
    <label>Esito<select className={inputClass} value={outcome} onChange={e => changeOutcome(e.target.value as SetterOutcome)}>
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
    <label>Prossimo passo<select className={inputClass} value={next} onChange={e => setNext(e.target.value as SetterCommand['nextKind'])}>
      {['VIDEO_BOOKED','VIDEO_DEFERRED'].includes(outcome) ? <option value="VIDEO">Videochiamata</option> : <>
        <option value="CALLBACK">Richiamo</option>{!['UNREACHABLE','VIDEO_ABSENT'].includes(outcome) && <option value="NONE">Nessuna ulteriore azione prevista</option>}</>}
    </select></label>
    {next !== 'NONE' && <label>{next === 'VIDEO' ? 'Data e ora della videochiamata (Roma)' : 'Data del richiamo'}
      <input name="nextLocal" type={next === 'VIDEO' ? 'datetime-local' : 'date'} key={next} className={inputClass} required/></label>}
    <button className="rounded-xl bg-blue-900 px-4 py-2 font-bold text-white" disabled={pending}>
      {pending ? 'Salvataggio in corso…' : 'Salva chiamata e prossimo passo'}</button>
    {message && <p role="status">{message}</p>}
  </form>;
}
