'use client';
import { startTransition, useActionState, useId, useState } from 'react';
import type { TechnicalAssignmentReference } from '@/lib/technical-assignment-decision';
import type { TechnicalUploadAction, TechnicalUploadState } from '@/lib/technical-upload-ui-state';
import { technicalUploadReviewPath } from '@/lib/technical-upload-display';
import { TechnicalUploadRecovery, technicalUploadInitial, useUploadReady, uploadButton, uploadControl, rememberUpload } from './technical-upload-recovery';
const labels: Record<string, string> = { TECHNICAL_DOCUMENT: 'Documento tecnico', CONTRACT: 'Contratto · riservato', PAYMENT: 'Pagamento · riservato', OTHER_CONFIDENTIAL: 'Altro documento riservato' };
function Confirm({ preview, action, recovery, edit }: { preview: NonNullable<TechnicalUploadState['acquisitionPreview']>;
  action: TechnicalUploadAction; recovery: TechnicalUploadAction; edit: () => void }) {
  const ready = useUploadReady(), [state, submit, pending] = useActionState(action, technicalUploadInitial), [sent, setSent] = useState(false);
  const locked = !ready || sent || pending;
  return <section className="min-w-0 space-y-3 rounded-xl border border-blue-400 bg-blue-50 p-4" aria-label="Riepilogo acquisizione nel fascicolo">
    <h3 className="text-xl font-bold">{preview.command.title}</h3><p>{labels[preview.command.classification]}</p>
    <p className="break-words">{preview.file.fileName} · {preview.file.sizeBytes} byte · versione 1</p>
    <p className="break-all text-sm">Impronta: {preview.file.contentSha256}</p>
    <p>Destinazione: fascicolo del cliente collegato a questo incarico. Visibilità iniziale: solo il profilo personale Admin autorizzato.</p>
    <p>Scadenza del documento: {preview.command.expiresAt ? new Date(preview.command.expiresAt).toLocaleString('it-IT') : 'Non impostata'}.</p>
    <p>Le persone e le versioni da mostrare si scelgono separatamente dopo l’acquisizione. Contratti e pagamenti restano riservati ad Admin e Amministrazione.</p>
    <button type="button" className="font-semibold underline" disabled={locked} onClick={edit}>Rivedi la classificazione</button>
    <form action={submit} className="space-y-3" onSubmit={() => { rememberUpload('acquisitionDecision', preview.command.commandId); setSent(true); }}>
      <input type="hidden" name="reference" value={JSON.stringify(preview.reference)} /><input type="hidden" name="command" value={JSON.stringify(preview.command)} />
      <input type="hidden" name="token" value={preview.token} /><label className="flex items-start gap-2"><input type="checkbox" name="confirmed" required disabled={locked} />Confermo personalmente l’acquisizione privata e la classificazione di questo file esatto.</label>
      <p>È richiesta la conferma di sicurezza del profilo personale autorizzato.</p><button className={uploadButton} disabled={locked}>Acquisisci nel fascicolo privato</button>
    </form><p role="status">{state.message}</p>
    {state.recorded && <a className="font-semibold underline" href={`/clients/${encodeURIComponent(preview.clientId)}/acquired-documents`}>Apri documenti acquisiti e scegli la visibilità</a>}
    {state.uncertain && <TechnicalUploadRecovery reference={preview.reference} commandId={preview.command.commandId} action={recovery} returnPath={technicalUploadReviewPath(preview.reference)} />}
  </section>;
}
export function TechnicalDocumentAcquisitionForm({ reference, submissionCommandId, sourceSha256, reviewCommandId, reviewSha256, title: initialTitle,
  initialCommandId, previewAction, confirmAction, receiptAction }: { reference: TechnicalAssignmentReference;
  submissionCommandId: string; sourceSha256: string; reviewCommandId: string; reviewSha256: string; title: string; initialCommandId: string;
  previewAction: TechnicalUploadAction; confirmAction: TechnicalUploadAction; receiptAction: TechnicalUploadAction }) {
  const ready = useUploadReady(), [state, submit, pending] = useActionState(previewAction, technicalUploadInitial), field = useId();
  const [commandId, setCommand] = useState(initialCommandId), [classification, setClassification] = useState(''), [title, setTitle] = useState(initialTitle), [expiry, setExpiry] = useState('');
  const preview = state.acquisitionPreview?.command.commandId === commandId ? state.acquisitionPreview : null;
  const locked = !ready || pending || !!preview, changed = () => setCommand(crypto.randomUUID());
  const expiresAt = expiry && Number.isFinite(Date.parse(expiry)) ? new Date(expiry).toISOString() : null;
  return <div className="min-w-0 space-y-3" data-acquisition-ready={ready ? 'true' : 'false'}>
    <h3 className="text-lg font-bold">Acquisisci il documento approvato nel fascicolo</h3>
    <form action={submit} className="space-y-3" onSubmit={event => { event.preventDefault(); const form = new FormData(event.currentTarget); startTransition(() => submit(form)); }}>
      <input type="hidden" name="reference" value={JSON.stringify(reference)} /><input type="hidden" name="command" value={JSON.stringify({ commandId, submissionCommandId, sourceSha256, reviewCommandId, reviewSha256, classification, title, expiresAt, visibility: 'ADMIN_PRIVATE' })} />
      <label className="block font-semibold" htmlFor={field + '-title'}>Titolo nel fascicolo</label><input id={field + '-title'} className={uploadControl} value={title} required minLength={3} maxLength={180} disabled={locked} onChange={e => { setTitle(e.target.value); changed(); }} />
      <label className="block font-semibold" htmlFor={field + '-class'}>Classificazione del documento</label><select id={field + '-class'} className={uploadControl} value={classification} required disabled={locked} onChange={e => { setClassification(e.target.value); changed(); }}>
        <option value="">Scegli in base al contenuto effettivo</option>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      <p>La classificazione riguarda il contenuto, anche quando il nome del file non lo descrive. Nessuna persona riceve accesso automaticamente.</p>
      <label className="block font-semibold" htmlFor={field + '-expiry'}>Scadenza del documento (facoltativa)</label><input id={field + '-expiry'} type="datetime-local" className={uploadControl} value={expiry} disabled={locked} onChange={e => { setExpiry(e.target.value); changed(); }} />
      <button className={uploadButton} disabled={locked || !classification || title.trim().length < 3}>Prepara acquisizione privata</button><p role="status">{state.message}</p>
    </form>{preview && <Confirm key={preview.token} preview={preview} action={confirmAction} recovery={receiptAction} edit={changed} />}
  </div>;
}
