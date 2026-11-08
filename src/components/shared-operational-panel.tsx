'use client';
import Link from 'next/link';
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import type { SharedOperationalPanel as Panel } from '@/lib/shared-operational-updates';
import type { SharedUpdateCommand, SharedUpdateTarget } from '@/lib/shared-operational-update-contract';
import { clientOperationalStateLabels } from '@/lib/shared-operational-display';
import { saveSharedOperationalAction, settleSharedOperationalAction } from '@/lib/shared-operational-actions';
import { InlinePrivilegedConfirmation } from './inline-privileged-confirmation';

const field = 'block w-full rounded-xl border border-slate-300 p-3';
const button = 'rounded-xl bg-fai-blue px-4 py-3 font-semibold text-white disabled:opacity-50';
const empty = { text: '', state: '', nextAction: '', nextActionDueOn: '', correctionOfId: '' };
const format = (value: string) => new Date(value).toLocaleString('it-IT', { timeZone: 'Europe/Rome' });
const stateLabel = (value: string | null) => value
  ? clientOperationalStateLabels[value as keyof typeof clientOperationalStateLabels] ?? value.replaceAll('_', ' ') : 'Da completare';
const missing = (value: string | null | undefined) => value || 'Da completare';
const subscribe = (listener: () => void) => {
  window.addEventListener('fai-shared-update', listener);
  return () => window.removeEventListener('fai-shared-update', listener);
};

