'use client';
import Link from 'next/link';
import { useRef, useState, useSyncExternalStore } from 'react';
import type { DriveFolderCommand, DriveFolderDetails, DriveFolderSnapshot } from '@/lib/drive-folder-contract';
import { previewDriveFolderAction, confirmDriveFolderAction, verifyDriveFolderAction } from '@/lib/drive-folder-actions';
import { InlinePrivilegedConfirmation } from './inline-privileged-confirmation';

type Person = { id: string; name: string; email: string; role: string; canRead: boolean };
type Preview = Extract<Awaited<ReturnType<typeof previewDriveFolderAction>>, { ok: true }>['value'];
const field = 'block w-full rounded-xl border p-3 font-normal';
const button = 'rounded-xl border p-3 font-bold disabled:opacity-50';
const subscribe = () => () => {}, clientReady = () => true, serverReady = () => false;
export function DriveFolderEditor({ id, current: initialCurrent, people, clients, initialClientId = '' }: {
  id: string; current: DriveFolderSnapshot | null; people: Person[]; clients: { id: string; name: string }[]; initialClientId?: string;
}) {
  const interactive = useSyncExternalStore(subscribe, clientReady, serverReady);
  // Preserve the editing baseline as well as the choices during action refreshes.
  // A changed server revision must not silently admit edits made on an old one.
  const [current] = useState(initialCurrent);
  // A server refresh of /new may propose another UUID. Keep this editor's ID
  // through inline reconfirmation and terminal reconciliation of its commands.
  const [folderId] = useState(id);
  const [details, setDetails] = useState<DriveFolderDetails>(current?.details ?? { url: '', title: '', clientId: initialClientId,
    people: [], technicalContentReviewed: false, expiresAt: null });
  const [proposal, setProposal] = useState<{ command: DriveFolderCommand; preview: Preview } | null>(null);
  const [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [done, setDone] = useState(false);
  const [message, setMessage] = useState(''), [stepUp, setStepUp] = useState(false), [consent, setConsent] = useState(false);
  const pending = useRef(false), locked = !interactive || busy || uncertain || done || Boolean(proposal);
  const patch = (value: Partial<DriveFolderDetails>) => setDetails(old => ({ ...old, ...value, technicalContentReviewed: false }));
  async function prepare(operation: DriveFolderCommand['operation']) {
    if (!interactive || pending.current || locked) return;
    pending.current = true; setBusy(true); setMessage(''); setConsent(false);
    const base = { protocol: 'DRIVE_FOLDER_REFERENCE_V1' as const, commandId: crypto.randomUUID(), folderId, expectedVersion: current?.revision ?? 0 };
    const command: DriveFolderCommand = operation === 'DISABLE' ? { ...base, operation } : { ...base, operation, details };
    try {
      const result = await previewDriveFolderAction(command);
      if (result.ok) setProposal({ command, preview: result.value }); else setMessage(result.message);
    } catch { setMessage('Anteprima non disponibile. Le scelte sono conservate; nessun salvataggio è stato richiesto.'); }
    finally { pending.current = false; setBusy(false); }
  }
  async function execute(check = false) {
    if (pending.current || !proposal || done || !check && (!consent || uncertain)) return;
    pending.current = true; setBusy(true);
    try {
      const result = check ? await verifyDriveFolderAction(proposal.command, proposal.preview.digest)
        : await confirmDriveFolderAction(proposal.command, proposal.preview.digest);
      if (result.ok && result.value.confirmed) { setDone(true); setUncertain(false); setMessage('Operazione registrata. Riapri la scheda per lo stato persistito.'); }
      else if (result.ok && result.value.closed || !result.ok && 'closed' in result && result.closed) {
        setProposal(null); setConsent(false); setUncertain(false);
        setStepUp(!result.ok && 'stepUpRequired' in result && Boolean(result.stepUpRequired));
        setMessage(result.ok ? 'Tentativo chiuso senza modifica. Puoi preparare un nuovo riepilogo con le scelte conservate.' : result.message);
      } else { setUncertain(true); setMessage(result.ok ? 'Esito da verificare.' : result.message); }
    } catch { setUncertain(true); setMessage('Risposta non ricevuta. Usa Verifica esito: non ripetere il salvataggio.'); }
    finally { pending.current = false; setBusy(false); }
  }
  const unavailable = details.people.filter(id => !people.some(p => p.id === id && p.canRead));
  const date = details.expiresAt ? new Date(details.expiresAt) : null;
  const localDate = date ? new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';
  return <section className="space-y-5 min-w-0" data-testid="drive-folder-editor" data-interactive-ready={interactive}>
    <p>Collega una cartella esistente. Il CRM salva soltanto il riferimento e le scelte di accesso: nessun file viene caricato, copiato o modificato.</p>
    <p>Le cartelle Drive possono essere configurate per chiunque abbia il link. Il CRM limita chi vede il riferimento qui; disabilitarlo
      non revoca un link già copiato né impedisce l’inoltro. I permessi Google restano separati e invariati.</p>
    <fieldset disabled={locked} className="space-y-4">
      <label className="block font-bold">Cliente / account<select aria-label="Cliente / account" className={field} value={details.clientId} onChange={e => patch({ clientId: e.target.value })}>
        <option value="">Seleziona un cliente esistente</option>
        {details.clientId && !clients.some(c => c.id === details.clientId) && <option value={details.clientId}>Cliente non disponibile</option>}
        {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      <label className="block font-bold">Titolo del fascicolo<input className={field} maxLength={160} value={details.title} onChange={e => patch({ title: e.target.value })}/></label>
      <label className="block font-bold">Link della cartella Google Drive<input className={field} type="url" maxLength={2048} value={details.url}
        onChange={e => patch({ url: e.target.value })} placeholder="https://drive.google.com/drive/folders/…"/></label>
      <fieldset className="space-y-2"><legend className="font-bold">Persone autorizzate a questa cartella</legend>
        <p>Il permesso «Aprire Fascicoli Drive» abilita la sezione. Questa selezione abilita soltanto la cartella indicata, senza aprire altri dati CRM.</p>
        {people.map(p => <div key={p.id} className="space-y-1"><label className="flex gap-2"><input type="checkbox" disabled={!p.canRead}
          checked={details.people.includes(p.id)} onChange={() => patch({ people: details.people.includes(p.id)
            ? details.people.filter(id => id !== p.id) : [...details.people, p.id] })}/>
          <span>{p.name} · {p.email} · {p.role}{!p.canRead && ' · sezione non abilitata'}</span></label>
          {!p.canRead && <Link className="text-sm underline" href={'/settings/users/' + p.id} target="_blank">Apri account per abilitare la sezione; poi ricarica questa scheda</Link>}</div>)}
        {unavailable.length > 0 && <p>Selezioni non più disponibili: {unavailable.length}. <button type="button" className="underline"
          onClick={() => patch({ people: details.people.filter(id => !unavailable.includes(id)) })}>Rimuovi dalla selezione</button></p>}
      </fieldset>
      <label className="flex gap-2"><input type="checkbox" checked={details.technicalContentReviewed}
        onChange={e => setDetails({ ...details, technicalContentReviewed: e.target.checked })}/>
        Ho verificato cartella, sottocartelle, titolo e nome cliente: non espongono ai tecnici pagamenti, riferimenti di pagamento, contratti firmati o note riservate.</label>
      <p className="text-sm">Se contiene dati riservati, non selezionare tecnici. Il CRM non legge la cartella né controlla i futuri file Google:
        mantieni separato il fascicolo tecnico. Una modifica del contenuto richiede di rivedere la condivisione.</p>
      <label className="block font-bold">Scadenza del riferimento CRM (facoltativa)<input className={field} type="datetime-local" value={localDate}
        onChange={e => patch({ expiresAt: e.target.value ? new Date(e.target.value).toISOString() : null })}/></label>
      <p className="text-sm">Un cambio di cliente o link richiede prima una bozza privata. L’attivazione conserva i destinatari nominativi del riepilogo;
        i nuovi account non vengono aggiunti automaticamente.</p>
    </fieldset>
    {!proposal && !done && <div className="flex flex-wrap gap-3">
      <button className={button} disabled={locked} onClick={() => prepare('SAVE_DRAFT')}>Salva bozza privata</button>
      <button className={button} disabled={locked || !current || current.details.url !== details.url || current.details.clientId !== details.clientId}
        onClick={() => prepare('ACTIVATE')}>Attiva per le persone scelte</button>
      {current && <button className={button} disabled={locked} onClick={() => prepare('DISABLE')}>Disabilita il riferimento CRM</button>}
    </div>}
    {proposal && !done && <section className="space-y-3 rounded-xl border p-4" aria-label="Riepilogo Fascicolo Drive">
      <h2 className="font-bold">Conferma {proposal.command.operation === 'ACTIVATE' ? 'attivazione' : proposal.command.operation === 'SAVE_DRAFT' ? 'bozza privata' : 'disabilitazione'}</h2>
      <p>{proposal.preview.clientName} · {proposal.preview.title}</p><p className="break-all">{proposal.preview.url}</p>
      <ul>{proposal.preview.people.map(p => <li key={p.id}>{p.name} · {p.email}</li>)}</ul>
      <p>Scadenza: {proposal.preview.expiresAt ?? 'nessuna'}. Nessun accesso aggiuntivo a clienti, documenti, video o gestione.
        {proposal.command.operation !== 'ACTIVATE' && ' La cartella non sarà visibile ai destinatari nel CRM.'}</p>
      <p>La disabilitazione CRM non cambia i permessi Google e non ritira link già copiati.</p>
      <label className="flex gap-2"><input type="checkbox" checked={consent} disabled={busy || uncertain} onChange={e => setConsent(e.target.checked)}/>Confermo il riepilogo esatto</label>
      <button className={button} disabled={busy || !consent || uncertain} onClick={() => execute()}>Conferma operazione</button>
      {uncertain ? <button className={button} disabled={busy} onClick={() => execute(true)}>Verifica esito</button>
        : <button className={button} disabled={busy} onClick={() => { setProposal(null); setConsent(false); }}>Torna alle scelte</button>}
    </section>}
    {stepUp && <InlinePrivilegedConfirmation/>}
    {message && <p role="status">{message}</p>}
    {done && proposal && <a className="font-bold underline" href={'/drive-folders/manage/' + proposal.command.folderId}>Riapri la scheda salvata</a>}
  </section>;
}
