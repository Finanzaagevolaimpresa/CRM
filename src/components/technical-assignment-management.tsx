'use client';

import { startTransition, useActionState, useState, useSyncExternalStore } from 'react';
import type { readTechnicalAssignmentManagement } from '@/lib/technical-assignment-management';
import type { previewTechnicalAssignment, readTechnicalAssignmentOutcome } from '@/lib/technical-assignment-service';
import { technicalActionLabels, technicalFieldLabels, technicalManagementPath, technicalResponsibilityLabels } from '@/lib/technical-assignment-display';
import type { TechnicalAssignmentReference } from '@/lib/technical-assignment-decision';
import { technicalAssignmentCommand, type TechnicalAssignmentSelection } from '@/lib/technical-assignment-contract';

type Data = Awaited<ReturnType<typeof readTechnicalAssignmentManagement>>;
type Outcome = Awaited<ReturnType<typeof readTechnicalAssignmentOutcome>>;
export type TechnicalAssignmentManagementState = { ok: boolean; message: string; uncertain?: boolean;
  preview?: Awaited<ReturnType<typeof previewTechnicalAssignment>>; outcome?: Outcome };
export type TechnicalAssignmentManagementAction = (previous: TechnicalAssignmentManagementState, form: FormData) => Promise<TechnicalAssignmentManagementState>;
type Actions = { previewAction: TechnicalAssignmentManagementAction; confirmAction: TechnicalAssignmentManagementAction;
  receiptAction: TechnicalAssignmentManagementAction };
const initial: TechnicalAssignmentManagementState = { ok: false, message: '' };
const control = 'block w-full min-w-0 rounded-xl border border-slate-300 bg-white p-3';
const button = 'rounded-xl bg-blue-900 px-4 py-3 font-semibold text-white disabled:opacity-50';
const when = (value: string) => new Date(value).toLocaleString('it-IT');
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
  return <section className="space-y-3 rounded-xl border border-amber-400 bg-amber-50 p-4" aria-label="Verifica esito incarico">
    <p>Verifica l’esito prima di decidere un altro incarico. Questa consultazione non modifica i permessi.</p>
    <form action={submit}><input type="hidden" name="reference" value={JSON.stringify(reference)} />
      <input type="hidden" name="commandId" value={commandId} />
      <button className={button} disabled={!ready || pending}>Verifica esito della decisione</button></form>
    <p role="status">{state.message}</p>
    {state.outcome?.status === 'RECORDED' && <a className="font-semibold underline" href={technicalManagementPath(reference)}>Ricarica gli incarichi correnti</a>}
  </section>;
}

