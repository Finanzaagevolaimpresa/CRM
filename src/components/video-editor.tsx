'use client';

import { useRef, useState, useSyncExternalStore } from 'react';
import { communicationRecipientGroups } from '@/lib/communication-recipient-groups';
import type { VideoCommand, VideoDetails } from '@/lib/video-input';
import { InlinePrivilegedConfirmation } from './inline-privileged-confirmation';

export type VideoEditorPreview = { digest: string; title: string; fileName: string;
  people: { id: string; name: string; email: string; role: string }[]; downloadAllowed: boolean; expiresAt: string | null };
type Reply<T> = { ok: true; value: T } | { ok: false; message: string; stepUpRequired?: boolean; closed?: boolean };
type EditorActions = {
  files: (query: string, offset: number) => Promise<Reply<{ files: VideoFile[]; nextOffset: number | null }>>;
  preview: (command: VideoCommand) => Promise<Reply<VideoEditorPreview>>;
  confirm: (command: VideoCommand, digest: string) => Promise<Reply<{ confirmed: boolean }>>;
  verify: (command: VideoCommand, digest: string) => Promise<Reply<{ confirmed: boolean; closed: boolean }>>;
};
type VideoFile = { id: string; fileName: string; sizeBytes: number };
type Setup = { id: string; version: number; state: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED'; details: VideoDetails;
  fileName: string; files: VideoFile[]; people: { id: string; name: string; email: string; role: string }[] };
