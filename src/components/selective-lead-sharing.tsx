'use client';
import { InlinePrivilegedConfirmation } from './inline-privileged-confirmation';

import { useActionState, useState, useSyncExternalStore } from 'react';
import { prepareLeadSharing, confirmLeadSharingAction, revokeLeadSharingAction, checkLeadSharingReceipt, type LeadSharingState } from '@/lib/selective-lead-actions';
import { selectiveLeadFields, type SelectiveLeadField } from '@/lib/selective-lead-policy';

const initial: LeadSharingState = { ok: false, message: '' };
const control = 'block w-full min-w-0 rounded-xl border border-slate-300 bg-white p-3';
const button = 'rounded-xl bg-blue-900 px-4 py-3 font-semibold text-white disabled:opacity-50';
const subscribeReady = () => () => {}, browserReady = () => true, serverReady = () => false;
type Grant = { id: string; recipientId: string; recipientName: string; recipientEmail: string; revision: number;
  revoked: boolean; expiresAt: string | null; fields: SelectiveLeadField[]; commandId: string };
function rememberCommand(id: string) {
  // A lost response can be reconciled after reload without creating a command.
  const url = new URL(window.location.href); url.searchParams.set('commandId', id);
  window.history.replaceState(window.history.state, '', url);
}
function Receipt({ commandId }: { commandId: string }) {
  const ready = useSyncExternalStore(subscribeReady, browserReady, serverReady);
  const [state, action, pending] = useActionState(checkLeadSharingReceipt, initial);
  return <form action={action} className="space-y-2 rounded-xl bg-slate-50 p-3">
    <input type="hidden" name="commandId" value={commandId} />
    <button disabled={!ready || pending} className="font-semibold underline">Verifica ricevuta dell’operazione</button>
    <p role="status">{state.message}</p>
  </form>;
}
export function SelectiveLeadSharing({ leadId, recipients, grants, initialCommandId }: {
  leadId: string; recipients: { id: string; name: string; email: string; role: string }[];
  grants: Grant[]; initialCommandId: string;
}) {
  const ready = useSyncExternalStore(subscribeReady, browserReady, serverReady);
  const [recipientId, setRecipient] = useState(''), [fields, setFields] = useState<SelectiveLeadField[]>([]);
  const [expires, setExpires] = useState(''), [commandId, setCommand] = useState(initialCommandId);
  const [generation, setGeneration] = useState(0), [previewGeneration, setPreviewGeneration] = useState(-1);
  const [preview, prepare, preparing] = useActionState(prepareLeadSharing, initial);
  const [confirmation, confirm, confirming] = useActionState(confirmLeadSharingAction, initial);
  const grant = grants.find(row => row.recipientId === recipientId);
  const expiresTime = expires ? new Date(expires).getTime() : null;
  const validExpiry = expiresTime === null || Number.isFinite(expiresTime);
  const selection = { leadId, recipientId, revision: grant?.revision ?? 0, commandId, fields,
    expiresAt: expiresTime !== null && validExpiry ? new Date(expiresTime).toISOString() : null };
  const locked = !ready || confirming || confirmation.ok || !!confirmation.uncertain;
  const changed = () => { setGeneration(value => value + 1); setCommand(crypto.randomUUID()); };
  const prepared = !preparing && previewGeneration === generation && preview.preview?.input.commandId === commandId && preview.preview;
  return <div className="min-w-0 space-y-6" data-testid="lead-sharing" data-interactive-ready={ready}>
    <form action={prepare} onSubmit={() => setPreviewGeneration(generation)} onReset={event => event.preventDefault()} onChange={changed} className="space-y-4">
      <fieldset disabled={locked || preparing} className="min-w-0 space-y-4">
        <label className="block font-semibold">Persona esistente<select required className={control} value={recipientId} onChange={event => setRecipient(event.target.value)}>
          <option value="">Seleziona una persona</option>{recipients.map(person => <option key={person.id} value={person.id}>{person.name} · {person.email} · {person.role}</option>)}
        </select></label>
        <fieldset><legend className="mb-2 font-semibold">Campi che la persona potrà leggere</legend><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {(Object.entries(selectiveLeadFields) as [SelectiveLeadField, string][]).map(([key, label]) => <label className="flex items-center gap-2 rounded-lg border p-3" key={key}>
            <input type="checkbox" checked={fields.includes(key)} onChange={event => setFields(old => event.target.checked ? [...old, key] : old.filter(value => value !== key))} />{label}</label>)}
        </div></fieldset>
        <label className="block font-semibold">Scadenza facoltativa<input className={control} type="datetime-local" value={expires} onChange={event => setExpires(event.target.value)} /></label>
        <p className="text-sm text-slate-600">Solo consultazione dei campi scelti. Note private, documenti, comunicazioni, modifica e caricamento restano esclusi. Gli altri record mantengono i propri permessi.</p>
        <input type="hidden" name="selection" value={JSON.stringify(selection)} />
        <button className={button} disabled={!recipientId || !fields.length || !validExpiry}>{preparing ? 'Preparazione…' : 'Anteprima come destinatario'}</button>
      </fieldset>
      <p role="status">{preview.message}</p>
    </form>
    {prepared && !confirmation.ok && <section aria-labelledby="lead-sharing-preview-title" className="min-w-0 space-y-4 rounded-xl border border-amber-500 bg-amber-50 p-4">
      <h2 id="lead-sharing-preview-title" className="text-xl font-bold">Riepilogo e anteprima</h2>
      <p className="break-words"><strong>{prepared.recipient.name}</strong> · {prepared.recipient.email} · {prepared.recipient.role}</p>
      <p>{prepared.replacesFullAccess ? 'La persona ha già accesso ordinario al lead: questa selezione lo sostituirà.' : 'La persona potrà leggere soltanto i campi indicati.'}</p>
      {prepared.replacesSelection && <p>La nuova selezione sostituirà la precedente.</p>}
      <p>Alla revoca o alla scadenza, l’accesso precedente non si riattiva. Il ruolo Admin e le assegnazioni non ampliano la selezione.</p>
      <p>{prepared.input.expiresAt ? `Scadenza: ${new Date(prepared.input.expiresAt).toLocaleString('it-IT')}` : 'Senza scadenza, revocabile in questa pagina.'}</p>
      <dl className="grid min-w-0 gap-3 rounded-xl bg-white p-4 sm:grid-cols-2">{prepared.fields.map(field => <div key={field.key} className="min-w-0"><dt className="font-semibold">{field.label}</dt><dd className="break-words whitespace-pre-wrap">{field.value}</dd></div>)}</dl>
      <form action={confirm} onReset={event => event.preventDefault()} onSubmit={() => rememberCommand(prepared.input.commandId)} className="space-y-3">
        <input type="hidden" name="selection" value={JSON.stringify(prepared.input)} /><input type="hidden" name="token" value={prepared.token} />
        <label className="flex items-start gap-2"><input required type="checkbox" name="confirmed" disabled={locked} />Confermo personalmente i campi, il destinatario e l’effetto sui permessi.</label>
        <p className="text-sm">È necessaria la conferma di sicurezza del profilo personale autorizzato.</p>
        <button className={button} disabled={locked}>{confirming ? 'Conferma in corso…' : 'Conferma accesso selettivo'}</button>
      </form>
      <Receipt commandId={prepared.input.commandId} />
    </section>}
    <p role="status">{confirmation.message}</p>
    {confirmation.stepUpRequired && <InlinePrivilegedConfirmation />}
    {(confirmation.ok || confirmation.uncertain) && <button className="font-semibold underline" onClick={() => window.location.reload()}>Ricarica lo stato corrente</button>}
    <section className="space-y-3"><h2 className="text-xl font-bold">Selezioni e revoche</h2>
      {!grants.length && <p>Nessuna selezione registrata per questo lead.</p>}
      {grants.map(row => <Revoke key={`${row.id}:${row.revision}`} grant={row} />)}
    </section>
  </div>;
}
function Revoke({ grant }: { grant: Grant }) {
  const ready = useSyncExternalStore(subscribeReady, browserReady, serverReady);
  const [state, action, pending] = useActionState(revokeLeadSharingAction, initial);
  return <div className="min-w-0 space-y-3 rounded-xl border p-4">
    <p className="break-words font-semibold">{grant.recipientName} · {grant.recipientEmail}</p>
    <p>Revisione {grant.revision} · {grant.revoked ? 'Revocata' : 'Selezione registrata; validità verificata a ogni apertura'}</p>
    <p className="text-sm">Campi: {grant.fields.map(field => selectiveLeadFields[field]).join(', ') || 'Da riconciliare'}</p>
    <p>{grant.expiresAt ? `Scadenza: ${new Date(grant.expiresAt).toLocaleString('it-IT')}` : 'Senza scadenza indicata'}</p>
    {!grant.revoked && !state.ok && <form action={action} onSubmit={() => rememberCommand(grant.commandId)} className="space-y-3">
      <input type="hidden" name="grantId" value={grant.id} /><input type="hidden" name="revision" value={grant.revision} /><input type="hidden" name="commandId" value={grant.commandId} />
      <label className="flex items-start gap-2"><input name="confirmed" type="checkbox" required disabled={!ready || pending || state.uncertain} />Confermo la revoca. Le copie già acquisite non possono essere recuperate.</label>
      <button disabled={!ready || pending || state.uncertain} className="font-semibold text-red-800 underline">Revoca accesso</button>
    </form>}
    <p role="status">{state.message}</p>
    {state.stepUpRequired && <InlinePrivilegedConfirmation />}{!grant.revoked && <Receipt commandId={grant.commandId} />}
  </div>;
}
