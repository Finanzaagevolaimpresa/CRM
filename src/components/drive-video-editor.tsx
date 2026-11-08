'use client';
import { useRef, useState, useSyncExternalStore } from 'react';
import { driveVideoAccount, type DriveVideoCommand, type DriveVideoDetails, type DriveVideoSnapshot } from '@/lib/drive-video-contract';
import { previewDriveVideoAction, confirmDriveVideoAction, verifyDriveVideoAction } from '@/lib/drive-video-actions';
import { InlinePrivilegedConfirmation } from './inline-privileged-confirmation';
import { DriveVideoPlayer } from './drive-video-player';

type Person = { id: string; name: string; email: string; role: string };
type Preview = Extract<Awaited<ReturnType<typeof previewDriveVideoAction>>, { ok: true }>['value'];
const field = 'block w-full rounded-xl border p-3 font-normal';
const button = 'rounded-xl border p-3 font-bold disabled:opacity-50';
const subscribe = () => () => {}, clientReady = () => true, serverReady = () => false;
export function DriveVideoEditor({ id, current, people }: { id: string; current: DriveVideoSnapshot | null; people: Person[] }) {
  const interactive = useSyncExternalStore(subscribe, clientReady, serverReady);
  const [details, setDetails] = useState<DriveVideoDetails>(current?.details ?? { url: '', title: '', description: '',
    category: '', position: 0, selection: { people: [], areas: [] }, downloadAllowed: false, expiresAt: null,
    sourceAccount: driveVideoAccount, accountConfirmed: true });
  const [accountConfirmed, setAccountConfirmed] = useState(Boolean(current));
  const [proposal, setProposal] = useState<{ command: DriveVideoCommand; preview: Preview } | null>(null);
  const [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [done, setDone] = useState(false);
  const [message, setMessage] = useState(''), [stepUp, setStepUp] = useState(false), [consent, setConsent] = useState(false);
  const pending = useRef(false), locked = !interactive || busy || uncertain || done || Boolean(proposal);
  const patch = (value: Partial<DriveVideoDetails>) => setDetails(old => ({ ...old, ...value,
    selection: { ...(value.selection ?? old.selection), technicalContentReviewed: false } }));
  async function prepare(operation: DriveVideoCommand['operation']) {
    if (!interactive || pending.current || locked || !accountConfirmed) return;
    pending.current = true; setBusy(true); setMessage(''); setConsent(false);
    const base = { protocol: 'DRIVE_VIDEO_REFERENCE_V1' as const, commandId: crypto.randomUUID(), videoId: id, expectedVersion: current?.revision ?? 0 };
    const command: DriveVideoCommand = operation === 'SAVE_DRAFT' || operation === 'PUBLISH'
      ? { ...base, operation, details } : { ...base, operation };
    try {
      const result = await previewDriveVideoAction(command);
      if (result.ok) setProposal({ command, preview: result.value }); else setMessage(result.message);
    } catch { setMessage('Anteprima non disponibile. Le scelte sono conservate; nessun salvataggio è stato richiesto.'); }
    finally { pending.current = false; setBusy(false); }
  }
  async function execute(check = false) {
    if (pending.current || !proposal || done || !check && (!consent || uncertain)) return;
    pending.current = true; setBusy(true);
    try {
      const result = check ? await verifyDriveVideoAction(proposal.command, proposal.preview.digest)
        : await confirmDriveVideoAction(proposal.command, proposal.preview.digest);
      if (result.ok && result.value.confirmed) { setDone(true); setUncertain(false); setMessage('Operazione registrata. Riapri la scheda per lo stato persistito.'); }
      else if (result.ok && result.value.closed || !result.ok && 'closed' in result && result.closed) {
        setProposal(null); setConsent(false); setUncertain(false);
        setStepUp(!result.ok && 'stepUpRequired' in result && Boolean(result.stepUpRequired));
        setMessage(result.ok ? 'Tentativo chiuso senza modifica. Puoi preparare un nuovo riepilogo con le scelte conservate.' : result.message);
      } else { setUncertain(true); setMessage(result.ok ? 'Esito da verificare.' : result.message); }
    } catch { setUncertain(true); setMessage('Risposta non ricevuta. Usa Verifica esito: non ripetere il salvataggio.'); }
    finally { pending.current = false; setBusy(false); }
  }
  const unavailable = details.selection.people.filter(id => !people.some(p => p.id === id));
  const date = details.expiresAt ? new Date(details.expiresAt) : null;
  const localDate = date ? new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';
  return <section className="space-y-5 min-w-0" data-testid="drive-video-editor" data-interactive-ready={interactive}>
    <p>Il file resta nel Drive <strong>{driveVideoAccount}</strong>; non viene caricato nel CRM e non usa il limite di 20 MiB.</p>
    <p>Condividi il file su Google Drive con le stesse persone indicate qui, usando accesso limitato.
      Il CRM non modifica le condivisioni Google. Per impedire il download, configura anche i permessi del file su Google.</p>
    <fieldset disabled={locked || current?.state === 'ARCHIVED'} className="space-y-4">
      <label className="block font-bold">Link del video Google Drive<input className={field} type="url" maxLength={2048} value={details.url}
        onChange={e => patch({ url: e.target.value })} placeholder="https://drive.google.com/file/d/…/view"/></label>
      <label className="flex gap-2"><input type="checkbox" checked={accountConfirmed} onChange={e => setAccountConfirmed(e.target.checked)}/>
        Confermo che il file appartiene al Drive assistenza@finanzaagevolaimpresa.it.</label>
      <label className="block font-bold">Titolo<input className={field} maxLength={160} value={details.title} onChange={e => patch({ title: e.target.value })}/></label>
      <label className="block font-bold">Descrizione<textarea className={field} maxLength={3000} value={details.description} onChange={e => patch({ description: e.target.value })}/></label>
      <fieldset className="space-y-2"><legend className="font-bold">Persone autorizzate alla visione nel CRM</legend>
        {people.map(p => <label key={p.id} className="flex gap-2"><input type="checkbox" checked={details.selection.people.includes(p.id)} onChange={() =>
          patch({ selection: { ...details.selection, areas: [], people: details.selection.people.includes(p.id)
            ? details.selection.people.filter(id => id !== p.id) : [...details.selection.people, p.id] } })}/>
          <span>{p.name} · {p.email} · {p.role}</span></label>)}
        {unavailable.length > 0 && <p>Persone non più disponibili: {unavailable.length}. <button type="button" className="underline"
          onClick={() => patch({ selection: { ...details.selection, people: details.selection.people.filter(id => !unavailable.includes(id)) } })}>Rimuovi dalla selezione</button></p>}
      </fieldset>
      <label className="flex gap-2"><input type="checkbox" checked={details.selection.technicalContentReviewed === true}
        onChange={e => setDetails({ ...details, selection: { ...details.selection, technicalContentReviewed: e.target.checked } })}/>
        Ho verificato video, titolo e descrizione: non contengono pagamenti, contratti firmati o note riservate ai tecnici selezionati.</label>
      <label className="block font-bold">Scadenza del riferimento CRM (facoltativa)<input className={field} type="datetime-local" value={localDate}
        onChange={e => patch({ expiresAt: e.target.value ? new Date(e.target.value).toISOString() : null })}/></label>
      <p className="text-sm">La sostituzione del link richiede prima una bozza privata. Il contenuto del file può cambiare su Drive:
        lo storico CRM conserva il riferimento e le scelte, non una copia o una certificazione delle versioni Google.</p>
    </fieldset>
    {!proposal && !done && <div className="flex flex-wrap gap-3">
      {current?.state !== 'ARCHIVED' && <><button className={button} disabled={busy || !accountConfirmed} onClick={() => prepare('SAVE_DRAFT')}>Salva bozza privata</button>
        <button className={button} disabled={busy || !current || !accountConfirmed || current.details.url !== details.url}
          onClick={() => prepare('PUBLISH')}>Pubblica per le persone scelte</button></>}
      {current && <button className={button} disabled={busy} onClick={() => prepare(current.state === 'ARCHIVED' ? 'RESTORE_DRAFT' : 'ARCHIVE')}>
        {current.state === 'ARCHIVED' ? 'Ripristina in bozza' : 'Archivia e revoca il riferimento'}</button>}
    </div>}
    {proposal && !done && <section className="space-y-3 rounded-xl border p-4" aria-label="Riepilogo Google Drive">
      <h2 className="font-bold">Conferma {proposal.command.operation === 'PUBLISH' ? 'pubblicazione' : proposal.command.operation === 'SAVE_DRAFT' ? 'bozza privata' : 'cambio di stato'}</h2>
      <p>{proposal.preview.title}</p><p className="break-all">{proposal.preview.url}</p>
      <ul>{proposal.preview.people.map(p => <li key={p.id}>{p.name} · {p.email}</li>)}</ul>
      <p>Scadenza: {proposal.preview.expiresAt ?? 'nessuna'}. Nessun download o diritto di gestione aggiunto.
        {proposal.command.operation !== 'PUBLISH' && ' Il riferimento non sarà visibile agli spettatori.'}</p>
      <DriveVideoPlayer id={proposal.command.videoId} version={proposal.command.expectedVersion} url={proposal.preview.url} expiresAt={null} preview/>
      <label className="flex gap-2"><input type="checkbox" checked={consent} disabled={busy || uncertain} onChange={e => setConsent(e.target.checked)}/>Confermo il riepilogo esatto</label>
      <button className={button} disabled={busy || !consent || uncertain} onClick={() => execute()}>Conferma operazione</button>
      {uncertain ? <button className={button} disabled={busy} onClick={() => execute(true)}>Verifica esito</button>
        : <button className={button} disabled={busy} onClick={() => { setProposal(null); setConsent(false); }}>Torna alle scelte</button>}
    </section>}
    {stepUp && <InlinePrivilegedConfirmation/>}
    {message && <p role="status">{message}</p>}
    {/* Keep the command receipt through revalidation; an ordinary navigation
        then initializes the editor from the persisted revision, even on this URL. */}
    {done && proposal && <a className="font-bold underline" href={'/videos/manage/drive/' + proposal.command.videoId}>Riapri la scheda salvata</a>}
  </section>;
}
