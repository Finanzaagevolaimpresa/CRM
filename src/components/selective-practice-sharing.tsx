'use client';
import { InlinePrivilegedConfirmation } from './inline-privileged-confirmation';

import { canPreviewSelectedDocument, selectedDocumentAccessLabel } from '@/lib/selected-document-formats';

import { useActionState, useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import { preparePracticeSharing, confirmPracticeSharingAction, revokePracticeSharingAction, checkPracticeSharingReceipt, type PracticeSharingState } from '@/lib/selective-practice-actions';
import { selectivePracticeFields, type SelectivePracticeField } from '@/lib/selective-practice-policy';
import { maxPracticeDocuments, type PracticeDocumentChoice } from '@/lib/selective-practice-document-policy';

const initial: PracticeSharingState = { ok: false, message: '' };
const control = 'block w-full min-w-0 rounded-xl border border-slate-300 bg-white p-3';
const button = 'rounded-xl bg-blue-900 px-4 py-3 font-semibold text-white disabled:opacity-50';
const subscribeReady = () => () => {}, browserReady = () => true, serverReady = () => false;
type Grant = { id: string; recipientId: string; recipientName: string; recipientEmail: string; revision: number;
  revoked: boolean; expiresAt: string | null; fields: SelectivePracticeField[]; commandId: string; documentCount: number };
type DocumentOption = { documentId: string; versionId: string; version: number; title: string; fileName: string; mimeType: string; category: string; area: string };
function rememberCommand(id: string) {
  // A lost response can be reconciled after reload without creating a command.
  const url = new URL(window.location.href); url.searchParams.set('commandId', id);
  window.history.replaceState(window.history.state, '', url);
}
function Receipt({ commandId, practiceId }: { commandId: string; practiceId: string }) {
  const [state, action, pending] = useActionState(checkPracticeSharingReceipt, initial);
  return <form action={action} className="space-y-2 rounded-xl bg-slate-50 p-3">
    <input type="hidden" name="commandId" value={commandId} />
    <input type="hidden" name="practiceId" value={practiceId} />
    <button disabled={pending} className="font-semibold underline">Verifica ricevuta dell’operazione</button>
    <p role="status">{state.message}</p>
  </form>;
}
export function SelectivePracticeSharing({ practiceId, recipients, grants, initialCommandId, documentOptions, documentsLimited, operational }: {
  practiceId: string; recipients: { id: string; name: string; email: string; role: string }[];
  grants: Grant[]; initialCommandId: string; documentOptions: DocumentOption[]; documentsLimited: boolean; operational: boolean;
}) {
  const router = useRouter();
  const ready = useSyncExternalStore(subscribeReady, browserReady, serverReady);
  const [recipientId, setRecipient] = useState(''), [fields, setFields] = useState<SelectivePracticeField[]>([]);
  const [documents, setDocuments] = useState<PracticeDocumentChoice[]>([]), [documentSearch, setDocumentSearch] = useState('');
  const [expires, setExpires] = useState(''), [commandId, setCommand] = useState(initialCommandId);
  const [generation, setGeneration] = useState(0), [previewGeneration, setPreviewGeneration] = useState(-1);
  const [preview, prepare, preparing] = useActionState(preparePracticeSharing, initial);
  const [confirmation, confirm, confirming] = useActionState(confirmPracticeSharingAction, initial);
  const grant = grants.find(row => row.recipientId === recipientId);
  const expiresTime = expires ? new Date(expires).getTime() : null;
  const validExpiry = expiresTime === null || Number.isFinite(expiresTime);
  const selection = { version: 2 as const, practiceId, recipientId, revision: grant?.revision ?? 0, commandId, fields, documents,
    expiresAt: expiresTime !== null && validExpiry ? new Date(expiresTime).toISOString() : null };
  const locked = confirming || confirmation.ok || !!confirmation.uncertain;
  const changed = () => { setGeneration(value => value + 1); setCommand(crypto.randomUUID()); };
  const prepared = !preparing && previewGeneration === generation && preview.preview?.input.commandId === commandId && preview.preview;
  return <div className="min-w-0 space-y-6" data-testid="practice-sharing" data-interactive-ready={ready}>
    {!operational && <p role="status">La pratica o un contesto collegato è sospeso o archiviato. Puoi revocare le selezioni esistenti; nuove concessioni richiedono un contesto operativo.</p>}
    <form action={prepare} onSubmit={() => setPreviewGeneration(generation)} onReset={event => event.preventDefault()} onChange={changed} className="space-y-4">
      <fieldset disabled={!ready || locked || preparing || !operational} className="min-w-0 space-y-4">
        <label className="block font-semibold">Persona esistente<select required className={control} value={recipientId} onChange={event => setRecipient(event.target.value)}>
          <option value="">Seleziona una persona</option>{recipients.map(person => <option key={person.id} value={person.id}>{person.name} · {person.email} · {person.role}</option>)}
        </select></label>
        <fieldset><legend className="mb-2 font-semibold">Campi che la persona potrà leggere</legend><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {(Object.entries(selectivePracticeFields) as [SelectivePracticeField, string][]).map(([key, label]) => <label className="flex items-center gap-2 rounded-lg border p-3" key={key}>
            <input type="checkbox" checked={fields.includes(key)} onChange={event => setFields(old => event.target.checked ? [...old, key] : old.filter(value => value !== key))} />{label}</label>)}
        </div></fieldset>
        <fieldset className="min-w-0 space-y-3"><legend className="mb-2 font-semibold">Documenti e versioni da condividere</legend>
          <p className="text-sm text-slate-600">Collega esplicitamente a questa pratica e a questa persona fino a {maxPracticeDocuments} versioni dei documenti del cliente. Il collegamento viene registrato con la conferma. Le versioni future non saranno condivise automaticamente. Contratti e pagamenti sono riservati ad Admin e Amministrazione.</p>
          <label className="block">Cerca fra le versioni disponibili<input className={control} value={documentSearch} onChange={event => setDocumentSearch(event.target.value)} /></label>
          {!documentOptions.length && <p>Nessuna versione condivisibile disponibile per questa pratica.</p>}
          {documentsLimited && <p role="status">Sono mostrate le 200 versioni più recenti dei 100 documenti più recenti. Le versioni non elencate non verranno incluse.</p>}
          <div className="max-h-96 space-y-2 overflow-y-auto">{documentOptions.filter(d => `${d.title} ${d.fileName} ${d.category}`.toLocaleLowerCase('it').includes(documentSearch.toLocaleLowerCase('it'))).map(document => {
            const choice = documents.find(row => row.versionId === document.versionId);
            return <div key={document.versionId} className="min-w-0 rounded-xl border p-3">
              <label className="flex items-start gap-2"><input type="checkbox" checked={!!choice} disabled={!choice && documents.length >= maxPracticeDocuments}
                onChange={event => setDocuments(old => event.target.checked ? [...old, { versionId: document.versionId, download: false }] : old.filter(row => row.versionId !== document.versionId))} />
                <span className="min-w-0 break-words"><strong>{document.title}</strong> · versione {document.version}<br />{document.fileName} · {document.category}</span></label>
              <label className="mt-2 flex items-center gap-2"><input type="checkbox" disabled={!choice} checked={choice?.download ?? false}
                onChange={event => setDocuments(old => old.map(row => row.versionId === document.versionId ? { ...row, download: event.target.checked } : row))} /> {canPreviewSelectedDocument(document) ? 'Consenti anche il download di questa versione' : 'Consenti il download di questa versione (necessario per aprire il file)'}</label>
            </div>;
          })}</div>
          <p className="text-sm text-slate-600">Per i formati senza anteprima, senza download condividi soltanto nome e versione. Le copie già acquisite non possono essere ritirate; la revoca blocca le aperture successive.</p>
        </fieldset>
        <label className="block font-semibold">Scadenza facoltativa<input className={control} type="datetime-local" value={expires} onChange={event => setExpires(event.target.value)} /></label>
        <p className="text-sm text-slate-600">Solo i campi e le versioni scelti per questa pratica. Il collegamento non concede accesso all’intero cliente, progetto, servizio o ad altre pratiche. Nessuna modifica o caricamento. Gli accessi già autorizzati in altri contesti restano separati.</p>
        <input type="hidden" name="selection" value={JSON.stringify(selection)} />
        <button className={button} disabled={!recipientId || (!fields.length && !documents.length) || !validExpiry}>{preparing ? 'Preparazione…' : 'Anteprima come destinatario'}</button>
      </fieldset>
      <p role="status">{preview.message}</p>
    </form>
    {prepared && !confirmation.ok && <section aria-labelledby="practice-sharing-preview-title" className="min-w-0 space-y-4 rounded-xl border border-amber-500 bg-amber-50 p-4">
      <h2 id="practice-sharing-preview-title" className="text-xl font-bold">Riepilogo e anteprima</h2>
      <p className="break-words"><strong>{prepared.recipient.name}</strong> · {prepared.recipient.email} · {prepared.recipient.role}</p>
      <p>{prepared.replacesFullAccess ? 'La persona ha già accesso ordinario alla pratica: questa selezione lo sostituirà.' : 'La persona potrà leggere soltanto i campi e le versioni indicati.'}</p>
      {prepared.replacesSelection && <p>La nuova selezione sostituirà la precedente.</p>}
      <p>Alla revoca o alla scadenza, l’accesso precedente non si riattiva. Il ruolo Admin e le assegnazioni non ampliano la selezione.</p>
      <p>{prepared.input.expiresAt ? `Scadenza: ${new Date(prepared.input.expiresAt).toLocaleString('it-IT')}` : 'Senza scadenza, revocabile in questa pagina.'}</p>
      <dl className="grid min-w-0 gap-3 rounded-xl bg-white p-4 sm:grid-cols-2">{prepared.fields.map(field => <div key={field.key} className="min-w-0"><dt className="font-semibold">{field.label}</dt><dd className="break-words whitespace-pre-wrap">{field.value}</dd></div>)}</dl>
      {!!prepared.documents.length && <div className="space-y-2 rounded-xl bg-white p-4"><h3 className="font-semibold">Versioni collegate alla pratica e visibili al destinatario</h3>{prepared.documents.map(document => <p key={document.versionId} className="break-words">{document.title} · versione {document.version} · {document.fileName} · {selectedDocumentAccessLabel(document, document.download)}</p>)}</div>}
      <form action={confirm} onReset={event => event.preventDefault()} onSubmit={() => rememberCommand(prepared.input.commandId)} className="space-y-3">
        <input type="hidden" name="selection" value={JSON.stringify(prepared.input)} /><input type="hidden" name="token" value={prepared.token} />
        <label className="flex items-start gap-2"><input required type="checkbox" name="confirmed" disabled={locked} />Confermo personalmente i campi, le versioni dei documenti, il destinatario e l’effetto sui permessi.</label>
        <p className="text-sm">È necessaria la conferma di sicurezza del profilo personale autorizzato.</p>
        <button className={button} disabled={locked}>{confirming ? 'Conferma in corso…' : 'Conferma accesso selettivo'}</button>
      </form>
      <Receipt commandId={prepared.input.commandId} practiceId={practiceId} />
    </section>}
    <p role="status">{confirmation.message}</p>
    {confirmation.stepUpRequired && <InlinePrivilegedConfirmation />}
    {(confirmation.ok || confirmation.uncertain) && <button className="font-semibold underline" onClick={() => router.refresh()}>Ricarica lo stato corrente</button>}
    <section className="space-y-3"><h2 className="text-xl font-bold">Selezioni e revoche</h2>
      {!grants.length && <p>Nessuna selezione registrata per questa pratica.</p>}
      {grants.map(row => <Revoke key={`${row.id}:${row.revision}`} grant={row} practiceId={practiceId} />)}
    </section>
  </div>;
}
function Revoke({ grant, practiceId }: { grant: Grant; practiceId: string }) {
  const [state, action, pending] = useActionState(revokePracticeSharingAction, initial);
  return <div className="min-w-0 space-y-3 rounded-xl border p-4">
    <p className="break-words font-semibold">{grant.recipientName} · {grant.recipientEmail}</p>
    <p>Revisione {grant.revision} · {grant.revoked ? 'Revocata' : 'Selezione registrata; validità verificata a ogni apertura'}</p>
    <p className="text-sm">Campi: {grant.fields.map(field => selectivePracticeFields[field]).join(', ') || 'Nessun campo selezionato'}</p>
    <p className="text-sm">Versioni di documenti selezionate: {grant.documentCount}</p>
    <p>{grant.expiresAt ? `Scadenza: ${new Date(grant.expiresAt).toLocaleString('it-IT')}` : 'Senza scadenza indicata'}</p>
    {!grant.revoked && !state.ok && <form action={action} onSubmit={() => rememberCommand(grant.commandId)} className="space-y-3">
      <input type="hidden" name="grantId" value={grant.id} /><input type="hidden" name="revision" value={grant.revision} /><input type="hidden" name="commandId" value={grant.commandId} />
      <label className="flex items-start gap-2"><input name="confirmed" type="checkbox" required disabled={pending || state.uncertain} />Confermo la revoca. Le copie già acquisite non possono essere recuperate.</label>
      <button disabled={pending || state.uncertain} className="font-semibold text-red-800 underline">Revoca accesso</button>
    </form>}
    <p role="status">{state.message}</p>
    {state.stepUpRequired && <InlinePrivilegedConfirmation />}{!grant.revoked && <Receipt commandId={grant.commandId} practiceId={practiceId} />}
  </div>;
}
