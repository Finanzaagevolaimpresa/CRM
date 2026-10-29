'use client';

import { selectedDocumentAccessLabel } from '@/lib/selected-document-formats';

import { startTransition, useActionState, useEffect, useState, useSyncExternalStore } from 'react';
import type { readTechnicalAssignmentManagement } from '@/lib/technical-assignment-management';
import type { previewTechnicalAssignment, readTechnicalAssignmentOutcome } from '@/lib/technical-assignment-service';
import { technicalActionLabels, technicalFieldLabels, technicalManagementPath, technicalResponsibilityLabels } from '@/lib/technical-assignment-display';
import type { TechnicalAssignmentReference } from '@/lib/technical-assignment-decision';
import { technicalAssignmentCommand, type TechnicalAssignmentSelection } from '@/lib/technical-assignment-contract';
import { technicalItemFieldLabels } from '@/lib/technical-work-item-grant';
import { TechnicalWorkItemChoices, type ItemChoices, type TechnicalItemCatalogueAction } from './technical-work-item-choices';
import { selectedTechnicalWorkItemGrants } from '@/lib/technical-work-item-catalog';
import { selectedTechnicalDocuments, type TechnicalDocumentChoices as DocumentChoices } from '@/lib/technical-document-catalog';
import { TechnicalDocumentChoices, type TechnicalDocumentCatalogueAction } from './technical-document-choices';
import { TechnicalUploadProfileFields, emptyUploadProfile, uploadProfileFromChoices } from './technical-upload-profile-fields';
import { technicalUploadReviewPath } from '@/lib/technical-upload-display';
import { RomeDateTimeInput } from './rome-date-time-input';
import { operationalRomeTime as when } from '@/lib/operational-time';
import { settleTechnicalAssignmentAction } from '@/lib/technical-assignment-actions';
import { InlinePrivilegedConfirmation } from './inline-privileged-confirmation';

type Data = Awaited<ReturnType<typeof readTechnicalAssignmentManagement>>;
type Outcome = Awaited<ReturnType<typeof readTechnicalAssignmentOutcome>>;
export type TechnicalAssignmentManagementState = { ok: boolean; message: string; uncertain?: boolean;
  rejectedBeforeWrite?: true;
  stepUpRequired?: true;
  preview?: Awaited<ReturnType<typeof previewTechnicalAssignment>>; outcome?: Outcome };
export type TechnicalAssignmentManagementAction = (previous: TechnicalAssignmentManagementState, form: FormData) => Promise<TechnicalAssignmentManagementState>;
type Actions = { previewAction: TechnicalAssignmentManagementAction; confirmAction: TechnicalAssignmentManagementAction;
  receiptAction: TechnicalAssignmentManagementAction };
const initial: TechnicalAssignmentManagementState = { ok: false, message: '' };
const control = 'block w-full min-w-0 rounded-xl border border-slate-300 bg-white p-3';
const button = 'rounded-xl bg-blue-900 px-4 py-3 font-semibold text-white disabled:opacity-50';
const subscribeReady = () => () => {}, browserReady = () => true, serverReady = () => false;
function remember(ref: TechnicalAssignmentReference, commandId: string) {
  const url = new URL(window.location.href);
  url.searchParams.set('recipient', ref.recipientId); url.searchParams.set('assignmentDecision', commandId);
  window.history.replaceState(window.history.state, '', url);
}
function Recovery({ reference, commandId, action }: { reference: TechnicalAssignmentReference; commandId: string;
  action: TechnicalAssignmentManagementAction }) {
  const ready = useSyncExternalStore(subscribeReady, browserReady, serverReady);
  const [state, submit, pending] = useActionState(action, initial);
  const [settled, settle, settling] = useActionState(settleTechnicalAssignmentAction, initial);
  const outcome = settled.outcome ?? state.outcome;
  return <section className="space-y-3 rounded-xl border border-amber-400 bg-amber-50 p-4" aria-label="Verifica esito incarico">
    <p>Verifica l’esito prima di decidere un altro incarico. Questa consultazione non modifica i permessi.</p>
    <form action={submit}><input type="hidden" name="reference" value={JSON.stringify(reference)} />
      <input type="hidden" name="commandId" value={commandId} />
      <button className={button} disabled={!ready || pending}>Verifica esito della decisione</button></form>
    <p role="status">{state.message}</p>
    {state.outcome?.status === 'NOT_OBSERVED' && !settled.outcome && <form action={settle} className="space-y-3">
      <input type="hidden" name="reference" value={JSON.stringify(reference)} /><input type="hidden" name="commandId" value={commandId} />
      <label className="flex gap-2"><input name="confirmedSettlement" type="checkbox" required />Verifica eventuali operazioni ancora in corso e chiudi questo tentativo se non risulta registrato.</label>
      <button className={button} disabled={settling || pending}>Riconcilia e chiudi il tentativo</button>
      <p>Nessun incarico viene creato o ripetuto. Un risultato già registrato viene conservato.</p>
    </form>}
    <p role="status">{settled.message}</p>
    {(outcome?.status === 'RECORDED' || outcome?.status === 'CLOSED_WITHOUT_RECEIPT') && <a className="font-semibold underline"
      href={`${technicalManagementPath(reference)}?recipient=${encodeURIComponent(reference.recipientId)}`}>Riapri le scelte della persona</a>}
  </section>;
}

