'use client';
import { useRef, useState, useSyncExternalStore } from 'react';
import { uploadDocumentVersionAction, checkDocumentVersionOutcome } from '@/lib/document-version-actions';
import { documentVersionCommandSchema, type DocumentVersionResult } from '@/lib/document-version-contract';
import { validateUploadSelection } from '@/lib/document-upload-contract';
const changeEvent = 'crm-document-version-pending';
const subscribe = (callback: () => void) => { window.addEventListener(changeEvent, callback); return () => window.removeEventListener(changeEvent, callback); };
const readySubscribe = () => () => {}, clientReady = () => true, serverReady = () => false;

export function DocumentVersionUpload({ documentId, expectedHash, fileName, mimeType }: {
  documentId: string; expectedHash: string; fileName: string; mimeType: string;
}) {
  const key = `crm-document-version:${documentId}`;
  const ready = useSyncExternalStore(readySubscribe, clientReady, serverReady);
  const pending = useSyncExternalStore(subscribe, () => {
    try { return window.sessionStorage.getItem(key) ?? ''; } catch { return 'UNAVAILABLE'; }
  }, () => '');
  const busyRef = useRef(false), [busy, setBusy] = useState(false), [result, setResult] = useState<DocumentVersionResult | null>(null);
  function store(value: string) { window.sessionStorage.setItem(key, value); window.dispatchEvent(new Event(changeEvent)); }
  async function submit(form: FormData) {
    if (!ready || busyRef.current || pending || result?.ok) return;
    const file = form.get('file');
    if (!(file instanceof File) || validateUploadSelection([file]) || form.get('confirm') !== 'on') {
      setResult({ ok: false, code: 'INVALID', message: 'Scegli un file valido e conferma il riepilogo.' }); return;
    }
    const command = { documentId, expectedHash, requestId: crypto.randomUUID(), confirmed: true as const };
    try { store(JSON.stringify(command)); } catch {
      setResult({ ok: false, code: 'INVALID', message: 'La memoria della sessione non è disponibile: nessun file è stato inviato.' }); return;
    }
    busyRef.current = true; setBusy(true); setResult(null); form.set('command', JSON.stringify(command));
    try {
      const value = await uploadDocumentVersionAction(form); setResult(value);
      if (value.ok || ['DENIED', 'STALE', 'INVALID'].includes(value.code)) store('');
    } catch { setResult({ ok: false, code: 'UNKNOWN', message: 'Esito non confermato. Verifica la ricevuta prima di ripetere.' }); }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function reconcile() {
    if (busyRef.current) return;
    let command; try { command = documentVersionCommandSchema.parse(JSON.parse(pending)); } catch {
      setResult({ ok: false, code: 'UNKNOWN', message: 'La richiesta conservata non è leggibile. Non ripetere il caricamento; occorre riconciliare l’esito.' }); return;
    }
    busyRef.current = true; setBusy(true);
    try {
      const value = await checkDocumentVersionOutcome({ documentId, requestId: command.requestId }); setResult(value);
      // A denial during reconciliation is not evidence that the original write failed.
      if (value.ok) store('');
    } catch { setResult({ ok: false, code: 'UNKNOWN', message: 'Verifica temporaneamente non disponibile. Non ripetere il caricamento.' }); }
    finally { busyRef.current = false; setBusy(false); }
  }
  return <section aria-label="Nuova versione documentale" data-document-version-ready={ready} className="space-y-3">
    <p>Il nuovo contenuto manterrà il nome <strong>{fileName}</strong>, il formato {mimeType}, la categoria e i collegamenti attuali. Le versioni precedenti restano nello storico.</p>
    <p>Le condivisioni selettive richiedono una nuova verifica dell’Admin. La nuova versione non viene concessa automaticamente. I documenti vincolati a contratti, pagamenti o acquisizioni seguono il rispettivo percorso.</p>
    <form action={submit} className="grid gap-3">
      <fieldset disabled={!ready || busy || !!pending || !!result?.ok} className="grid gap-3">
        <label>File della nuova versione<input name="file" type="file" required accept={`.${fileName.split('.').at(-1)}`} className="block max-w-full rounded-xl border p-3" /></label>
        <label className="flex gap-2"><input type="checkbox" name="confirm" required />Confermo il nuovo contenuto e la conservazione delle versioni precedenti.</label>
        <button className="rounded-xl bg-fai-blue px-4 py-3 font-bold text-white disabled:opacity-50" type="submit">Salva nuova versione</button>
      </fieldset>
    </form>
    {pending && <div role="status"><p>È presente una richiesta da riconciliare. Nessun caricamento sarà ripetuto automaticamente.</p>
      <button type="button" onClick={reconcile} disabled={!ready || busy} className="rounded-xl border p-3">Verifica esito caricamento</button></div>}
    {result && <p role="status">{result.ok ? `Versione ${result.version} registrata${result.replay ? ': ricevuta verificata' : ''}.` : result.message}</p>}
    {result?.ok && <a className="font-bold underline" href={`/documents/${encodeURIComponent(documentId)}/versions`}>Riapri lo storico aggiornato</a>}
  </section>;
}
