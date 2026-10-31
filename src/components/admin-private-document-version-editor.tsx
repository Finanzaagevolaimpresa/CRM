'use client';
import { useRef, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import type { readAdminPrivateVersions } from '@/lib/admin-private-document-versions';
import { saveAdminPrivateVersionAction, reconcileAdminPrivateVersionAction, type VersionResult } from '@/lib/admin-private-document-version-actions';
import { documentUploadExtensions, validateUploadSelection } from '@/lib/document-upload-contract';
import { canPreviewSelectedDocument } from '@/lib/selected-document-formats';
import { InlinePrivilegedConfirmation } from './inline-privileged-confirmation';
type Data = Awaited<ReturnType<typeof readAdminPrivateVersions>>;
const subscribe = () => () => {}, hydrated = () => true, server = () => false;
export function AdminPrivateDocumentVersionEditor({ data, commandId: initialCommandId, recovering }: { data: Data; commandId: string; recovering: boolean }) {
  const ready = useSyncExternalStore(subscribe, hydrated, server), sending = useRef(false);
  const [commandId] = useState(initialCommandId), [expectedVersion] = useState(data.expectedVersion);
  const [file, setFile] = useState<File | null>(null), [restoreVersionId, setRestore] = useState(''), [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false), [closeConfirmed, setCloseConfirmed] = useState(false), [busy, setBusy] = useState(false);
  const [result, setResult] = useState<VersionResult | null>(recovering ? { ok: false, uncertain: true, message: 'Verifica il tentativo conservato prima di proseguire.' } : null);
  const frozen = !ready || !data.canWrite || busy || Boolean(result?.uncertain || result?.ok || result?.closed), path = '/admin/private-documents/' + encodeURIComponent(data.id) + '/versions';
  function remember(value: boolean) { const url = new URL(window.location.href); if (value) url.searchParams.set('decision', commandId); else url.searchParams.delete('decision'); window.history.replaceState(window.history.state, '', url); }
  async function save() {
    if (sending.current || frozen || !confirmed) return;
    if (!restoreVersionId && (!file || validateUploadSelection([file]))) { setResult({ ok: false, message: file ? validateUploadSelection([file])! : 'Seleziona un file o una versione precedente.' }); return; }
    sending.current = true; setBusy(true); remember(true);
    try {
      const form = new FormData(); for (const [key, value] of Object.entries({ id: data.id, commandId, expectedVersion, restoreVersionId, reason, confirmed: 'true' })) form.set(key, value);
      if (file && !restoreVersionId) form.set('file', file);
      const next = await saveAdminPrivateVersionAction(form); setResult(next); if (!next.ok && !next.uncertain) remember(false);
    } catch { setResult({ ok: false, uncertain: true, message: 'Risposta interrotta. Verifica il tentativo prima di caricare nuovamente.' }); }
    finally { sending.current = false; setBusy(false); }
  }
  async function reconcile(close = false) {
    if (sending.current || !ready) return; sending.current = true; setBusy(true);
    try { setResult(await reconcileAdminPrivateVersionAction({ id: data.id, commandId, close })); }
    catch { setResult({ ok: false, uncertain: true, message: 'Verifica interrotta. Conserva il riferimento.' }); }
    finally { sending.current = false; setBusy(false); }
  }
  return <div className="space-y-5" data-interactive-ready={ready}>
    <nav className="flex gap-4 flex-wrap"><Link className="underline" href={'/clients/' + data.clientId + '/acquired-documents'}>Torna ai documenti acquisiti</Link>
      <Link className="underline" href={'/admin/private-documents/' + data.id}>Metadati e storico</Link>
      <Link className="underline" href={'/clients/' + data.clientId + '/sharing'}>Scegli persone e versioni da mostrare</Link></nav>
    <p>Ogni caricamento crea una versione privata distinta. La fonte originale, le firme e le prove precedenti restano conservate. Anche il ripristino dei byte precedenti crea una nuova versione. Le selezioni precedenti vengono invalidate; nessuna persona riceve automaticamente la nuova versione.</p>
    {!data.canWrite && <p>Il profilo corrente consente la consultazione delle versioni. Per registrarne una nuova serve il permesso Caricare documenti.</p>}
    <form className="space-y-4" onSubmit={e => { e.preventDefault(); void save(); }}><fieldset disabled={frozen} className="space-y-4">
      <label className="block font-semibold">Nuovo file · massimo 25 MB<input type="file" accept={documentUploadExtensions.join(',')} className="block w-full border rounded-xl p-3"
        onChange={e => { setFile(e.target.files?.[0] ?? null); setRestore(''); setConfirmed(false); }}/></label>
      <label className="block font-semibold">Oppure riprendi una versione precedente<select className="block w-full border rounded-xl p-3" value={restoreVersionId}
        onChange={e => { setRestore(e.target.value); setConfirmed(false); }}><option value="">Usa il nuovo file scelto</option>
        {data.versions.map(v => <option key={v.versionId} value={v.versionId}>Versione {v.version} · {v.fileName}</option>)}</select></label>
      <p>Scelta: {restoreVersionId ? 'ripristino della versione ' + data.versions.find(v => v.versionId === restoreVersionId)?.version : file ? file.name + ' · ' + file.size + ' byte' : 'nessun file'}</p>
      <label className="block font-semibold">Motivazione<textarea required minLength={3} maxLength={2000} className="block w-full border rounded-xl p-3" value={reason} onChange={e => setReason(e.target.value)}/></label>
      <label className="block"><input type="checkbox" required checked={confirmed} onChange={e => setConfirmed(e.target.checked)}/> Confermo la nuova versione, la conservazione delle precedenti e l’invalidazione delle vecchie selezioni.</label>
      <button disabled={!confirmed || !file && !restoreVersionId} className="rounded-xl bg-blue-900 text-white p-3 font-bold">Registra nuova versione privata</button>
    </fieldset></form>
    {result && <p role="status">{result.message}</p>}{result?.stepUp && <InlinePrivilegedConfirmation/>}
    {result?.uncertain && <section className="border rounded-xl p-4 space-y-3"><p className="break-all">Riferimento: {commandId}</p>
      <button disabled={busy} className="block underline" onClick={() => void reconcile()}>Verifica esito registrato</button>
      <label><input type="checkbox" checked={closeConfirmed} onChange={e => setCloseConfirmed(e.target.checked)}/> Chiudi il tentativo soltanto se non ha prodotto una versione.</label>
      <button disabled={busy || !closeConfirmed} className="block underline" onClick={() => void reconcile(true)}>Riconcilia e chiudi il tentativo</button></section>}
    {(result?.ok || result?.closed) && <Link className="block underline font-bold" href={path}>Riapri e verifica le versioni</Link>}
    <section className="space-y-3"><h2 className="font-bold">Versioni conservate</h2>{[...data.versions].reverse().map(v => <article key={v.versionId} className="border rounded-xl p-4 space-y-2">
      <p className="font-bold">Versione {v.version} · {v.fileName}</p><p>{new Date(v.at).toLocaleString('it-IT')} · {v.actor?.name} · {v.actor?.email}</p><p>{v.reason}</p>
      <p className="break-all">SHA256 {v.sha256} · {v.sizeBytes} byte</p>
      <div className="flex flex-wrap gap-4">{canPreviewSelectedDocument(v) && <a className="underline" href={'/acquired-documents/' + data.id + '?version=' + v.versionId} target="_blank" rel="noopener noreferrer">Apri versione {v.version}</a>}
        <a className="underline" href={'/acquired-documents/' + data.id + '?version=' + v.versionId + '&download=1'}>Scarica versione {v.version}</a></div>
    </article>)}</section>
  </div>;
}