function Confirm({ preview, blocked, confirmAction, receiptAction, onRejected }: Actions & {
  preview: NonNullable<TechnicalAssignmentManagementState['preview']>; blocked: boolean;
  onRejected: (message: string, needsConfirmation: boolean) => void }) {
  const ready = useSyncExternalStore(subscribeReady, browserReady, serverReady);
  const [state, submit, pending] = useActionState(confirmAction, initial);
  useEffect(() => {
    if (!state.rejectedBeforeWrite || state.uncertain) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get('assignmentDecision') !== preview.input.commandId
      || url.searchParams.get('recipient') !== preview.reference.recipientId) return;
    // Only the server's typed, pre-persistence refusal settles this attempt.
    // A missing receipt or unknown error must keep recovery in place.
    url.searchParams.delete('assignmentDecision');
    window.history.replaceState(window.history.state, '', url);
    onRejected(state.message, !!state.stepUpRequired);
  }, [state.rejectedBeforeWrite, state.uncertain, state.message, state.stepUpRequired, preview.input.commandId, preview.reference.recipientId, onRejected]);
  const assign = 'selection' in preview.input ? preview.input.selection : null;
  const locked = !ready || blocked || pending || !!state.message;
  return <section className="min-w-0 space-y-4 rounded-xl border border-blue-400 bg-blue-50 p-4" aria-label="Riepilogo incarico">
    <h2 className="text-xl font-bold">{assign ? 'Conferma incarico e perimetro' : 'Conferma revoca dell’incarico'}</h2>
    <p className="break-words"><strong>{preview.recipient.name}</strong> · {preview.recipient.email}</p>
    {assign ? <>
      <p>{technicalResponsibilityLabels[assign.responsibility]} · scadenza {when(assign.expiresAt)}</p>
      <p>{preview.replacesAssignment ? 'Questa decisione sostituisce l’incarico precedente della stessa persona su questo record.' : 'Questa decisione aggiunge una persona al solo record selezionato.'}</p>
      <p>Operazioni consentite: {assign.actions.map(action => technicalActionLabels[action]).join(', ')}.</p>
      {assign.uploadProfile && <div className="space-y-2 rounded-xl bg-white p-3"><h3 className="font-bold">Deposito privato da revisionare</h3>
        <p className="break-words">Scopo: {assign.uploadProfile.purpose}</p><p>Formati: {assign.uploadProfile.formats.join(', ')}</p>
        <p>Massimo {assign.uploadProfile.maxFilesPerRevision} file · {assign.uploadProfile.maxFileBytes / 1048576} MiB per file · {assign.uploadProfile.maxBytesPerRevision / 1048576} MiB totali.</p>
        <p>Approvazione o rifiuto personale dell’Admin. Nessuna pubblicazione o condivisione automatica.</p></div>}
      <dl className="grid min-w-0 gap-3 rounded-xl bg-white p-4 sm:grid-cols-2">{preview.fields.map(field => <div key={field.key} className="min-w-0">
        <dt className="font-semibold">{field.label}{assign.editableFields.some(key => key === field.key) ? ' · modificabile' : ' · lettura'}</dt>
        <dd className="whitespace-pre-wrap break-words">{['dueDate', 'submittedAt', 'nextClientUpdateAt', 'dueAt'].includes(field.key) ? when(field.value) : field.value ?? '—'}</dd></div>)}</dl>
      <h3 className="font-bold">Versioni documentali incluse</h3>
      {!preview.documents.length ? <p>Nessun documento selezionato.</p> : <ul className="space-y-2">{preview.documents.map(doc =>
        <li key={doc.fileId} className="break-words">{doc.title} · {doc.fileName} · versione {doc.version} · {selectedDocumentAccessLabel(doc, doc.allowDownload)}</li>)}</ul>}
      <h3 className="font-bold">Checklist, attività e scadenze incluse</h3>
      {!preview.workItems.length ? <p>Nessun elemento selezionato.</p> : preview.workItems.map(item => <div key={`${item.kind}:${item.itemId}`} className="space-y-2 rounded-xl bg-white p-3">
        <strong>{item.kind === 'Task' ? 'Attività' : 'Elemento checklist'}</strong>
        <dl>{item.fields.map(field => <div key={field.key} className="min-w-0"><dt className="font-semibold">{technicalItemFieldLabels[field.key]} · {field.editable ? 'modificabile' : 'lettura'}</dt>
          <dd className="whitespace-pre-wrap break-words">{['dueDate', 'submittedAt', 'nextClientUpdateAt', 'dueAt'].includes(field.key) ? when(field.value) : field.value ?? '—'}</dd></div>)}</dl></div>)}
      <p>Il referente commerciale resta invariato. Altri clienti, progetti, pratiche e versioni future dei documenti non sono inclusi.</p>
      <p>Per questa persona, il fascicolo generale del cliente e i percorsi ordinari collegati restano esclusi: il lavoro tecnico passa dagli incarichi espliciti. Questo limite resta anche dopo revoca o scadenza e non rinnova accessi precedenti.</p>
    </> : <p>Il lavoro e lo storico sono conservati. La revoca interrompe questo incarico e non rinnova altri accessi.</p>}
    <p className="whitespace-pre-wrap break-words">Motivo: {preview.input.reason}</p>
    <form action={submit} onSubmit={() => remember(preview.reference, preview.input.commandId)} className="space-y-3">
      <input type="hidden" name="operation" value={preview.operation} />
      <input type="hidden" name="reference" value={JSON.stringify(preview.reference)} />
      <input type="hidden" name="command" value={JSON.stringify(preview.input)} />
      <input type="hidden" name="token" value={preview.token} />
      <label className="flex items-start gap-2"><input type="checkbox" name="confirmed" required />Confermo personalmente questa decisione, la persona e il perimetro riepilogati.</label>
      <p className="text-sm">È richiesta la conferma di sicurezza del profilo personale autorizzato.</p>
      <button disabled={locked} className={button}>{pending ? 'Conferma in corso…' : assign ? 'Conferma incarico tecnico' : 'Revoca incarico tecnico'}</button>
    </form><p role="status">{state.message}</p>
    {state.ok && <a href={technicalManagementPath(preview.reference)} className="font-semibold underline">Ricarica gli incarichi correnti</a>}
    {!state.ok && state.message && !state.uncertain && <a href={technicalManagementPath(preview.reference)} className="font-semibold underline">Ricarica per preparare una nuova decisione</a>}
    {state.uncertain && <Recovery reference={preview.reference} commandId={preview.input.commandId} action={receiptAction} />}
  </section>;
}

