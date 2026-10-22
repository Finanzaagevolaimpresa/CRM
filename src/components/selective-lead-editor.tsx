'use client';

import { useActionState, useState } from 'react';
import type { readLeadEditing } from '@/lib/selective-lead-edit-access';
import type { previewLeadEdit, readLeadEditOutcomeByReference } from '@/lib/selective-lead-edit-service';
import { selectiveLeadEditableFields, type SelectiveLeadEditCommand } from '@/lib/selective-lead-edit-policy';

export type LeadEditUiState = { ok: boolean; message: string; uncertain?: boolean;
  preview?: Awaited<ReturnType<typeof previewLeadEdit>>;
  receipt?: NonNullable<Awaited<ReturnType<typeof readLeadEditOutcomeByReference>>> };
type Action = (previous: LeadEditUiState, form: FormData) => Promise<LeadEditUiState>;
type View = Awaited<ReturnType<typeof readLeadEditing>>;
const initial: LeadEditUiState = { ok: false, message: '' };
const control = 'block w-full min-w-0 rounded-xl border border-slate-300 bg-white p-3';
const button = 'rounded-xl bg-blue-900 px-4 py-3 font-semibold text-white disabled:opacity-50';
const priorities = { bassa: 'Bassa', media: 'Media', alta: 'Alta', urgente: 'Urgente' } as const;
const shown = (key: string, value: string | null | undefined) => key === 'priority'
  ? priorities[value as keyof typeof priorities] ?? 'Non disponibile' : value ?? 'Non indicato';

function remember(id: string) {
  // Only an opaque command id is retained. No field value, proof or token is
  // copied to the URL, localStorage or sessionStorage.
  const url = new URL(window.location.href); url.searchParams.set('editCommandId', id);
  window.history.replaceState(window.history.state, '', url);
}
function Outcome({ leadId, commandId, action }: { leadId: string; commandId: string; action: Action }) {
  const [state, submit, pending] = useActionState(action, initial);
  return <section className="space-y-3 rounded-xl border border-amber-400 bg-amber-50 p-4" aria-label="Verifica esito modifica">
    <p>Verifica l’esito prima di iniziare un’altra modifica. Questa verifica non salva dati.</p>
    <form action={submit} className="space-y-2">
      <input type="hidden" name="leadId" value={leadId} /><input type="hidden" name="commandId" value={commandId} />
      <button className={button} disabled={pending}>{pending ? 'Verifica in corso…' : 'Verifica esito della modifica'}</button>
    </form>
    <p role="status">{state.message}</p>
    {state.ok && state.receipt && <a className="font-semibold underline" href={`/leads/${leadId}/edit-selected`}>Ricarica i dati correnti</a>}
  </section>;
}

