'use client';

import { useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { InteractiveReadyMarker } from '@/components/interactive-ready-marker';
import { uploadDocumentForBatch } from '@/lib/form-actions';
import { documentUploadExtensions, uploadSelection, validateUploadSelection, type UploadResult } from '@/lib/document-upload-contract';

export function DocumentBatchUpload({ children, className, submitLabel = 'Carica documenti', disabled = false, buttonClassName = '' }: {
  children: ReactNode; className?: string; submitLabel?: string; disabled?: boolean; buttonClassName?: string;
}) {
  const router = useRouter();
  const busyRef = useRef(false);
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<Record<number, UploadResult>>({});
  async function submit(form: FormData) {
    if (busyRef.current || attempted) return;
    const invalid = validateUploadSelection(files);
    setError(invalid);
    if (invalid) return;
    busyRef.current = true;
    setBusy(true);
    setAttempted(true);
    try { await uploadSelection(files, form, uploadDocumentForBatch, ({ index, result }) => setResults(previous => ({ ...previous, [index]: result }))); }
    finally { busyRef.current = false; setBusy(false); router.refresh(); }
  }
  return <form action={submit} className={className}>
    <InteractiveReadyMarker />
    <fieldset disabled={busy} className="contents">
      {children}
      <label className="grid gap-1 text-sm font-bold">Documenti da caricare
        <input type="file" name="file" multiple required accept={documentUploadExtensions.join(',')} className="rounded-xl border p-3" onChange={event => {
          setFiles(Array.from(event.target.files ?? [])); setResults({}); setAttempted(false); setError(null);
        }} />
      </label>
      <input className="rounded-xl border p-3" name="title" maxLength={160} placeholder="Titolo facoltativo; altrimenti nome del file" aria-label="Titolo documenti" />
      <p className="text-sm text-slate-600 md:col-span-full">Fino a 20 file per operazione, 25 MB ciascuno. Gli ZIP restano archivi senza estrazione e sono riservati ad Admin, Amministrazione e Direzione. Categoria e collegamenti si applicano a tutti i file selezionati.</p>
      {error ? <p role="alert" className="text-red-700 md:col-span-full">{error}</p> : null}
      <ul aria-live="polite" aria-label="Esito caricamenti" className="text-sm md:col-span-full">{files.map((file, index) => <li key={index}>
        {file.name}: {results[index] ? (results[index].ok ? 'Caricato' : results[index].message) : busy ? 'In attesa' : attempted ? 'Non inviato' : 'Pronto'}
      </li>)}</ul>
      {attempted && !busy ? <p className="text-sm md:col-span-full">Operazione terminata. Per un nuovo caricamento seleziona altri file; quelli già caricati restano salvati.</p> : null}
      <button type="submit" disabled={disabled || busy || attempted || !files.length} className={`rounded-xl bg-fai-blue px-4 py-3 font-bold text-white disabled:opacity-50 ${buttonClassName}`}>{busy ? 'Caricamento in corso…' : submitLabel}</button>
    </fieldset>
  </form>;
}
