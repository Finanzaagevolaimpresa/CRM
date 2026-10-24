'use client';
import { startTransition, useActionState, useState } from 'react';
import type { readOwnTechnicalUploads } from '@/lib/technical-upload-service';
import type { TechnicalUploadAction, TechnicalUploadState } from '@/lib/technical-upload-ui-state';
import { technicalUploadPath } from '@/lib/technical-upload-display';
import { TechnicalUploadRecovery, technicalUploadInitial, useUploadReady, uploadButton, uploadControl, rememberUpload } from './technical-upload-recovery';

function Confirm({ preview, file, action, recovery, edit }: { preview: NonNullable<TechnicalUploadState['uploadPreview']>;
  file: File; action: TechnicalUploadAction; recovery: TechnicalUploadAction; edit: () => void }) {
  const ready = useUploadReady(), [state, submit, pending] = useActionState(action, technicalUploadInitial), [sent, setSent] = useState(false);
  const locked = !ready || sent || pending, s = preview.summary;
  return <section className="min-w-0 space-y-3 rounded-xl border border-blue-400 bg-blue-50 p-4" aria-label="Riepilogo deposito privato">
    <h2 className="text-xl font-bold">Conferma il deposito privato</h2><p className="break-words">{s.title} · {s.fileName} · {s.sizeBytes} byte</p>
    <p className="break-words">Scopo: {s.purpose}</p><p className="break-all text-sm">Impronta del file: {s.contentSha256}</p>
    <p>Il file sarà disponibile nell’incarico a te e all’Admin personale autorizzato, finché i permessi restano validi. Nessun invio o condivisione con altri account.</p>
    <button type="button" className="font-semibold underline" disabled={locked} onClick={edit}>Rivedi il file</button>
    <form action={submit} className="space-y-3" onSubmit={event => { event.preventDefault(); if (locked) return;
      const form = new FormData(event.currentTarget); form.set('file', file); rememberUpload('uploadDecision', preview.command.commandId);
      setSent(true); startTransition(() => submit(form)); }}>
      <input type="hidden" name="target" value={JSON.stringify(preview.target)} /><input type="hidden" name="command" value={JSON.stringify(preview.command)} />
      <input type="hidden" name="token" value={preview.token} />
      <label className="flex items-start gap-2"><input type="checkbox" name="confirmed" required disabled={locked} />Confermo questo file e il deposito privato riepilogato.</label>
      <button className={uploadButton} disabled={locked}>Conferma deposito</button></form><p role="status">{state.message}</p>
    {state.recorded && <a className="font-semibold underline" href={technicalUploadPath(preview.target)}>Ricarica i miei depositi</a>}
    {state.uncertain && <TechnicalUploadRecovery target={preview.target} commandId={preview.command.commandId} action={recovery} returnPath={technicalUploadPath(preview.target)} />}
  </section>;
}
export function TechnicalUploadForm({ data, initialCommandId, previewAction, confirmAction, receiptAction }: {
  data: Awaited<ReturnType<typeof readOwnTechnicalUploads>>; initialCommandId: string;
  previewAction: TechnicalUploadAction; confirmAction: TechnicalUploadAction; receiptAction: TechnicalUploadAction }) {
  const ready = useUploadReady(), [state, submit, pending] = useActionState(previewAction, technicalUploadInitial);
  const [commandId, setCommand] = useState(initialCommandId), [title, setTitle] = useState(''), [file, setFile] = useState<File | null>(null);
  const preview = state.uploadPreview?.command.commandId === commandId ? state.uploadPreview : null, locked = !ready || pending || !!preview;
  const changed = () => setCommand(crypto.randomUUID());
  const command = { commandId, assignmentId: data.assignmentId, assignmentRevision: data.assignmentRevision,
    expectedContextSha256: data.contextSha256, title, action: 'deposit_private_document' };
  return <section className="min-w-0 space-y-4" data-upload-ready={ready ? 'true' : 'false'}>
    <form action={submit} onSubmit={event => { event.preventDefault(); const form = new FormData(event.currentTarget); if (file) form.set('file', file); startTransition(() => submit(form)); }} className="space-y-3">
      <input type="hidden" name="target" value={JSON.stringify(data.target)} /><input type="hidden" name="command" value={JSON.stringify(command)} />
      <label className="block font-semibold">Titolo del documento<input className={uploadControl} value={title} maxLength={200} required disabled={locked}
        onChange={event => { setTitle(event.target.value); changed(); }} /></label>
      <label className="block font-semibold">File da depositare<input className={uploadControl} type="file" accept={data.profile.formats.join(',')} required disabled={locked}
        onChange={event => { setFile(event.target.files?.[0] ?? null); changed(); }} /></label>
      <button className={uploadButton} disabled={locked || !file || !title.trim() || data.consumedFiles >= data.profile.maxFilesPerRevision
        || (file?.size ?? 0) > data.profile.maxFileBytes || data.consumedBytes + (file?.size ?? 0) > data.profile.maxBytesPerRevision}>Prepara riepilogo del deposito</button>
      <p role="status">{state.message}</p></form>
    {preview && file && <Confirm key={preview.token} preview={preview} file={file} action={confirmAction} recovery={receiptAction} edit={changed} />}
  </section>;
}