export function TechnicalAssignmentManagement({ data, initialCommandId, revocationCommandId, recoverCommandId, catalogueAction, documentCatalogueAction, ...actions }: Actions & {
  data: Data; initialCommandId: string; revocationCommandId: string; recoverCommandId?: string;
  catalogueAction: TechnicalItemCatalogueAction; documentCatalogueAction: TechnicalDocumentCatalogueAction }) {
  const ready = useSyncExternalStore(subscribeReady, browserReady, serverReady);
  const [responsibility, setResponsibility] = useState<TechnicalAssignmentSelection['responsibility']>('supporto');
  const [readable, setReadable] = useState<string[]>([]), [editable, setEditable] = useState<string[]>([]);
  const [chosenActions, setActions] = useState<TechnicalAssignmentSelection['actions']>([]);
  const [chosenDocuments, setDocuments] = useState<DocumentChoices>({});
  const [documentCatalogueReady, setDocumentCatalogueReady] = useState(data.documentCatalogueAvailable);
  const [chosenItems, setItems] = useState<ItemChoices>({});
  const [catalogueReady, setCatalogueReady] = useState(data.workItemCatalogueAvailable);
  const [uploadChoices, setUploadChoices] = useState(emptyUploadProfile);
  const [expires, setExpires] = useState(''), [reason, setReason] = useState(''), [revokeReason, setRevokeReason] = useState('');
  const [commandId, setCommand] = useState(initialCommandId), [generation, setGeneration] = useState(0);
  const [revokeCommandId, setRevokeCommandId] = useState(revocationCommandId);
  const [previewGeneration, setPreviewGeneration] = useState(-1), [submitted, setSubmitted] = useState(false);
  const [resumption, setResumption] = useState<{ message: string; needsConfirmation: boolean } | null>(null);
  const [preview, prepare, preparing] = useActionState(actions.previewAction, initial);
  const [revocation, revokePreview, preparingRevoke] = useActionState(actions.previewAction, initial);
  const [revokeGeneration, setRevokeGeneration] = useState(0), [preparedRevokeGeneration, setPreparedRevokeGeneration] = useState(-1);
  const reference = data.recipient ? { ...data.target, recipientId: data.recipient.id } : null;
  const expiry = expires ? new Date(expires).getTime() : NaN;
  const command = data.recipient ? { commandId, targetId: data.target.targetId, expectedRevision: data.revision,
    expectedContextSha256: data.contextSha256, expectedRecipientEpoch: data.recipient.epoch,
    selection: { kind: data.target.kind, userId: data.recipient.id, responsibility, actions: chosenActions,
      ...(chosenActions.includes('upload_document') ? { uploadProfile: uploadProfileFromChoices(uploadChoices) } : {}),
      readableFields: readable, editableFields: editable, expiresAt: Number.isFinite(expiry) ? new Date(expiry).toISOString() : '',
      documents: selectedTechnicalDocuments(chosenDocuments),
      workItems: selectedTechnicalWorkItemGrants(chosenItems, chosenActions) }, reason } : null;
  const valid = !data.cataloguesUnavailable && catalogueReady && documentCatalogueReady && data.recipientEligible && technicalAssignmentCommand.safeParse(command).success;
  const blocked = !ready || submitted || !!recoverCommandId;
  const changed = () => { setGeneration(value => value + 1); setCommand(crypto.randomUUID()); };
  const prepared = previewGeneration === generation ? preview.preview : undefined;
  const preparedRevoke = preparedRevokeGeneration === revokeGeneration ? revocation.preview : undefined;
  const resume = (message: string, needsConfirmation: boolean) => {
    setSubmitted(false); setPreviewGeneration(-1); setPreparedRevokeGeneration(-1);
    setGeneration(value => value + 1); setCommand(crypto.randomUUID());
    setRevokeCommandId(crypto.randomUUID());
    setResumption({ message, needsConfirmation });
  };
  return <div className="min-w-0 space-y-6" data-technical-editor-ready={ready ? 'true' : 'false'}>
    {data.cataloguesUnavailable && <p role="status" className="rounded-xl border border-amber-300 bg-amber-50 p-4">
      Catalogo non disponibile. Puoi consultare gli incarichi registrati e revocarli; ricarica per preparare un nuovo incarico.
    </p>}
    <p>Scegli una persona e il lavoro che potrà svolgere su questo record. Gli incarichi di altri tecnici e il referente commerciale restano distinti.</p>
    {resumption && <div className="space-y-3"><p role="status">{resumption.message}</p>
      {resumption.needsConfirmation && <InlinePrivilegedConfirmation />}</div>}
    <form method="get" action={technicalManagementPath(data.target)} className="space-y-3">
      <label className="block font-semibold">Persona da incaricare<select name="recipient" className={control} defaultValue={data.recipient?.id ?? ''} disabled={blocked} required>
        <option value="">Seleziona una persona</option>{data.people.map(person => <option key={person.id} value={person.id}>{person.name} · {person.email}</option>)}</select></label>
      <button className={button} disabled={blocked}>Apri scelte per la persona</button>
      {data.peopleLimited && <p>Elenco limitato alle prime 200 persone. Nessuna persona esclusa dall’elenco viene incaricata.</p>}
    </form>
    {recoverCommandId && reference && <Recovery reference={reference} commandId={recoverCommandId} action={actions.receiptAction} />}
    {data.recipient && <>
      <h2 className="break-words text-xl font-bold">{data.recipient.name} · {data.recipient.email}</h2>
      {!data.recipientEligible && <p role="status">Un nuovo incarico non è disponibile con lo stato, i permessi o le selezioni di lettura correnti. Gli accessi esistenti non vengono ampliati.</p>}
      {data.recipientEligible && !data.cataloguesUnavailable && <form action={prepare} onSubmit={event => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        setPreviewGeneration(generation);
        // Preview keeps the editor intact; only confirmation consumes the command.
        startTransition(() => prepare(form));
      }} onChange={changed} className="space-y-4">
        <fieldset className="min-w-0 space-y-4" disabled={blocked || preparing || preparingRevoke}>
          <label className="block font-semibold">Responsabilità<select className={control} value={responsibility}
            onChange={event => setResponsibility(event.target.value as TechnicalAssignmentSelection['responsibility'])}>
            {Object.entries(technicalResponsibilityLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
          <fieldset><legend className="font-bold">Operazioni consentite</legend><div className="grid gap-3 sm:grid-cols-2">{data.allowedActions.map(action => <label className="flex items-center gap-2 rounded-xl border p-3" key={action}>
            <input type="checkbox" checked={chosenActions.includes(action)} onChange={event => { setActions(old => event.target.checked ? [...old, action] : old.filter(item => item !== action)); if (!event.target.checked && action === 'update_fields') setEditable([]); }} />{technicalActionLabels[action]}</label>)}</div></fieldset>
          <fieldset><legend className="font-bold">Informazioni da mostrare e campi modificabili</legend><div className="grid gap-3 sm:grid-cols-2">{data.fieldCatalogue.map(field => <div className="space-y-2 rounded-xl border p-3" key={field.key}>
            <label className="flex items-center gap-2"><input type="checkbox" checked={readable.includes(field.key)} onChange={event => { setReadable(old => event.target.checked ? [...old, field.key] : old.filter(item => item !== field.key)); if (!event.target.checked) setEditable(old => old.filter(item => item !== field.key)); }} />{field.label}</label>
            {field.editable && <label className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={!readable.includes(field.key) || !chosenActions.includes('update_fields')} checked={editable.includes(field.key)} onChange={event => setEditable(old => event.target.checked ? [...old, field.key] : old.filter(item => item !== field.key))} />Consenti la modifica</label>}
          </div>)}</div></fieldset>
          <TechnicalDocumentChoices data={data} choices={chosenDocuments} onChange={value => { setDocuments(value); changed(); }}
            catalogueAction={documentCatalogueAction} onReady={value => { setDocumentCatalogueReady(value); if (!value) changed(); }} />
          <TechnicalWorkItemChoices data={data} actions={chosenActions} choices={chosenItems}
            onChange={value => { setItems(value); changed(); }} catalogueAction={catalogueAction}
            onReady={value => { setCatalogueReady(value); if (!value) changed(); }} />
          {chosenActions.includes('upload_document') && <TechnicalUploadProfileFields value={uploadChoices} onChange={setUploadChoices} />}
          <RomeDateTimeInput label="Scadenza, entro 90 giorni" className={control} required value={expires} onChange={setExpires} />
          <label className="block font-semibold">Motivo dell’incarico<textarea className={control} value={reason} minLength={3} maxLength={500} required onChange={event => setReason(event.target.value)} /></label>
          <input type="hidden" name="operation" value="ASSIGN" /><input type="hidden" name="reference" value={JSON.stringify(reference)} />
          <input type="hidden" name="command" value={JSON.stringify(command)} />
          <button className={button} disabled={!valid}>{preparing ? 'Preparazione…' : 'Anteprima dell’incarico'}</button>
        </fieldset><p role="status">{preview.message}</p>
      </form>}
      {prepared && <div onSubmitCapture={event => { if ((event.target as HTMLFormElement).elements.namedItem('confirmed')) setSubmitted(true); }}>
        <Confirm key={prepared.token} {...actions} preview={prepared} blocked={blocked} onRejected={resume} /></div>}
      {data.currentAssignmentId && data.currentRevokedAt === null && <form action={revokePreview} onSubmit={event => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        setPreparedRevokeGeneration(revokeGeneration);
        startTransition(() => revokePreview(form));
      }} className="space-y-3 rounded-xl border p-4">
        <h2 className="text-xl font-bold">Revoca l’incarico della persona</h2>
        <fieldset disabled={blocked || preparing || preparingRevoke} className="space-y-3">
          <label className="block font-semibold">Motivo della revoca<textarea className={control} required minLength={3} maxLength={500} value={revokeReason} onChange={event => { setRevokeReason(event.target.value); setRevokeGeneration(old => old + 1); }} /></label>
          <input type="hidden" name="operation" value="REVOKE" /><input type="hidden" name="reference" value={JSON.stringify(reference)} />
          <input type="hidden" name="command" value={JSON.stringify({ commandId: revokeCommandId, assignmentId: data.currentAssignmentId,
            expectedRevision: data.revision, expectedContextSha256: data.contextSha256, reason: revokeReason })} />
          <button className={button}>Anteprima della revoca</button>
        </fieldset><p role="status">{revocation.message}</p>
      </form>}
      {preparedRevoke && <div onSubmitCapture={event => { if ((event.target as HTMLFormElement).elements.namedItem('confirmed')) setSubmitted(true); }}>
        <Confirm key={preparedRevoke.token} {...actions} preview={preparedRevoke} blocked={blocked} onRejected={resume} /></div>}
    </>}
    <section className="space-y-3"><h2 className="text-xl font-bold">Incarichi registrati su questo record</h2>
      {!data.assignments.length && <p>Nessun incarico registrato.</p>}
      {data.assignments.map(assignment => <article key={assignment.id} className="min-w-0 space-y-2 rounded-xl border p-4">
        <h3 className="break-words font-bold">{assignment.recipientName} · {assignment.recipientEmail}</h3>
        <p>{technicalResponsibilityLabels[assignment.selection.responsibility]} · {assignment.revokedAt ? 'Revocato' : 'Permessi verificati a ogni apertura e salvataggio'} · scadenza {when(assignment.selection.expiresAt)}</p>
        <p>Campi: {assignment.selection.readableFields.map(field => technicalFieldLabels[field]).join(', ')}</p>
        <p>Operazioni: {assignment.selection.actions.map(action => technicalActionLabels[action]).join(', ')}</p>
        <a className="font-semibold underline" aria-disabled={blocked} href={blocked ? undefined : `${technicalManagementPath(data.target)}?recipient=${encodeURIComponent(assignment.recipientId)}`}>Gestisci l’incarico di questa persona</a>
        {!assignment.revokedAt && assignment.selection.uploadProfile && <p><a className="font-semibold underline" href={technicalUploadReviewPath({ ...data.target, recipientId: assignment.recipientId })}>Revisiona i documenti depositati</a></p>}
      </article>)}
      {data.assignmentsLimited && <p>Sono mostrati i primi 200 incarichi registrati.</p>}
    </section>
  </div>;
}