const subscribe = () => () => {};
const ready = () => true, server = () => false;
const field = 'block w-full min-w-0 rounded-xl border border-slate-300 bg-white px-3 py-2 font-normal';
const primary = 'rounded-xl bg-fai-green px-4 py-2 font-bold text-white disabled:opacity-50';
const secondary = 'rounded-xl border border-slate-300 px-4 py-2 font-bold disabled:opacity-50';
const toggle = <T extends string>(items: T[], item: T) => items.includes(item) ? items.filter(value => value !== item) : [...items, item];
const localDate = (iso: string | null) => {
  if (!iso) return '';
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

export function VideoEditor({ setup, actions }: { setup: Setup; actions: EditorActions }) {
  const interactive = useSyncExternalStore(subscribe, ready, server);
  const pending = useRef(false);
  const [details, setDetails] = useState(setup.details);
  const [files, setFiles] = useState(setup.files), [fileQuery, setFileQuery] = useState('');
  const [nextFileOffset, setNextFileOffset] = useState<number | null>(null);
  const [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [done, setDone] = useState(false);
  const [message, setMessage] = useState(''), [consent, setConsent] = useState(false);
  const [needsStepUp, setNeedsStepUp] = useState(false);
  const [proposal, setProposal] = useState<{ command: VideoCommand; preview: VideoEditorPreview } | null>(null);
  const locked = busy || uncertain || done || proposal !== null;
  const availablePeople = new Set(setup.people.map(person => person.id));
  const unavailablePeople = details.selection.people.filter(id => !availablePeople.has(id));
  const replacingFile = details.fileId !== setup.details.fileId;
  async function findFiles(offset = 0) {
    if (pending.current || locked || !interactive) return;
    pending.current = true; setBusy(true);
    try {
      const result = await actions.files(fileQuery, offset);
      if (result.ok) {
        setFiles(current => [...new Map([...current.filter(file => file.id === details.fileId || file.id === setup.details.fileId),
          ...result.value.files].map(file => [file.id, file])).values()]);
        setNextFileOffset(result.value.nextOffset);
        setMessage(result.value.files.length ? 'File disponibili aggiornati. Seleziona il contenuto da usare.' : 'Nessun file corrisponde alla ricerca.');
      } else setMessage(result.message);
    } catch { setMessage('Ricerca file non disponibile. Le modifiche sono conservate.'); }
    finally { pending.current = false; setBusy(false); }
  }
  async function prepare(operation: VideoCommand['operation']) {
    if (pending.current || locked || !interactive) return;
    pending.current = true;
    setBusy(true); setMessage(''); setConsent(false);
    const base = { commandId: crypto.randomUUID(), videoId: setup.id, expectedVersion: setup.version };
    const command: VideoCommand = operation === 'PUBLISH' || operation === 'SAVE_DRAFT'
      ? { ...base, operation, details } : { ...base, operation };
    try {
      const result = await actions.preview(command);
      if (result.ok) setProposal({ command, preview: result.value }); else setMessage(result.message);
    } catch { setMessage('Anteprima non disponibile. Nessuna modifica registrata.'); }
    finally { pending.current = false; setBusy(false); }
  }
  async function confirm() {
    if (pending.current || !proposal || !consent || busy || done || uncertain) return;
    pending.current = true;
    setBusy(true);
    try {
      const result = await actions.confirm(proposal.command, proposal.preview.digest);
      if (result.ok && result.value.confirmed) { setDone(true); setMessage('Operazione registrata. Riapri la libreria per lo stato corrente.'); }
      else if (!result.ok && result.closed) { setProposal(null); setConsent(false); setNeedsStepUp(Boolean(result.stepUpRequired)); setMessage(result.message); }
      else { setUncertain(true); setMessage(result.ok ? 'Esito da verificare.' : result.message); }
    } catch { setUncertain(true); setMessage('Risposta non ricevuta. Verifica l’esito prima di un altro salvataggio.'); }
    finally { pending.current = false; setBusy(false); }
  }
  async function verify() {
    if (pending.current || !proposal || busy) return;
    pending.current = true;
    setBusy(true);
    try {
      const result = await actions.verify(proposal.command, proposal.preview.digest);
      if (result.ok && result.value.confirmed) { setDone(true); setUncertain(false); setMessage('Operazione già registrata. Non occorre ripeterla.'); }
      else if (result.ok && result.value.closed) { setUncertain(false); setProposal(null); setConsent(false);
        setMessage('Tentativo chiuso senza modifica. Le scelte sono conservate: puoi preparare un nuovo riepilogo.'); }
      else setMessage(result.ok ? 'Esito ancora da riconciliare. Mantieni le scelte e riprova la verifica.' : result.message);
    } catch { setMessage('Verifica non disponibile. Riprova soltanto la verifica.'); }
    finally { pending.current = false; setBusy(false); }
  }
  const operationLabel = { SAVE_DRAFT: 'Salva bozza', PUBLISH: 'Pubblica per le persone scelte', ARCHIVE: 'Archivia e revoca la visione', RESTORE_DRAFT: 'Ripristina in bozza' };
  return <section className="crm-space-y-5 min-w-0" data-testid="video-editor" data-interactive-ready={interactive}>
    <p className="break-words text-sm text-slate-600">File: <strong>{setup.fileName}</strong>. Stato: {setup.state === 'PUBLISHED' ? 'pubblicato' : setup.state === 'ARCHIVED' ? 'archiviato' : 'bozza'}.</p>
    <fieldset disabled={locked || setup.state === 'ARCHIVED'} className="crm-space-y-4 min-w-0">
      <label className="block font-bold">File del video<select className={field} value={details.fileId} onChange={e => setDetails({ ...details, fileId: e.target.value })}>
        {files.map(file => <option key={file.id} value={file.id}>{file.fileName} · {(file.sizeBytes / 1024 / 1024).toFixed(2)} MiB · {file.id.slice(0, 8)}</option>)}
      </select></label>
      <div className="flex flex-wrap items-end gap-2">
        <label className="block font-bold">Cerca un file già caricato<input className={field} maxLength={160} value={fileQuery} onChange={e => { setFileQuery(e.target.value); setNextFileOffset(null); }}/></label>
        <button type="button" className={secondary} disabled={!interactive} onClick={() => findFiles()}>Cerca file</button>
        {nextFileOffset !== null && <button type="button" className={secondary} onClick={() => findFiles(nextFileOffset)}>Altri file</button>}
      </div>
      <p className="text-sm text-slate-600">Per sostituire il contenuto, carica prima il nuovo file nella gestione video, poi selezionalo qui. Il salvataggio riporta questa scheda in bozza privata e conserva il file precedente nello storico.</p>
      {replacingFile && <p className="rounded-xl bg-amber-50 p-3">La sostituzione richiede prima il salvataggio in bozza. Per rendere visibile il nuovo file dovrai riaprire la scheda e confermare una nuova pubblicazione.</p>}
      <label className="block font-bold">Titolo<input className={field} maxLength={160} required value={details.title} onChange={e => setDetails({ ...details, title: e.target.value })}/></label>
      <label className="block font-bold">Descrizione<textarea className={field} rows={4} maxLength={3000} value={details.description} onChange={e => setDetails({ ...details, description: e.target.value })}/></label>
      <div className="grid min-w-0 gap-4 sm:grid-cols-2">
        <label className="block font-bold">Categoria<input className={field} maxLength={80} value={details.category} onChange={e => setDetails({ ...details, category: e.target.value })}/></label>
        <label className="block font-bold">Ordine<input className={field} type="number" min={0} max={10000} value={details.position} onChange={e => setDetails({ ...details, position: Number(e.target.value) })}/></label>
      </div>
      <fieldset className="crm-space-y-2"><legend className="font-bold">Aree</legend>
        <p className="text-sm text-slate-600">L’anteprima elenca le persone attuali. I nuovi membri dell’area richiedono una nuova pubblicazione.</p>
        <div className="grid gap-2 sm:grid-cols-2">{Object.entries(communicationRecipientGroups).map(([id, area]) => <label key={id} className="flex min-w-0 items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1 shrink-0" checked={details.selection.areas.includes(id as keyof typeof communicationRecipientGroups)} onChange={() => setDetails({ ...details, selection: { ...details.selection, areas: toggle(details.selection.areas, id as keyof typeof communicationRecipientGroups) } })}/><span>{area.label}</span>
        </label>)}</div>
      </fieldset>
      <fieldset className="crm-space-y-2"><legend className="font-bold">Persone</legend>
        {unavailablePeople.length > 0 && <div className="crm-space-y-2 rounded-xl border border-amber-300 bg-amber-50 p-3" aria-label="Destinatari non disponibili">
          <p className="text-sm">Destinatari selezionati non più disponibili: {unavailablePeople.length}. Rimuovili prima di preparare una nuova bozza o pubblicazione.</p>
          <button type="button" className={secondary} disabled={!interactive} onClick={() => {
            if (pending.current || locked || !interactive || setup.state === 'ARCHIVED') return;
            setDetails(current => ({ ...current, selection: { ...current.selection,
              people: current.selection.people.filter(id => availablePeople.has(id)) } }));
          }}>Rimuovi destinatari non disponibili</button>
        </div>}
        <div className="grid max-h-64 gap-2 overflow-y-auto sm:grid-cols-2">
        {setup.people.map(person => <label key={person.id} className="flex min-w-0 items-start gap-2 text-sm"><input type="checkbox" className="mt-1 shrink-0" checked={details.selection.people.includes(person.id)} onChange={() => setDetails({ ...details, selection: { ...details.selection, people: toggle(details.selection.people, person.id) } })}/>
          <span className="min-w-0 break-words">{person.name} · {person.email} <span className="text-slate-500">({person.role})</span></span></label>)}
      </div></fieldset>
      <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={details.downloadAllowed} onChange={e => setDetails({ ...details, downloadAllowed: e.target.checked })}/><span>Consenti anche il download alle persone ammesse</span></label>
      <label className="block font-bold">Scadenza facoltativa<input className={field} type="datetime-local" value={localDate(details.expiresAt)}
        onChange={e => setDetails({ ...details, expiresAt: e.target.value ? new Date(e.target.value).toISOString() : null })}/></label>
    </fieldset>
    {!proposal && <div className="flex flex-wrap gap-3">
      {setup.state !== 'ARCHIVED' ? <><button className={primary} disabled={locked || !interactive || replacingFile} onClick={() => prepare('PUBLISH')}>Prepara pubblicazione</button><button className={secondary} disabled={locked || !interactive} onClick={() => prepare('SAVE_DRAFT')}>Prepara bozza</button>
        {setup.version > 0 && <button className={secondary} disabled={locked || !interactive} onClick={() => prepare('ARCHIVE')}>Archivia</button>}</> : <button className={primary} disabled={locked || !interactive} onClick={() => prepare('RESTORE_DRAFT')}>Ripristina in bozza</button>}
    </div>}
    {proposal && <div className="crm-space-y-3 rounded-2xl border border-fai-green bg-green-50 p-4" aria-label="Riepilogo video">
      <h2 className="break-words text-lg font-bold">{operationLabel[proposal.command.operation]}: {proposal.preview.title}</h2>
      <p className="break-words text-sm">File: {proposal.preview.fileName}</p>
      {proposal.command.operation === 'PUBLISH' ? <><p>Visione consentita soltanto a:</p><ul className="list-inside list-disc break-words">{proposal.preview.people.map(person => <li key={person.id}>{person.name} · {person.email} ({person.role})</li>)}</ul>
        <p>Download: {proposal.preview.downloadAllowed ? 'consentito' : 'non abilitato'}.</p>
        <p>{proposal.preview.expiresAt ? 'Visibile fino al ' + new Date(proposal.preview.expiresAt).toLocaleString('it-IT') : 'Senza scadenza, revocabile dalla gestione video.'}</p></> : <p>Il video rimane privato e non sarà disponibile ai destinatari. File e storico vengono conservati.</p>}
      <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={consent} disabled={busy || uncertain || done} onChange={e => setConsent(e.target.checked)}/><span>Confermo questa operazione e le persone indicate.</span></label>
      <p className="text-sm">Il riepilogo dura 5 minuti. La conferma Admin dura 30 minuti e, se scaduta, può essere rinnovata qui conservando le scelte.</p>
      <div className="flex flex-wrap gap-3"><button className={primary} disabled={!consent || busy || uncertain || done} onClick={confirm}>Conferma</button>
        {!uncertain && !done && <button className={secondary} disabled={busy} onClick={() => { setProposal(null); setConsent(false); }}>Torna alle modifiche</button>}
        {uncertain && <button className={secondary} disabled={busy} onClick={verify}>Verifica esito</button>}
      </div>
    </div>}
    {needsStepUp && <InlinePrivilegedConfirmation />}
    {done && <a className="font-bold underline" href={'/videos/manage/' + setup.id}>Riapri la scheda corrente</a>}
    {message && <p role="status" className="break-words rounded-xl bg-slate-100 p-3">{message}</p>}
  </section>;
}
