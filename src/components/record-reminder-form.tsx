'use client';
import Link from 'next/link';
import { useRef, useState, useSyncExternalStore } from 'react';
import type { readRecordReminderSetup } from '@/lib/record-reminder-management';
import type { previewRecordReminder } from '@/lib/record-reminder-preview';
import type { ReminderInput } from '@/lib/record-reminder-contract';
import { communicationRecipientGroups } from '@/lib/communication-recipient-groups';
import { previewRecordReminderAction, confirmRecordReminderAction, verifyRecordReminderAction,
  cancelRecordReminderAction, verifyRecordReminderCancellationAction } from '@/lib/record-reminder-actions';

type Setup = Awaited<ReturnType<typeof readRecordReminderSetup>>;
type Preview = Awaited<ReturnType<typeof previewRecordReminder>>;
const field = 'w-full min-w-0 rounded-xl border border-slate-300 bg-white px-3 py-2';
const button = 'rounded-xl bg-fai-blue px-4 py-2 font-bold text-white disabled:opacity-50';
const subscribe = () => () => {};
const toggle = (rows: string[], value: string) => rows.includes(value) ? rows.filter(row => row !== value) : [...rows, value];
function remember(key: string, id: string) {
  const url = new URL(location.href);
  if (id) url.searchParams.set(key, id); else url.searchParams.delete(key);
  history.replaceState(null, '', url.pathname + url.search);
}
function time(value: string) {
  return new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', dateStyle: 'long', timeStyle: 'short' }).format(new Date(value)) + ' · Europe/Rome';
}
function localInstant(value: string) {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(value)) throw Error('INVALID_DATE');
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw Error('INVALID_DATE');
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  // A nonexistent daylight-saving local time must not silently normalize.
  if (local !== value) throw Error('INVALID_DATE');
  return date.toISOString();
}