/** The restricted form receives only the fields admitted by the server. */
export function SelectiveLeadEditor({ view, initialCommandId, recoverCommandId,
  previewAction, confirmAction, outcomeAction }: {
  view: View; initialCommandId: string; recoverCommandId?: string;
  previewAction: Action; confirmAction: Action; outcomeAction: Action;
}) {
  const [values, setValues] = useState(() => Object.fromEntries(view.fields.map(field => [field.key, field.value ?? ''])));
  const [commandId, setCommandId] = useState(initialCommandId);
  const [generation, setGeneration] = useState(0), [previewGeneration, setPreviewGeneration] = useState(-1);
  const [preview, prepare, preparing] = useActionState(previewAction, initial);
  const [result, confirm, confirming] = useActionState(confirmAction, initial);
  const changes: SelectiveLeadEditCommand['changes'] = {};
  for (const field of view.fields) {
    const value = field.key === 'interest' ? values[field.key].trim() || null : values[field.key];
    if (value === field.value) continue;
    if (field.key === 'interest') changes.interest = value;
    else changes.priority = value as keyof typeof priorities;
  }
  const command: SelectiveLeadEditCommand = { protocol: 'SELECTIVE_LEAD_EDIT_COMMAND_V1', commandId,
    leadId: view.leadId, capabilityId: view.capabilityId, capabilityRevision: view.capabilityRevision,
    readGrantId: view.readGrantId, readGrantRevision: view.readGrantRevision,
    readGrantProof: view.readGrantProof, expectedVersion: view.expectedVersion, changes };
  const locked = confirming || result.ok || !!result.uncertain;
  const prepared = previewGeneration === generation ? preview.preview : undefined;
  const changed = () => { setGeneration(value => value + 1); setCommandId(crypto.randomUUID()); };
  if (recoverCommandId) return <Outcome leadId={view.leadId} commandId={recoverCommandId} action={outcomeAction} />;
  return <div className="min-w-0 space-y-6">
    <p>Puoi modificare soltanto i campi abilitati personalmente dall’Admin. Le autorizzazioni vengono verificate di nuovo al salvataggio.</p>
    <form action={prepare} onSubmit={() => setPreviewGeneration(generation)} onChange={changed} className="space-y-4">
      <fieldset disabled={locked || preparing} className="min-w-0 space-y-4">
        <legend className="mb-3 font-semibold">Campi abilitati alla modifica</legend>
        {view.fields.map(field => <div key={field.key} className="min-w-0 font-semibold">
          <label htmlFor={`lead-edit-${field.key}`}>{field.label}</label>
          {field.key === 'priority' ? <select id={`lead-edit-${field.key}`} className={control} value={values.priority}
            onChange={event => setValues(old => ({ ...old, priority: event.target.value }))}>
            {Object.entries(priorities).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select> : <textarea id={`lead-edit-${field.key}`} className={control} maxLength={5000} rows={4} value={values.interest}
            onChange={event => setValues(old => ({ ...old, interest: event.target.value }))} />}
        </div>)}
        <input type="hidden" name="command" value={JSON.stringify(command)} />
        <button className={button} disabled={!Object.keys(changes).length}>{preparing ? 'Preparazione…' : 'Rivedi le modifiche'}</button>
      </fieldset>
      <p role="status">{preview.message}</p>
    </form>
    {prepared && !result.ok && <section className="min-w-0 space-y-4 rounded-xl border border-blue-400 bg-blue-50 p-4" aria-labelledby="lead-edit-preview">
      <h2 id="lead-edit-preview" className="text-xl font-bold">Conferma le modifiche</h2>
      <div className="space-y-3">{prepared.changes.map(change => <div key={change.field} className="min-w-0 rounded-xl bg-white p-4">
        <h3 className="font-semibold">{selectiveLeadEditableFields[change.field]}</h3>
        <dl className="grid gap-3 sm:grid-cols-2">
          <div className="min-w-0"><dt className="text-sm text-slate-600">Prima</dt><dd className="whitespace-pre-wrap break-words">{shown(change.field, change.before)}</dd></div>
          <div className="min-w-0"><dt className="text-sm text-slate-600">Dopo</dt><dd className="whitespace-pre-wrap break-words">{shown(change.field, change.after)}</dd></div>
        </dl>
      </div>)}</div>
      <form action={confirm} onSubmit={() => remember(prepared.command.commandId)} className="space-y-3">
        <input type="hidden" name="command" value={JSON.stringify(prepared.command)} /><input type="hidden" name="token" value={prepared.token} />
        <label className="flex items-start gap-2"><input name="confirmed" type="checkbox" required disabled={locked} />Confermo questi valori e il salvataggio sul lead.</label>
        <button className={button} disabled={locked}>{confirming ? 'Salvataggio in corso…' : 'Conferma e salva modifiche'}</button>
      </form>
      {result.uncertain && <Outcome leadId={view.leadId} commandId={prepared.command.commandId} action={outcomeAction} />}
    </section>}
    <p role="status">{result.message}</p>
    {result.ok && <a className="font-semibold underline" href={`/leads/${view.leadId}/edit-selected`}>Ricarica i dati correnti</a>}
  </div>;
}
