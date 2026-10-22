'use client';

import { useActionState, useState } from 'react';
import type { readLeadEditingManagement, previewLeadEditingSelection, readLeadEditingDecision } from '@/lib/selective-lead-edit-management';
import { selectiveLeadEditableFields, type SelectiveLeadEditableField } from '@/lib/selective-lead-edit-policy';

export type LeadEditManagementState = { ok: boolean; message: string; uncertain?: boolean;
  preview?: Awaited<ReturnType<typeof previewLeadEditingSelection>>;
  receipt?: NonNullable<Awaited<ReturnType<typeof readLeadEditingDecision>>> };
type Management = Awaited<ReturnType<typeof readLeadEditingManagement>>;
type Data = Omit<Management, 'grants'> & { grants: Array<Management['grants'][number] & { commandId: string }> };
type Action = (previous: LeadEditManagementState, form: FormData) => Promise<LeadEditManagementState>;
const initial: LeadEditManagementState = { ok: false, message: '' };
const control = 'block w-full min-w-0 rounded-xl border border-slate-300 bg-white p-3';
const button = 'rounded-xl bg-blue-900 px-4 py-3 font-semibold text-white disabled:opacity-50';
const when = (value: string | null) => value ? new Date(value).toLocaleString('it-IT') : 'Senza scadenza indicata';
function remember(id: string) {
  const url = new URL(window.location.href); url.searchParams.set('editDecisionId', id);
  window.history.replaceState(window.history.state, '', url);
}
function Decision({ commandId, leadId, action }: { commandId: string; leadId: string; action: Action }) {
  const [state, submit, pending] = useActionState(action, initial);
  return <section aria-label="Verifica esito abilitazione" className="space-y-3 rounded-xl border border-amber-400 bg-amber-50 p-4">
    <p>Verifica l’esito della decisione prima di abilitarne un’altra. Questa verifica non cambia i permessi.</p>
    <form action={submit}><input type="hidden" name="commandId" value={commandId} />
      <button className={button} disabled={pending}>Verifica ricevuta della decisione</button></form>
    <p role="status">{state.message}</p>
    {state.ok && state.receipt && <a className="font-semibold underline" href={`/leads/${leadId}/sharing/editing`}>Ricarica lo stato corrente</a>}
  </section>;
}
export function SelectiveLeadEditManagement({ data, initialCommandId, recoverCommandId,
  previewAction, confirmAction, revokeAction, receiptAction }: {
  data: Data; initialCommandId: string; recoverCommandId?: string;
  previewAction: Action; confirmAction: Action; revokeAction: Action; receiptAction: Action;
}) {
  const [recipientId, setRecipient] = useState(''), [fields, setFields] = useState<SelectiveLeadEditableField[]>([]);
  const [expires, setExpires] = useState(''), [commandId, setCommand] = useState(initialCommandId);
  const [generation, setGeneration] = useState(0), [previewGeneration, setPreviewGeneration] = useState(-1);
  const [preview, prepare, preparing] = useActionState(previewAction, initial);
  const [result, confirm, confirming] = useActionState(confirmAction, initial);
  const person = data.choices.find(row => row.id === recipientId);
  const expiry = expires ? new Date(expires).getTime() : person?.expiresAt ? Date.parse(person.expiresAt) : null;
  const validExpiry = expiry === null || Number.isFinite(expiry);
  const selection = person ? { protocol: 'SELECTIVE_LEAD_EDIT_SELECTION_V1', leadId: data.leadId, recipientId,
    readGrantId: person.readGrantId, readGrantRevision: person.readGrantRevision, readGrantProof: person.readGrantProof,
    revision: person.revision, commandId, fields, expiresAt: expiry !== null && validExpiry ? new Date(expiry).toISOString() : null } : null;
  const locked = confirming || result.ok || !!result.uncertain || !!recoverCommandId;
  const prepared = previewGeneration === generation ? preview.preview : undefined;
  const changed = () => { setGeneration(value => value + 1); setCommand(crypto.randomUUID()); };
  return <div className="min-w-0 space-y-6">
    <p>Abilita la modifica soltanto per una persona che dispone già di una selezione di lettura valida. Scegli separatamente i campi che potrà cambiare.</p>
    {recoverCommandId && <Decision commandId={recoverCommandId} leadId={data.leadId} action={receiptAction} />}
    <form action={prepare} onSubmit={() => setPreviewGeneration(generation)} onChange={changed} className="space-y-4">
      <fieldset disabled={locked || preparing} className="min-w-0 space-y-4">
        <label className="block font-semibold">Persona con accesso selettivo<select className={control} required value={recipientId}
          onChange={event => { setRecipient(event.target.value); setFields([]); setExpires(''); }}>
          <option value="">Seleziona una persona</option>{data.choices.map(row => <option key={row.id} value={row.id}>{row.name} · {row.email} · {row.role}</option>)}
        </select></label>
        {!data.choices.length && <p>Nessuna persona ha una selezione di lettura valida per i campi modificabili. Imposta prima la lettura dalla pagina di accesso selettivo.</p>}
        {person && <fieldset><legend className="mb-2 font-semibold">Campi che la persona potrà modificare</legend>
          <div className="grid gap-3 sm:grid-cols-2">{person.fields.map(field => <label key={field} className="flex items-center gap-2 rounded-xl border p-3">
            <input type="checkbox" checked={fields.includes(field)} onChange={event => setFields(old => event.target.checked ? [...old, field] : old.filter(item => item !== field))} />
            {selectiveLeadEditableFields[field]}</label>)}</div></fieldset>}
        <label className="block font-semibold">Scadenza della modifica<input className={control} type="datetime-local" value={expires} onChange={event => setExpires(event.target.value)} /></label>
        <p className="text-sm text-slate-600">{person?.expiresAt
          ? `Lasciando il campo vuoto, la modifica scade insieme alla lettura: ${when(person.expiresAt)}. Puoi anticipare la scadenza.`
          : 'Senza una data, la modifica resta revocabile e dipende sempre dalla selezione di lettura corrente.'}</p>
        <p>La modifica della selezione di lettura, la revoca, il cestino o la conversione del lead interrompono questa abilitazione. Ripristinare il lead non la rinnova.</p>
        <input type="hidden" name="selection" value={JSON.stringify(selection)} />
        <button className={button} disabled={!person || !fields.length || !validExpiry}>{preparing ? 'Preparazione…' : 'Anteprima dei permessi di modifica'}</button>
      </fieldset><p role="status">{preview.message}</p>
    </form>
    {prepared && !result.ok && <section className="min-w-0 space-y-4 rounded-xl border border-blue-400 bg-blue-50 p-4" aria-labelledby="lead-edit-management-preview">
      <h2 id="lead-edit-management-preview" className="text-xl font-bold">Conferma persona e campi modificabili</h2>
      <p className="break-words"><strong>{prepared.recipient.name}</strong> · {prepared.recipient.email} · {prepared.recipient.role}</p>
      <p>{prepared.replacesSelection ? 'Questa scelta sostituisce i precedenti permessi di modifica.' : 'Questa scelta abilita soltanto le modifiche indicate.'}</p>
      <p>{when(prepared.input.expiresAt)}</p>
      <dl className="grid min-w-0 gap-3 rounded-xl bg-white p-4 sm:grid-cols-2">{prepared.fields.map(field => <div key={field.key} className="min-w-0">
        <dt className="font-semibold">{field.label}</dt><dd className="whitespace-pre-wrap break-words">{field.value}</dd></div>)}</dl>
      <p>Assegnazioni, stato, note private, documenti, contratti, pagamenti e comunicazioni non diventano modificabili con questa scelta.</p>
      <form action={confirm} onSubmit={() => remember(prepared.input.commandId)} className="space-y-3">
        <input type="hidden" name="selection" value={JSON.stringify(prepared.input)} /><input type="hidden" name="token" value={prepared.token} />
        <label className="flex items-start gap-2"><input required name="confirmed" type="checkbox" disabled={locked} />Confermo personalmente destinatario, campi e scadenza.</label>
        <p className="text-sm">È necessaria la conferma di sicurezza del profilo personale autorizzato.</p>
        <button className={button} disabled={locked}>{confirming ? 'Conferma in corso…' : 'Conferma permessi di modifica'}</button>
      </form>
      {result.uncertain && <Decision commandId={prepared.input.commandId} leadId={data.leadId} action={receiptAction} />}
    </section>}
    <p role="status">{result.message}</p>
    {result.ok && <a className="font-semibold underline" href={`/leads/${data.leadId}/sharing/editing`}>Ricarica lo stato corrente</a>}
    <section className="space-y-3"><h2 className="text-xl font-bold">Permessi di modifica registrati</h2>
      {!data.grants.length && <p>Nessuna abilitazione registrata.</p>}
      {data.grants.map(grant => <Revoke key={`${grant.id}:${grant.revision}`} grant={grant} blocked={!!recoverCommandId}
        leadId={data.leadId} action={revokeAction} receiptAction={receiptAction} />)}
    </section>
  </div>;
}
function Revoke({ grant, blocked, leadId, action, receiptAction }: {
  grant: Data['grants'][number]; blocked: boolean; leadId: string; action: Action; receiptAction: Action;
}) {
  const [state, submit, pending] = useActionState(action, initial), commandId = grant.commandId;
  return <div className="min-w-0 space-y-3 rounded-xl border p-4">
    <p className="break-words font-semibold">{grant.recipientName} · {grant.recipientEmail}</p>
    <p>{grant.revoked ? 'Revocata' : 'Validità verificata a ogni apertura e salvataggio'} · revisione {grant.revision}</p>
    <p>Campi: {grant.fields.map(field => selectiveLeadEditableFields[field]).join(', ') || 'Da riconciliare'}</p>
    <p>{when(grant.expiresAt)}</p>
    {!grant.revoked && !state.ok && <form action={submit} onSubmit={() => remember(commandId)} className="space-y-3">
      <input type="hidden" name="grantId" value={grant.id} /><input type="hidden" name="revision" value={grant.revision} /><input type="hidden" name="commandId" value={commandId} />
      <label className="flex items-start gap-2"><input required name="confirmed" type="checkbox" disabled={blocked || pending || state.uncertain} />Confermo la revoca dei permessi di modifica.</label>
      <button className="font-semibold text-red-800 underline" disabled={blocked || pending || state.uncertain}>Revoca modifica</button>
    </form>}
    <p role="status">{state.message}</p>
    {state.uncertain && <Decision commandId={commandId} leadId={leadId} action={receiptAction} />}
  </div>;
}