function Confirm({ preview, blocked, confirmAction, receiptAction }: Actions & {
  preview: NonNullable<TechnicalAssignmentManagementState['preview']>; blocked: boolean }) {
  const ready = useSyncExternalStore(subscribeReady, browserReady, serverReady);
  const [state, submit, pending] = useActionState(confirmAction, initial);
  const assign = 'selection' in preview.input ? preview.input.selection : null;
  const locked = !ready || blocked || pending || state.ok || !!state.uncertain;
  return <section className="min-w-0 space-y-4 rounded-xl border border-blue-400 bg-blue-50 p-4" aria-label="Riepilogo incarico">
    <h2 className="text-xl font-bold">{assign ? 'Conferma incarico e perimetro' : 'Conferma revoca dell’incarico'}</h2>
    <p className="break-words"><strong>{preview.recipient.name}</strong> · {preview.recipient.email}</p>
    {assign ? <>
      <p>{technicalResponsibilityLabels[assign.responsibility]} · scadenza {when(assign.expiresAt)}</p>
      <p>{preview.replacesAssignment ? 'Questa decisione sostituisce l’incarico precedente della stessa persona su questo record.' : 'Questa decisione aggiunge una persona al solo record selezionato.'}</p>
      <p>Operazioni consentite: {assign.actions.map(action => technicalActionLabels[action]).join(', ')}.</p>
      <dl className="grid min-w-0 gap-3 rounded-xl bg-white p-4 sm:grid-cols-2">{preview.fields.map(field => <div key={field.key} className="min-w-0">
        <dt className="font-semibold">{field.label}{assign.editableFields.some(key => key === field.key) ? ' · modificabile' : ' · lettura'}</dt>
        <dd className="whitespace-pre-wrap break-words">{field.value ?? '—'}</dd></div>)}</dl>
      <h3 className="font-bold">Versioni documentali incluse</h3>
      {!preview.documents.length ? <p>Nessun documento selezionato.</p> : <ul className="space-y-2">{preview.documents.map(doc =>
        <li key={doc.fileId} className="break-words">{doc.title} · {doc.fileName} · versione {doc.version} · {doc.allowDownload ? 'anteprima e download' : 'solo anteprima'}</li>)}</ul>}
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

export function TechnicalAssignmentManagement({ data, initialCommandId, revocationCommandId, recoverCommandId, ...actions }: Actions & {
  data: Data; initialCommandId: string; revocationCommandId: string; recoverCommandId?: string }) {
  const ready = useSyncExternalStore(subscribeReady, browserReady, serverReady);
  const [responsibility, setResponsibility] = useState<TechnicalAssignmentSelection['responsibility']>('supporto');
  const [readable, setReadable] = useState<string[]>([]), [editable, setEditable] = useState<string[]>([]);
  const [chosenActions, setActions] = useState<TechnicalAssignmentSelection['actions']>([]);
  const [chosenDocuments, setDocuments] = useState<Record<string, boolean>>({});
  const [expires, setExpires] = useState(''), [reason, setReason] = useState(''), [revokeReason, setRevokeReason] = useState('');
  const [commandId, setCommand] = useState(initialCommandId), [generation, setGeneration] = useState(0);
  const [previewGeneration, setPreviewGeneration] = useState(-1), [submitted, setSubmitted] = useState(false);
  const [preview, prepare, preparing] = useActionState(actions.previewAction, initial);
  const [revocation, revokePreview, preparingRevoke] = useActionState(actions.previewAction, initial);
  const [revokeGeneration, setRevokeGeneration] = useState(0), [preparedRevokeGeneration, setPreparedRevokeGeneration] = useState(-1);
  const reference = data.recipient ? { ...data.target, recipientId: data.recipient.id } : null;
  const expiry = expires ? new Date(expires).getTime() : NaN;
  const command = data.recipient ? { commandId, targetId: data.target.targetId, expectedRevision: data.revision,
    expectedContextSha256: data.contextSha256, expectedRecipientEpoch: data.recipient.epoch,
    selection: { kind: data.target.kind, userId: data.recipient.id, responsibility, actions: chosenActions,
      readableFields: readable, editableFields: editable, expiresAt: Number.isFinite(expiry) ? new Date(expiry).toISOString() : '',
      documents: data.documentOptions.filter(doc => Object.hasOwn(chosenDocuments, doc.fileId)).map(doc => ({
        documentId: doc.documentId, fileId: doc.fileId, version: doc.version, contentSha256: doc.contentSha256,
        contextSha256: doc.contextSha256, allowDownload: chosenDocuments[doc.fileId] })) }, reason } : null;
  const valid = data.recipientEligible && technicalAssignmentCommand.safeParse(command).success;
  const blocked = !ready || submitted || !!recoverCommandId;
  const changed = () => { setGeneration(value => value + 1); setCommand(crypto.randomUUID()); };
  const prepared = previewGeneration === generation ? preview.preview : undefined;
  const preparedRevoke = preparedRevokeGeneration === revokeGeneration ? revocation.preview : undefined;
  return <div className="min-w-0 space-y-6" data-technical-editor-ready={ready ? 'true' : 'false'}>
    <p>Scegli una persona e il lavoro che potrà svolgere su questo record. Gli incarichi di altri tecnici e il referente commerciale restano distinti.</p>
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
      {data.recipientEligible && <form action={prepare} onSubmit={event => {
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
          <fieldset><legend className="font-bold">Documenti e versioni da includere</legend><p>Massimo 20 versioni, scelte singolarmente. Contratti e pagamenti restano riservati.</p>
            {!data.documentOptions.length && <p>Nessuna versione disponibile per questa persona e questo record.</p>}
            <div className="space-y-3">{data.documentOptions.map(doc => <div key={doc.fileId} className="min-w-0 rounded-xl border p-3">
              <label className="flex items-start gap-2 break-words"><input type="checkbox" checked={Object.hasOwn(chosenDocuments, doc.fileId)} onChange={event => setDocuments(old => { const next = { ...old }; if (event.target.checked) next[doc.fileId] = false; else delete next[doc.fileId]; return next; })} />{doc.title} · {doc.fileName} · versione {doc.version}</label>
              <label className="mt-2 flex items-center gap-2 text-sm"><input type="checkbox" disabled={!Object.hasOwn(chosenDocuments, doc.fileId)} checked={chosenDocuments[doc.fileId] === true} onChange={event => setDocuments(old => ({ ...old, [doc.fileId]: event.target.checked }))} />Consenti anche il download</label>
            </div>)}</div>{data.documentsLimited && <p>Catalogo limitato. Sono mostrate soltanto le versioni qui disponibili; le altre non verranno incluse.</p>}
          </fieldset>
          <label className="block font-semibold">Scadenza, entro 90 giorni<input className={control} type="datetime-local" required value={expires} onChange={event => setExpires(event.target.value)} /></label>
          <label className="block font-semibold">Motivo dell’incarico<textarea className={control} value={reason} minLength={3} maxLength={500} required onChange={event => setReason(event.target.value)} /></label>
          <input type="hidden" name="operation" value="ASSIGN" /><input type="hidden" name="reference" value={JSON.stringify(reference)} />
          <input type="hidden" name="command" value={JSON.stringify(command)} />
          <button className={button} disabled={!valid}>{preparing ? 'Preparazione…' : 'Anteprima dell’incarico'}</button>
        </fieldset><p role="status">{preview.message}</p>
      </form>}
      {prepared && <div onSubmitCapture={event => { if ((event.target as HTMLFormElement).elements.namedItem('confirmed')) setSubmitted(true); }}>
        <Confirm key={prepared.token} {...actions} preview={prepared} blocked={blocked} /></div>}
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
          <input type="hidden" name="command" value={JSON.stringify({ commandId: revocationCommandId, assignmentId: data.currentAssignmentId,
            expectedRevision: data.revision, expectedContextSha256: data.contextSha256, reason: revokeReason })} />
          <button className={button}>Anteprima della revoca</button>
        </fieldset><p role="status">{revocation.message}</p>
      </form>}
      {preparedRevoke && <div onSubmitCapture={event => { if ((event.target as HTMLFormElement).elements.namedItem('confirmed')) setSubmitted(true); }}>
        <Confirm key={preparedRevoke.token} {...actions} preview={preparedRevoke} blocked={blocked} /></div>}
    </>}
    <section className="space-y-3"><h2 className="text-xl font-bold">Incarichi registrati su questo record</h2>
      {!data.assignments.length && <p>Nessun incarico registrato.</p>}
      {data.assignments.map(assignment => <article key={assignment.id} className="min-w-0 space-y-2 rounded-xl border p-4">
        <h3 className="break-words font-bold">{assignment.recipientName} · {assignment.recipientEmail}</h3>
        <p>{technicalResponsibilityLabels[assignment.selection.responsibility]} · {assignment.revokedAt ? 'Revocato' : 'Permessi verificati a ogni apertura e salvataggio'} · scadenza {when(assignment.selection.expiresAt)}</p>
        <p>Campi: {assignment.selection.readableFields.map(field => technicalFieldLabels[field]).join(', ')}</p>
        <p>Operazioni: {assignment.selection.actions.map(action => technicalActionLabels[action]).join(', ')}</p>
        <a className="font-semibold underline" aria-disabled={blocked} href={blocked ? undefined : `${technicalManagementPath(data.target)}?recipient=${encodeURIComponent(assignment.recipientId)}`}>Gestisci l’incarico di questa persona</a>
      </article>)}
      {data.assignmentsLimited && <p>Sono mostrati i primi 200 incarichi registrati.</p>}
    </section>
  </div>;
}
