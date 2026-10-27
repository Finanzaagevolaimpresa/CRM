'use client';
import { useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { ProjectParameterFields } from './project-parameter-fields';
import { communicationRecipientGroups } from '@/lib/communication-recipient-groups';
import { recordUpdateEvents, recordUpdateEventLabels, recordUpdateChangedLabels, type RecordUpdateEvent, type RecordUpdateMode } from '@/lib/record-update-labels';
import { updateFieldLabels, updatePatchSchema, type UpdateCommand, type UpdatePatch } from '@/lib/record-update-input';
import { previewRecordUpdateAction, confirmRecordUpdateAction, verifyRecordUpdateResultAction } from '@/lib/record-update-actions';
import type { readRecordUpdateSetup, previewRecordUpdate } from '@/lib/record-updates';

type Setup = Awaited<ReturnType<typeof readRecordUpdateSetup>>;
type Preview = Awaited<ReturnType<typeof previewRecordUpdate>>;
const fieldClass = 'w-full min-w-0 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm';
const buttonClass = 'rounded-xl bg-fai-green px-4 py-2 font-bold text-white disabled:opacity-50';
const subscribe = () => () => {};
const browserReady = () => true;
const serverReady = () => false;
function localDate(iso: string) {
  if (!iso) return '';
  const value = new Date(iso);
  return new Date(value.getTime() - value.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
function isoDate(local: string) { return local ? new Date(local).toISOString() : ''; }
export function RecordUpdateForm({ setup }: { setup: Setup }) {
  const savedSelection = setup.rule?.selection as { people?: string[]; groups?: string[] } | undefined;
  const [people, setPeople] = useState((savedSelection?.people ?? []).filter(id => setup.people.some(person => person.id === id)));
  const ready = useSyncExternalStore(subscribe, browserReady, serverReady);
  const [groups, setGroups] = useState(savedSelection?.groups ?? []);
  const [events, setEvents] = useState<RecordUpdateEvent[]>((setup.rule?.events ?? ['STATE_CHANGED', 'COMMUNICATION', 'NEXT_ACTION', 'DEADLINE']) as RecordUpdateEvent[]);
  const [patch, setPatch] = useState<UpdatePatch>(setup.patch);
  const [operation, setOperation] = useState<'UPDATE' | 'RULE'>('UPDATE');
  const [persistent, setPersistent] = useState(false);
  const [mode, setMode] = useState<RecordUpdateMode>(setup.emailDraftsAvailable ? (setup.rule?.mode as RecordUpdateMode ?? 'CRM') : 'CRM');
  const [expiry, setExpiry] = useState(setup.rule?.expiresAt ?? '');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [command, setCommand] = useState<UpdateCommand | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [consent, setConsent] = useState(false);
  const toggle = (values: string[], value: string) => values.includes(value) ? values.filter(x => x !== value) : [...values, value];
  const locked = busy || Boolean(preview) || confirmed || uncertain;
  const originator = setup.people.find(person => person.id === setup.originatorId);
  async function prepare(revoke = false) {
    setBusy(true); setMessage(''); setConsent(false);
    const input: UpdateCommand = { commandId: crypto.randomUUID(), kind: setup.kind, recordId: setup.id,
      operation: revoke ? 'REVOKE' : operation, expectedVersion: setup.expectedVersion, ruleVersion: setup.rule?.version ?? 0,
      mode: revoke ? 'CRM' : mode, selection: { people, groups }, events, persistent: !revoke && operation === 'UPDATE' && persistent,
      expiresAt: !revoke && (operation === 'RULE' || persistent) ? expiry || null : null, patch: !revoke && operation === 'UPDATE' ? patch : null };
    setCommand(input);
    try {
      const result = await previewRecordUpdateAction(input);
      if (result.ok) setPreview(result.preview); else setMessage(result.message);
    } catch { setMessage('Anteprima non disponibile. Riprova senza salvare.'); }
    finally { setBusy(false); }
  }
  async function confirm() {
    if (!preview || !command || !consent || busy) return;
    setBusy(true);
    try {
      const result = await confirmRecordUpdateAction(command, preview.digest);
      if (result.ok) { setConfirmed(true); setMessage('Operazione registrata. Gli avvisi sono disponibili soltanto ai destinatari ancora autorizzati.'); }
      else { setMessage(result.message); setUncertain(true); }
    } catch { setUncertain(true); setMessage('Risposta non ricevuta. Verifica l’esito prima di un nuovo salvataggio.'); }
    finally { setBusy(false); }
  }
  async function verify() {
    if (!command || busy) return;
    setBusy(true);
    try {
      const result = await verifyRecordUpdateResultAction(command.commandId);
      if (result.ok && result.result.confirmed) { setConfirmed(true); setUncertain(false); setMessage('Il salvataggio è già registrato. Nessuna ripetizione necessaria.'); }
      else if (result.ok) { setMessage('Nessuna registrazione trovata. Ricarica la scheda prima di preparare un nuovo salvataggio.'); }
      else setMessage(result.message);
    } catch { setMessage('Verifica non disponibile. Mantieni questa pagina e riprova la sola verifica.'); }
    finally { setBusy(false); }
  }
  const shape = updatePatchSchema.options.find(option => option.shape.kind.value === setup.kind)!.shape;
  return <div className="crm-space-y-5" data-testid="record-update-form" data-interactive-ready={ready}>
    <p className="text-sm text-slate-600">La scelta dei destinatari non concede accesso alla scheda. Le email richiedono una bozza e una nuova approvazione personale del testo esatto.</p>
    {setup.rule && <p className="rounded-xl bg-slate-100 p-3 text-sm">Regola: <strong>{!setup.rule.active ? 'revocata' : setup.rule.current ? 'attiva' : 'da riconfermare: contesto, persone o permessi cambiati'}</strong>.</p>}
    <fieldset disabled={locked} className="crm-space-y-4">
      <label className="block text-sm font-bold">Modalità di aggiornamento<select aria-label="Modalità di aggiornamento" className={fieldClass} value={mode} onChange={e => setMode(e.target.value as RecordUpdateMode)}>
        <option value="CRM">Avviso interno nel CRM</option>
        {setup.emailDraftsAvailable && <><option value="EMAIL_DRAFT">Bozza email da approvare</option><option value="CRM_AND_EMAIL_DRAFT">Avviso CRM e bozza email da approvare</option></>}
      </select></label>
      {!setup.emailDraftsAvailable && <p className="text-xs text-slate-600">Per questa scheda e il tuo profilo è disponibile il canale CRM.</p>}
      <label className="block text-sm font-bold">Operazione<select className={fieldClass} value={operation} onChange={e => setOperation(e.target.value as 'UPDATE' | 'RULE')}>
        <option value="UPDATE">Salva e aggiorna</option><option value="RULE">Configura una regola per gli aggiornamenti futuri</option>
      </select></label>
      {operation === 'UPDATE' && <div className="grid min-w-0 gap-3 md:grid-cols-2">{Object.entries(patch).filter(([key]) => key !== 'kind' && key !== 'parameters').map(([key, rawValue]) => {
        const value = typeof rawValue === 'string' ? rawValue : '';
        const isDate = ['nextActionDate', 'dueDate', 'nextClientUpdateAt'].includes(key);
        const schema = shape[key as keyof typeof shape];
        const options = (key === 'status' || key === 'type') && schema && 'options' in schema ? schema.options as string[] : null;
        const change = (next: string) => setPatch({ ...patch, [key]: next } as UpdatePatch);
        return <label className="block min-w-0 text-sm font-bold" key={key}>{updateFieldLabels[key]}
          {options ? <select aria-label={updateFieldLabels[key]} className={fieldClass} value={value} onChange={e => change(e.target.value)}>{options.map(option => <option key={option} value={option}>{option.replaceAll('_', ' ')}</option>)}</select>
            : <input aria-label={updateFieldLabels[key]} className={fieldClass} type={isDate ? 'datetime-local' : 'text'} value={isDate ? localDate(value) : value}
              onChange={e => change(isDate ? isoDate(e.target.value) : e.target.value)} />}
        </label>;
      })}</div>}
      {operation === 'UPDATE' && patch.kind === 'PROJECT' && patch.parameters && <ProjectParameterFields value={patch.parameters} onChange={parameters => setPatch({ ...patch, parameters })} />}
      {operation === 'UPDATE' && patch.kind === 'PROJECT' && !patch.parameters && <p role="status">Il progetto supera il limite di 100 spese del modulo: qui puoi modificare soltanto titolo e stato.</p>}
      {originator && <p className="text-sm">Commerciale del contratto, da attribuzione verificata: <strong>{originator.name}</strong>. Puoi includerlo nella scelta qui sotto.</p>}
      <fieldset className="rounded-xl border p-3"><legend className="px-1 font-bold">Persone da aggiornare</legend>
        <div className="grid gap-3 md:grid-cols-2">{setup.people.map(person => <label key={person.id} className="flex min-w-0 items-start gap-2 text-sm">
          <input className="mt-1" type="checkbox" checked={people.includes(person.id)} onChange={() => setPeople(toggle(people, person.id))} />
          <span className="min-w-0 break-words"><strong>{person.name}</strong><br/>{person.email} · {person.role.replaceAll('_', ' ')}</span>
        </label>)}</div>
      </fieldset>
      <fieldset className="rounded-xl border p-3"><legend className="px-1 font-bold">Oppure gruppi esistenti</legend>
        <div className="grid gap-3 md:grid-cols-2">{Object.entries(communicationRecipientGroups).map(([id, group]) => <label key={id} className="flex items-start gap-2 text-sm">
          <input className="mt-1" type="checkbox" checked={groups.includes(id)} onChange={() => setGroups(toggle(groups, id))} />{group.label}
        </label>)}</div><p className="mt-3 text-xs text-slate-600">Il riepilogo mostrerà i nomi effettivi. Se cambiano membri o permessi, la regola richiede una nuova conferma.</p>
      </fieldset>
      {operation === 'UPDATE' && <label className="flex items-start gap-2 text-sm font-bold"><input className="mt-1" type="checkbox" checked={persistent} onChange={e => setPersistent(e.target.checked)} />Attiva anche una regola per questa scheda</label>}
      {(operation === 'RULE' || persistent) && <fieldset className="crm-space-y-3 rounded-xl border p-3"><legend className="px-1 font-bold">Regola persistente</legend>
        {recordUpdateEvents.map(event => <label key={event} className="flex items-start gap-2 text-sm"><input className="mt-1" type="checkbox" checked={events.includes(event)} onChange={() => setEvents(toggle(events, event) as RecordUpdateEvent[])} />{recordUpdateEventLabels[event]}</label>)}
        <label className="block text-sm font-bold">Scadenza facoltativa<input type="datetime-local" className={fieldClass} value={localDate(expiry)} onChange={e => setExpiry(isoDate(e.target.value))} /></label>
      </fieldset>}
      <div className="flex flex-wrap gap-3"><button className={buttonClass} type="button" onClick={() => prepare()}>Controlla destinatari e modifiche</button>
        {setup.rule?.active && <button className="rounded-xl border border-red-300 px-4 py-2 font-bold text-red-700" type="button" onClick={() => prepare(true)}>Revoca regola</button>}</div>
    </fieldset>
    {preview && !confirmed && <section aria-label="Riepilogo aggiornamento" className="crm-space-y-4 rounded-2xl border-2 border-fai-green p-4">
      <h2 className="text-xl font-bold">Riepilogo prima della conferma</h2>
      <p className="break-words font-bold">{preview.label}</p>
      <p>{preview.operation === 'REVOKE' ? 'Revoca della regola: nessun nuovo avviso sarà consegnato tramite questa regola.' : preview.operation === 'RULE' ? 'Attivazione o modifica della regola per gli eventi scelti.' : 'Un solo salvataggio della scheda e degli avvisi ammessi.'}</p>
      {preview.summaries.map(summary => <p key={summary.event}>{recordUpdateEventLabels[summary.event]}: {summary.changed.map(field => recordUpdateChangedLabels[field]).join(', ')}.</p>)}
      {preview.people.map(person => <div key={person.id} className="min-w-0 rounded-xl bg-slate-50 p-3 text-sm">
        <p className="break-words font-bold">{person.name} · {person.email}</p>
        <p>{person.available ? preview.mode === 'CRM' ? 'Riceve un avviso CRM; può aprire soltanto i dati già autorizzati.' : preview.mode === 'EMAIL_DRAFT' ? 'Una bozza email distinta sarà preparabile dall’Admin, con nuova approvazione prima dell’invio.' : 'Riceve un avviso CRM; una bozza email distinta sarà preparabile dall’Admin, con nuova approvazione prima dell’invio.' : 'Escluso: non ha accesso corrente alla scheda. Nessun permesso viene aggiunto.'}</p>
        {person.available && preview.events.includes('COMMUNICATION') && !person.communication && <p>Gli avvisi di comunicazione sono esclusi: manca il relativo permesso.</p>}
      </div>)}
      {preview.persistent && <p className="text-sm">Regola attiva per: {preview.events.map(event => recordUpdateEventLabels[event]).join(', ')}. {preview.expiresAt ? 'Scadenza: ' + new Date(preview.expiresAt).toLocaleString('it-IT') : 'Senza scadenza, revocabile da questa scheda.'}</p>}
      <label className="flex items-start gap-2 text-sm font-bold"><input className="mt-1" type="checkbox" checked={consent} disabled={busy || uncertain} onChange={e => setConsent(e.target.checked)} />Confermo questa operazione, i destinatari ammessi e la modalità {preview.mode === 'CRM' ? 'avviso CRM' : preview.mode === 'EMAIL_DRAFT' ? 'bozza email da approvare' : 'avviso CRM e bozza email da approvare'}</label>
      <div className="flex flex-wrap gap-3"><button className={buttonClass} type="button" disabled={!consent || busy || uncertain} onClick={confirm}>{preview.operation === 'UPDATE' ? 'Salva e aggiorna' : preview.operation === 'RULE' ? 'Attiva regola' : 'Conferma revoca'}</button>
        <button className="rounded-xl border px-4 py-2" type="button" disabled={busy || uncertain} onClick={() => { setPreview(null); setCommand(null); setConsent(false); }}>Modifica la scelta</button></div>
      <p className="text-xs text-slate-600">È richiesta la conferma amministrativa personale attiva nelle impostazioni di sicurezza.</p>
    </section>}
    {message && <p role="status" className="rounded-xl bg-slate-100 p-3 text-sm">{message}</p>}
    {uncertain && !confirmed && <button type="button" className={buttonClass} disabled={busy} onClick={verify}>Verifica esito</button>}
    {(confirmed || uncertain) && <a className="inline-block font-bold underline" href={setup.href}>Torna alla scheda aggiornata</a>}
    {setup.emailDraftsAvailable && <Link href="/communications/updates" className="block font-bold underline">Bozze da aggiornamenti</Link>}
    <Link href="/settings/security" className="block text-sm font-bold underline">Conferma amministrativa personale</Link>
  </div>;
}