export function RecordReminderForm({ setup }: { setup: Setup }) {
  const ready = useSyncExternalStore(subscribe, () => true, () => false), inFlight = useRef(false);
  const [taskId, setTaskId] = useState(''), [date, setDate] = useState('');
  const [people, setPeople] = useState<string[]>([]), [groups, setGroups] = useState<string[]>([]);
  const [command, setCommand] = useState<ReminderInput | null>(null), [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false), [consent, setConsent] = useState(false);
  const [confirmed, setConfirmed] = useState(false), [uncertain, setUncertain] = useState(false), [message, setMessage] = useState('');
  const locked = !ready || busy || Boolean(preview) || confirmed || uncertain;
  async function prepare() {
    if (inFlight.current || locked) return;
    inFlight.current = true; setBusy(true); setMessage(''); setConsent(false);
    try {
      const input: ReminderInput = { commandId: crypto.randomUUID(), ...setup.target, taskId,
        remindAt: localInstant(date), selection: { people, groups }, mode: 'CRM' };
      const result = await previewRecordReminderAction(input);
      if (result.ok) { setCommand(input); setPreview(result.preview); }
      else setMessage(result.message);
    } catch { setMessage('Riepilogo non disponibile: controlla data, ora e conferma personale. Nessun salvataggio richiesto.'); }
    finally { setBusy(false); inFlight.current = false; }
  }
  async function confirm() {
    if (inFlight.current || !command || !preview || !consent || confirmed || uncertain) return;
    inFlight.current = true; setBusy(true); remember('reminderDecision', command.commandId);
    try {
      const result = await confirmRecordReminderAction(command, preview.signed, consent);
      if (result.ok) { setConfirmed(true); setMessage('Promemoria registrato. Diventerà disponibile nel CRM all’istante scelto, soltanto con permessi ancora validi.'); }
      else {
        setMessage(result.message); setUncertain(!result.definite);
        if (result.definite) { setPreview(null); setCommand(null); remember('reminderDecision', ''); }
      }
    } catch { setUncertain(true); setMessage('Risposta non ricevuta. Verifica l’esito prima di programmare un altro promemoria.'); }
    finally { setBusy(false); inFlight.current = false; }
  }
  async function verify() {
    if (!command || inFlight.current) return;
    inFlight.current = true; setBusy(true);
    try {
      const result = await verifyRecordReminderAction(command.commandId);
      if (result.ok && result.result.confirmed) { setConfirmed(true); setUncertain(false); setMessage('Promemoria già registrato. Nessuna ripetizione necessaria.'); }
      else setMessage(result.ok ? 'Registrazione non osservata. Conserva questo riferimento e non ripetere l’operazione fino alla riconciliazione.' : result.message);
    } catch { setMessage('Verifica non disponibile. Riprova soltanto la verifica.'); }
    finally { setBusy(false); inFlight.current = false; }
  }
  return <div className="min-w-0 space-y-5" data-testid="record-reminder-form" data-interactive-ready={ready}>
    <p>Programma un avviso interno sulla scadenza di un’attività esistente. I destinatari vedranno la sola scadenza autorizzata. Le email richiedono un percorso e un’approvazione personali separati.</p>
    <fieldset disabled={locked} className="min-w-0 space-y-4">
      <label className="block font-bold">Attività con scadenza<select aria-label="Attività con scadenza" className={field} value={taskId} onChange={e => setTaskId(e.target.value)}>
        <option value="">Seleziona un’attività</option>{setup.tasks.map(task => <option key={task.id} value={task.id}>{task.title} · {time(task.dueAt)}</option>)}
      </select></label>
      <label className="block font-bold">Data e ora del promemoria<input aria-label="Data e ora del promemoria" type="datetime-local" step="60" className={field} value={date} onChange={e => setDate(e.target.value)} /></label>
      <p className="text-sm">Fuso del dispositivo: {ready ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'verifica in corso'}. Il riepilogo mostrerà anche l’ora di Roma. La scadenza dell’attività rimane invariata.</p>
      <fieldset className="rounded-xl border p-3"><legend className="px-1 font-bold">Persone da avvisare</legend>
        <div className="grid min-w-0 gap-3 md:grid-cols-2">{setup.people.map(person => <label key={person.id} className="flex min-w-0 items-start gap-2 text-sm">
          <input type="checkbox" checked={people.includes(person.id)} onChange={() => setPeople(toggle(people, person.id))} />
          <span className="min-w-0 break-words"><strong>{person.name}</strong><br/>{person.email} · {person.role.replaceAll('_', ' ')}</span>
        </label>)}</div>
      </fieldset>
      <fieldset className="rounded-xl border p-3"><legend className="px-1 font-bold">Gruppi esistenti</legend>
        <div className="grid gap-3 md:grid-cols-2">{Object.entries(communicationRecipientGroups).map(([id, group]) => <label key={id} className="flex items-start gap-2 text-sm">
          <input type="checkbox" checked={groups.includes(id)} onChange={() => setGroups(toggle(groups, id))}/>{group.label}
        </label>)}</div>
      </fieldset>
      <button type="button" className={button} disabled={!taskId || !date || (!people.length && !groups.length)} onClick={prepare}>Controlla il promemoria</button>
    </fieldset>
    {preview && !confirmed && <section aria-label="Riepilogo promemoria" className="space-y-3 rounded-2xl border-2 border-fai-green p-4">
      <h2 className="text-xl font-bold">Riepilogo promemoria</h2>
      <p>Disponibile dal: <strong>{time(preview.prepared.input.remindAt)}</strong>.<br/>Istante esatto: {preview.prepared.input.remindAt}.</p>
      <p>Scadenza selezionata: {time(preview.prepared.source.dueAt)}. Contenuto dell’avviso: scadenza dell’attività, senza note interne o allegati.</p>
      <ul className="space-y-2">{preview.recipients.map(person => <li key={person.id} className="break-words">
        <strong>{person.name}</strong> — {person.admitted ? 'avviso CRM, se ancora autorizzato all’istante scelto' : person.reason === 'EXPIRES_BEFORE_REMINDER' ? 'escluso: accesso in scadenza prima del promemoria' : 'escluso: accesso pertinente assente'}
      </li>)}</ul>
      <p className="text-sm">La selezione non concede accesso. Un cambiamento dell’attività, delle persone o dei permessi può sospendere il promemoria. Nessuna email viene inviata.</p>
      <label className="flex items-start gap-2"><input type="checkbox" checked={consent} disabled={busy || uncertain} onChange={e => setConsent(e.target.checked)}/>Confermo questo istante e questi destinatari per l’avviso CRM</label>
      <div className="flex flex-wrap gap-3"><button type="button" className={button} disabled={!consent || busy || uncertain} onClick={confirm}>Programma promemoria</button>
        <button type="button" className="rounded-xl border px-4 py-2" disabled={busy || uncertain} onClick={() => { setPreview(null); setConsent(false); }}>Modifica il riepilogo</button></div>
    </section>}
    {message && <p role="status" className="rounded-xl bg-slate-100 p-3">{message}</p>}
    {uncertain && <button type="button" className={button} disabled={busy} onClick={verify}>Verifica esito</button>}
    {command && (uncertain || confirmed) && <p className="break-all text-sm">Riferimento: {command.commandId}</p>}
    {confirmed && command && <Link href={`/notifications/reminders/${command.commandId}`} className="font-bold underline">Apri stato del promemoria</Link>}
  </div>;
}