export function SharedOperationalPanel({ target, actorId }: { target: SharedUpdateTarget; actorId: string }) {
  const fieldId = useId();
  const [panel, setPanel] = useState<Panel | null>(null), [loading, setLoading] = useState(true);
  const [values, setValues] = useState(empty), [base, setBase] = useState<Pick<Panel, 'expectedContext' | 'expectedVersion'> | null>(null);
  const [pending, setPending] = useState(false), [message, setMessage] = useState(''), [stepUp, setStepUp] = useState(false);
  const busy = useRef(false), sequence = useRef(0), controller = useRef<AbortController | null>(null);
  const command = useRef<SharedUpdateCommand | null>(null);
  const key = 'fai-shared-update:' + actorId + ':' + target.kind + ':' + target.id;
  const saved = useSyncExternalStore(subscribe, () => {
    try { const value = sessionStorage.getItem(key); return value && /^[0-9a-f-]{36}$/i.test(value) ? value : null; }
    catch { return null; }
  }, () => null);
  const refresh = useCallback(async () => {
    const current = ++sequence.current;
    controller.current?.abort();
    const abort = new AbortController(); controller.current = abort;
    const timeout = setTimeout(() => abort.abort(), 10_000);
    try {
      const response = await fetch('/api/operational-updates?kind=' + target.kind + '&id=' + encodeURIComponent(target.id),
        { cache: 'no-store', credentials: 'same-origin', signal: abort.signal });
      const result = response.ok ? await response.json() as { available: boolean; panel: Panel } : null;
      if (sequence.current === current) setPanel(result?.available ? result.panel : null);
    } catch { if (sequence.current === current) setPanel(null); }
    finally { clearTimeout(timeout); if (sequence.current === current) setLoading(false); }
  }, [target.kind, target.id]);
  const cancelRead = useCallback(() => {
    ++sequence.current;
    controller.current?.abort();
  }, []);
  useEffect(() => {
    const poll = () => { if (!document.hidden && !busy.current) void refresh(); };
    poll();
    const timer = setInterval(poll, 3000);
    document.addEventListener('visibilitychange', poll);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', poll); cancelRead(); };
  }, [refresh, cancelRead]);
  const stale = Boolean(base && panel && (base.expectedContext !== panel.expectedContext || base.expectedVersion !== panel.expectedVersion));
  function clearPending() {
    try { sessionStorage.removeItem(key); window.dispatchEvent(new Event('fai-shared-update')); } catch { /* In-memory command stays retained. */ }
  }
  function change(name: keyof typeof empty, value: string) {
    if (saved || pending) return;
    if (!base && panel) setBase({ expectedContext: panel.expectedContext, expectedVersion: panel.expectedVersion });
    setValues(v => ({ ...v, [name]: value })); command.current = null;
  }
  function recorded(time: string) {
    clearPending(); command.current = null; setValues(empty); setBase(null); setStepUp(false);
    setMessage('Aggiornamento salvato. Notifiche interne registrate · ' + format(time));
    window.dispatchEvent(new Event('fai-notifications-changed'));
    void refresh();
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy.current || saved || stale || !panel?.canWrite || !values.text.trim()) return;
    const input: SharedUpdateCommand = command.current ?? { commandId: crypto.randomUUID(), target,
      expectedContext: (base ?? panel).expectedContext, expectedVersion: (base ?? panel).expectedVersion,
      text: values.text.trim(), state: values.state || null, nextAction: values.nextAction.trim() || null,
      nextActionDueOn: values.nextActionDueOn || null, correctionOfId: values.correctionOfId || null,
      classification: 'SHARED_OPERATIONAL' };
    command.current = input;
    // Only a random receipt reference is persisted in this browser, never text,
    // contact details, credentials or the contents of the update.
    try { sessionStorage.setItem(key, input.commandId); window.dispatchEvent(new Event('fai-shared-update')); }
    catch { setMessage('Il browser non conserva il riferimento. Nessun salvataggio è stato richiesto.'); return; }
    busy.current = true; setPending(true);
    try {
      const result = await saveSharedOperationalAction(input);
      if (result.ok) recorded(result.result.recordedAt);
      else {
        setMessage(result.message);
        if (result.stepUpRequired) { clearPending(); setStepUp(true); }
        else if ('uncertain' in result && !result.uncertain) { clearPending(); command.current = null; void refresh(); }
      }
    } catch { setMessage('La risposta non è arrivata. Verifica l’esito prima di salvare ancora.'); }
    finally { busy.current = false; setPending(false); }
  }
  async function settle() {
    if (!saved || busy.current) return;
    busy.current = true; setPending(true);
    try {
      const response = await settleSharedOperationalAction({ commandId: saved, target });
      if (!response.ok) { setMessage(response.message); return; }
      if (response.result.receipt) recorded(response.result.receipt.recordedAt);
      else {
        clearPending(); command.current = null; setBase(null);
        setMessage('Tentativo chiuso senza aggiornamento. Il testo è conservato: controlla il contesto corrente prima di salvare.');
        void refresh();
      }
    } catch { setMessage('Esito ancora da verificare. Non ripetere il salvataggio.'); }
    finally { busy.current = false; setPending(false); }
  }
  return <section className="my-6 space-y-5 rounded-xl border p-5" aria-label="Stato d’aggiornamento in tempo reale"
    data-testid="shared-operational-panel" data-server-time={panel?.serverTime ?? ''}>
    <h2 className="text-xl font-bold">Stato d’aggiornamento in tempo reale</h2>
    <p className="text-sm">Aggiornamenti operativi condivisi e notifiche interne. Le viste aperte si aggiornano ogni 3 secondi mentre sono visibili.</p>
    {message && <p role="status">{message}</p>}
    {saved && <div className="rounded-lg border border-amber-400 p-3"><p>Un salvataggio è da verificare. Riferimento: <code>{saved}</code>.</p>
      <button className={button} disabled={pending} type="button" onClick={settle}>Verifica esito e chiudi il tentativo</button></div>}
    {stepUp && <InlinePrivilegedConfirmation />}
    {loading ? <p>Verifica del perimetro corrente…</p> : !panel && <p>Box non disponibile nel perimetro corrente. L’Admin può verificare l’incarico nominale e l’azione «Leggere dati cliente e referente e salvare aggiornamenti condivisi». Il testo già scritto resta conservato.</p>}
    {panel && <><p><strong>{panel.title}</strong> · Stato operativo: {panel.stateVisible ? stateLabel(panel.currentState) : 'Non incluso nell’incarico'}</p>
      {!panel.writesAvailable && <p>Salvataggi e chiusure dei tentativi sospesi durante il recupero applicativo compatibile. Storico e dati cliente restano consultabili nel perimetro autorizzato.</p>}
      {target.kind === 'CLIENT' && <p>Questo stato riguarda il lavoro operativo sul cliente. Non cambia il lifecycle Cliente, il Lead o gli stati delle singole pratiche.</p>}
      <ClientContactPanel contacts={panel.contacts} />
      {panel.missingCommercial && <p className="rounded-lg border border-amber-400 p-3">Nessun commerciale referente attualmente ammesso: il salvataggio notificherà solo gli Admin disponibili. L’Admin può verificare assegnazione e permessi dalla scheda.</p>}
      {panel.canWrite && <p>Chi viene aggiornato automaticamente: {panel.recipients.map(p => p.name + ' · ' + p.role).join('; ')}. Nessuna email.</p>}
    </>}
    {(panel?.canWrite || values.text) && <form onSubmit={save} className="space-y-3" aria-label="Salva aggiornamento condiviso">
      {stale && <div role="alert"><p>La scheda o l’incarico è cambiato. Leggi lo stato e i destinatari correnti; il testo è conservato.</p>
        <button type="button" className="underline" disabled={Boolean(saved) || pending || !panel?.canWrite} onClick={() => {
          if (panel) { setBase({ expectedContext: panel.expectedContext, expectedVersion: panel.expectedVersion }); command.current = null; }
        }}>Ho riletto il contesto · conserva il testo</button></div>}
      <fieldset disabled={pending || Boolean(saved) || !panel?.canWrite} className="space-y-3">
        {values.correctionOfId && <p>Rettifica collegata a {values.correctionOfId}. Il testo precedente resta nello storico.</p>}
        <label className="block" htmlFor={fieldId + '-text'}>Testo operativo condiviso</label>
        <textarea id={fieldId + '-text'} required maxLength={4000} className={field}
          value={values.text} onChange={e => change('text', e.target.value)} />
        <p className="text-sm">Inserisci solo informazioni operative pertinenti. Pagamenti, contratti firmati e note amministrative riservate restano nei rispettivi percorsi.</p>
        <label className="block" htmlFor={fieldId + '-state'}>Stato da aggiornare esplicitamente</label>
        <select id={fieldId + '-state'} className={field} value={values.state}
          disabled={Boolean(values.correctionOfId) || !panel?.states.length} onChange={e => change('state', e.target.value)}>
          <option value="">Non modificare lo stato</option>{panel?.states.map(state => <option key={state} value={state}>{stateLabel(state)}</option>)}</select>
        <label className="block" htmlFor={fieldId + '-next'}>Prossima azione (facoltativa)</label>
        <input id={fieldId + '-next'} maxLength={500} className={field} value={values.nextAction} onChange={e => change('nextAction', e.target.value)} />
        <label className="block" htmlFor={fieldId + '-due'}>Scadenza prossima azione (facoltativa)</label>
        <input id={fieldId + '-due'} type="date" className={field} value={values.nextActionDueOn} onChange={e => change('nextActionDueOn', e.target.value)} />
        <button className={button} type="submit" disabled={stale || !values.text.trim()}>{pending ? 'Salvataggio in corso…' : 'Salva e notifica'}</button>
      </fieldset>
    </form>}
    {panel && <section aria-label="Storico condiviso" className="space-y-3"><h3 className="font-bold">Storico · stesso evento nelle schede collegate</h3>
      {!panel.history.length && <p>Nessun aggiornamento operativo condiviso disponibile.</p>}
      {panel.history.map(row => <article key={row.id} id={'update-' + row.id} className="rounded-lg border p-3" data-event-id={row.eventId}>
        <p className="font-semibold">{row.authorName} · {format(row.createdAt)} · ora server, Europe/Rome</p>
        <Link className="underline" href={row.href}>{row.sourceLabel}</Link>
        {row.correctionOfId && <p>Rettifica del riferimento {row.correctionOfId}</p>}
        {row.correctedById && <p>Conservato nello storico · rettificato da {row.correctedById}</p>}
        <p className="whitespace-pre-wrap break-words">{row.text}</p>
        {row.stateChanged && <p>Stato scelto: {stateLabel(row.stateBefore)} → {stateLabel(row.stateAfter)}</p>}
        {row.nextAction && <p>Prossima azione: {row.nextAction}</p>}
        {row.nextActionDueOn && <p>Scadenza: {row.nextActionDueOn}</p>}
        {row.canCorrect && <button className="underline" disabled={pending || Boolean(saved) || Boolean(values.text)} type="button" onClick={() => {
          setValues({ text: row.text, state: '', nextAction: row.nextAction ?? '', nextActionDueOn: row.nextActionDueOn ?? '', correctionOfId: row.id });
          setBase({ expectedContext: panel.expectedContext, expectedVersion: panel.expectedVersion }); command.current = null;
        }}>Rettifica con storico</button>}
      </article>)}</section>}
  </section>;
}
function ClientContactPanel({ contacts }: { contacts: Panel['contacts'] }) {
  return <section aria-label="Dati cliente e referente" className="space-y-4 rounded-lg bg-slate-50 p-4">
    <h3 className="font-bold">Dati cliente e referente</h3><p>{contacts.clientName} · {contacts.companyScope}</p>
    {!contacts.companies.length && <p>Azienda, amministratore, dati fiscali e indirizzi: da completare nell’anagrafica canonica.</p>}
    {contacts.companies.map(company => <article key={company.id} className="space-y-2 border-t pt-3">
      <h4 className="font-semibold">{company.name}</h4><p className="text-sm">{company.origin}</p>
      <p>Codice fiscale azienda: {missing(company.taxCode)} · Partita IVA: {missing(company.vatNumber)}</p>
      <p>PEC: {missing(company.pec)} · SDI: {missing(company.sdiCode)}</p>
      <p>Sede legale — Via/piazza: {missing(company.legalStreet)} · Civico: {missing(company.legalStreetNumber)} · CAP: {missing(company.legalPostalCode)} · Città: {missing(company.legalCity)} · Provincia: {missing(company.legalProvince)}</p>
      <p>Sede operativa — Via/piazza: {missing(company.operatingStreet)} · Civico: {missing(company.operatingStreetNumber)} · CAP: {missing(company.operatingPostalCode)} · Città: {missing(company.operatingCity)} · Provincia: {missing(company.operatingProvince)}</p>
      {company.legalAddress && <p>Indirizzo legale storico non strutturato: {company.legalAddress}</p>}
      {company.operatingAddress && <p>Indirizzo operativo storico non strutturato: {company.operatingAddress}</p>}
      {!company.people.some(person => person.isAdministrator) && <p>Amministratore identificato esplicitamente: da completare.</p>}
      {!company.people.some(person => person.isOperationalContact) && <p>Referente aziendale responsabile da contattare: da completare.</p>}
      {company.people.map(link => <div key={link.id} className="rounded border p-2">
        <p>{link.person.firstName} {link.person.lastName} · Ruolo dichiarato: {missing(link.role)}</p>
        <p>{link.isAdministrator ? 'Amministratore indicato' : 'Non indicato come amministratore'} · {link.isOperationalContact ? 'Referente operativo indicato' : 'Non indicato come referente operativo'}</p>
        <p>Codice fiscale persona: {missing(link.person.taxCode)} · Telefono: {missing(link.person.phone)} · Email: {missing(link.person.email)}</p>
        <p className="text-sm">{link.origin}</p>
      </div>)}
    </article>)}
    {contacts.lead && <div className="border-t pt-3"><p className="font-semibold">{contacts.lead.origin}</p>
      <p>{contacts.lead.companyName} · {contacts.lead.firstName} {contacts.lead.lastName}</p>
      <p>Contatto dichiarato sul Lead: {missing(contacts.lead.contactPerson)} · Telefono: {missing(contacts.lead.phone)} · Email: {missing(contacts.lead.email)}</p>
      <p>Questo dato non identifica automaticamente l’amministratore o il referente operativo dell’azienda.</p></div>}
    <p className="text-sm">I dati mancanti non impediscono di registrare un aggiornamento operativo. Le note condivise pertinenti sono nello storico sottostante; le note libere precedenti restano riservate.</p>
  </section>;
}
