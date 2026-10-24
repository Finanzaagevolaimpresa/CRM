'use client';
import { startTransition, useActionState, useState } from 'react';
import type { TechnicalAssignmentReference } from '@/lib/technical-assignment-decision';
import type { TechnicalUploadAction, TechnicalUploadState } from '@/lib/technical-upload-ui-state';
import { technicalUploadReviewPath, technicalUploadVerdictLabels } from '@/lib/technical-upload-display';
import { TechnicalUploadRecovery, technicalUploadInitial, useUploadReady, uploadButton, uploadControl, rememberUpload } from './technical-upload-recovery';
function Confirm({ preview, action, recovery, edit }: { preview: NonNullable<TechnicalUploadState['reviewPreview']>;
  action: TechnicalUploadAction; recovery: TechnicalUploadAction; edit: () => void }) {
  const ready = useUploadReady(), [state, submit, pending] = useActionState(action, technicalUploadInitial), [sent, setSent] = useState(false);
  const locked = !ready || sent || pending;
  return <section className="min-w-0 space-y-3 rounded-xl border border-blue-400 bg-blue-50 p-4" aria-label="Riepilogo revisione documento">
    <h3 className="text-xl font-bold">{technicalUploadVerdictLabels[preview.command.verdict]}</h3>
    <p className="break-words">{preview.file.title} · {preview.file.fileName} · {preview.file.sizeBytes} byte</p>
    <p className="break-all text-sm">Impronta del file: {preview.file.contentSha256}</p><p className="whitespace-pre-wrap break-words">Motivo: {preview.command.reason}</p>
    <p>La decisione riguarda questo file. Il file e lo storico restano nel deposito privato; nessuna pubblicazione nel fascicolo, concessione o email.</p>
    <button type="button" className="font-semibold underline" disabled={locked} onClick={edit}>Rivedi la decisione</button>
    <form action={submit} className="space-y-3" onSubmit={() => { rememberUpload('reviewDecision', preview.command.commandId); setSent(true); }}>
      <input type="hidden" name="reference" value={JSON.stringify(preview.reference)} /><input type="hidden" name="command" value={JSON.stringify(preview.command)} />
      <input type="hidden" name="token" value={preview.token} /><label className="flex items-start gap-2"><input type="checkbox" name="confirmed" required disabled={locked} />Confermo personalmente questa revisione e il motivo riepilogato.</label>
      <p>È richiesta la conferma di sicurezza del profilo personale autorizzato.</p><button className={uploadButton} disabled={locked}>Conferma revisione</button></form>
    <p role="status">{state.message}</p>{state.recorded && <a className="font-semibold underline" href={technicalUploadReviewPath(preview.reference)}>Ricarica le revisioni</a>}
    {state.uncertain && <TechnicalUploadRecovery reference={preview.reference} commandId={preview.command.commandId} action={recovery} returnPath={technicalUploadReviewPath(preview.reference)} />}
  </section>;
}
export function TechnicalUploadReviewForm({ reference, submissionCommandId, sourceSha256, initialCommandId, previewAction, confirmAction, receiptAction }: {
  reference: TechnicalAssignmentReference; submissionCommandId: string; sourceSha256: string; initialCommandId: string;
  previewAction: TechnicalUploadAction; confirmAction: TechnicalUploadAction; receiptAction: TechnicalUploadAction }) {
  const ready = useUploadReady(), [state, submit, pending] = useActionState(previewAction, technicalUploadInitial);
  const [commandId, setCommand] = useState(initialCommandId), [verdict, setVerdict] = useState(''), [reason, setReason] = useState('');
  const preview = state.reviewPreview?.command.commandId === commandId ? state.reviewPreview : null, locked = !ready || pending || !!preview;
  const changed = () => setCommand(crypto.randomUUID());
  return <div className="min-w-0 space-y-3" data-upload-review-ready={ready ? 'true' : 'false'}>
    <form action={submit} className="space-y-3" onSubmit={event => { event.preventDefault(); const form = new FormData(event.currentTarget); startTransition(() => submit(form)); }}>
      <input type="hidden" name="reference" value={JSON.stringify(reference)} /><input type="hidden" name="command" value={JSON.stringify({ commandId, submissionCommandId, sourceSha256, verdict, reason })} />
      <label className="block font-semibold">Esito della revisione<select className={uploadControl} value={verdict} required disabled={locked} onChange={event => { setVerdict(event.target.value); changed(); }}>
        <option value="">Seleziona un esito</option><option value="APPROVE_PRIVATE">Approva il documento nel deposito privato</option><option value="REJECT_PRIVATE">Rifiuta il documento conservando lo storico</option></select></label>
      <label className="block font-semibold">Motivo della revisione<textarea className={uploadControl} value={reason} minLength={3} maxLength={500} required disabled={locked}
        onChange={event => { setReason(event.target.value); changed(); }} /></label>
      <p>Il motivo sarà leggibile anche dall’autore del deposito finché il suo incarico resta valido.</p>
      <button className={uploadButton} disabled={locked || !verdict || reason.trim().length < 3}>Prepara riepilogo della revisione</button><p role="status">{state.message}</p>
    </form>{preview && <Confirm key={preview.token} preview={preview} action={confirmAction} recovery={receiptAction} edit={changed} />}
  </div>;
}