export function RecordReminderRecovery({ commandId }: { commandId: string }) {
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [confirmed, setConfirmed] = useState(false);
  async function check() {
    if (busy) return;
    setBusy(true);
    try { const result = await verifyRecordReminderAction(commandId);
      if (result.ok && result.result.confirmed) { setConfirmed(true); setMessage('Promemoria già registrato.'); }
      else setMessage(result.ok ? 'Registrazione non osservata. Non ripetere l’operazione fino alla riconciliazione.' : result.message);
    } catch { setMessage('Verifica non disponibile. Conserva il riferimento.'); }
    finally { setBusy(false); }
  }
  return <div className="space-y-3"><h2 className="font-bold">Verifica il promemoria precedente</h2>
    <p>Questa pagina conserva un salvataggio già richiesto. Verifica l’esito prima di una nuova programmazione.</p>
    <p className="break-all">Riferimento: {commandId}</p><button className={button} disabled={busy || confirmed} onClick={check}>Verifica esito</button>
    {message && <p role="status">{message}</p>}{confirmed && <Link className="block font-bold underline" href={`/notifications/reminders/${commandId}`}>Apri stato del promemoria</Link>}</div>;
}

export function CancelRecordReminder({ reminderCommandId, resumeCommandId }: { reminderCommandId: string; resumeCommandId?: string }) {
  const inFlight = useRef(false), [busy, setBusy] = useState(false), [consent, setConsent] = useState(false);
  const [commandId, setCommandId] = useState(resumeCommandId ?? ''), [uncertain, setUncertain] = useState(Boolean(resumeCommandId));
  const [done, setDone] = useState(false), [message, setMessage] = useState('');
  async function cancel() {
    if (inFlight.current || !consent || uncertain || done) return;
    inFlight.current = true; setBusy(true);
    const id = crypto.randomUUID(); setCommandId(id); remember('cancelDecision', id);
    try { const result = await cancelRecordReminderAction({ commandId: id, reminderCommandId }, consent);
      if (result.ok) { setDone(true); setMessage('Promemoria annullato. Lo storico e le letture già registrate sono conservati.'); }
      else { setMessage(result.message); setUncertain(!result.definite); if (result.definite) remember('cancelDecision', ''); }
    } catch { setUncertain(true); setMessage('Risposta non ricevuta. Verifica l’annullamento senza ripeterlo.'); }
    finally { setBusy(false); inFlight.current = false; }
  }
  async function verify() {
    if (inFlight.current || !commandId) return;
    inFlight.current = true; setBusy(true);
    try { const result = await verifyRecordReminderCancellationAction({ commandId, reminderCommandId });
      if (result.ok && result.result.canceled) { setDone(true); setUncertain(false); setMessage('Annullamento già registrato.'); }
      else setMessage(result.ok ? 'Annullamento non osservato. Non ripetere l’operazione fino alla riconciliazione.' : result.message);
    } catch { setMessage('Verifica non disponibile. Riprova soltanto la verifica.'); }
    finally { setBusy(false); inFlight.current = false; }
  }
  return <div className="space-y-3 rounded-xl border border-orange-200 p-4">
    <h2 className="font-bold">Annulla promemoria</h2><p>L’avviso non sarà più consultabile dai destinatari. Le ricevute precedenti restano nello storico.</p>
    {!done && !uncertain && <><label className="flex items-start gap-2"><input type="checkbox" disabled={busy} checked={consent} onChange={e => setConsent(e.target.checked)}/>Confermo l’annullamento di questo promemoria</label>
      <button className={button} disabled={!consent || busy} onClick={cancel}>Annulla promemoria</button></>}
    {uncertain && <><p className="break-all text-sm">Riferimento annullamento: {commandId}</p><button className={button} disabled={busy} onClick={verify}>Verifica esito annullamento</button></>}
    {message && <p role="status">{message}</p>}{done && <a className="block font-bold underline" href={`/notifications/reminders/${reminderCommandId}`}>Rileggi lo stato aggiornato</a>}
  </div>;
}
