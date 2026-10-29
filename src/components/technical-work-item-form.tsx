'use client';

import { startTransition, useActionState, useState, useSyncExternalStore } from 'react';
import type { readTechnicalWorkItem, previewTechnicalWorkItem, readTechnicalWorkItemOutcome } from '@/lib/technical-work-item-service';
import { technicalWorkPath, type TechnicalTargetReference } from '@/lib/technical-assignment-display';
import { technicalItemFieldLabels } from '@/lib/technical-work-item-grant';
import { RomeDateTimeInput } from './rome-date-time-input';
import { operationalRomeTime } from '@/lib/operational-time';

type Data = Awaited<ReturnType<typeof readTechnicalWorkItem>>;
export type TechnicalWorkItemState = { ok: boolean; message: string; uncertain?: boolean;
  preview?: Awaited<ReturnType<typeof previewTechnicalWorkItem>>; outcome?: Awaited<ReturnType<typeof readTechnicalWorkItemOutcome>> };
export type TechnicalWorkItemAction = (previous: TechnicalWorkItemState, form: FormData) => Promise<TechnicalWorkItemState>;
const initial: TechnicalWorkItemState = { ok: false, message: '' };
const subscribe = () => () => {}, client = () => true, server = () => false;
const button = 'rounded-xl bg-blue-900 px-4 py-3 font-semibold text-white disabled:opacity-50';
const control = 'block w-full min-w-0 rounded-xl border border-slate-300 bg-white p-3';
export function TechnicalWorkItemRecovery({ target, commandId, action }: { target: TechnicalTargetReference; commandId: string; action: TechnicalWorkItemAction }) {
  const ready = useSyncExternalStore(subscribe, client, server), [state, submit, pending] = useActionState(action, initial);
  return <section className="space-y-3 rounded-xl border border-amber-400 bg-amber-50 p-4" aria-label="Verifica esito attività">
    <p>Verifica la ricevuta prima di ripetere il salvataggio. L’assenza della ricevuta non conferma un mancato salvataggio.</p>
    <form action={submit}><input type="hidden" name="target" value={JSON.stringify(target)} /><input type="hidden" name="commandId" value={commandId} />
      <button className={button} disabled={!ready || pending}>Verifica esito del salvataggio</button></form><p role="status">{state.message}</p>
    {state.outcome?.status === 'RECORDED' && <a href={technicalWorkPath(target)} className="font-semibold underline">Torna al lavoro corrente</a>}
  </section>;
}

function Confirm({ preview, action, recovery, edit }: { preview: NonNullable<TechnicalWorkItemState['preview']>;
  action: TechnicalWorkItemAction; recovery: TechnicalWorkItemAction; edit: () => void }) {
  const ready = useSyncExternalStore(subscribe, client, server), [state, submit, pending] = useActionState(action, initial);
  const [sent, setSent] = useState(false), locked = !ready || sent || pending;
  return <section className="space-y-4 rounded-xl border border-blue-400 bg-blue-50 p-4" aria-label="Riepilogo attività tecnica">
    <h2 className="text-xl font-bold">Conferma le modifiche</h2>
    <div className="grid min-w-0 gap-3 sm:grid-cols-2">{Object.entries(preview.after).map(([key, value]) => <div key={key} className="min-w-0 rounded-xl bg-white p-3">
      <strong>{technicalItemFieldLabels[key]}</strong><p className="whitespace-pre-wrap break-words">Prima: {key === 'dueAt' ? operationalRomeTime(preview.before[key]) : preview.before[key] ?? '—'}</p>
      <p className="whitespace-pre-wrap break-words">Dopo: {key === 'dueAt' ? operationalRomeTime(value) : value ?? '—'}</p></div>)}</div>
    <button type="button" className="font-semibold underline disabled:opacity-50" disabled={locked} onClick={edit}>Rivedi le modifiche</button>
    <form action={submit} className="space-y-3" onSubmit={() => { const url = new URL(window.location.href);
      url.searchParams.set('itemDecision', preview.command.commandId); window.history.replaceState(window.history.state, '', url); setSent(true); }}>
      <input type="hidden" name="target" value={JSON.stringify(preview.target)} /><input type="hidden" name="command" value={JSON.stringify(preview.command)} />
      <input type="hidden" name="token" value={preview.token} />
      <label className="flex items-start gap-2"><input type="checkbox" name="confirmed" required />Confermo soltanto le modifiche riepilogate.</label>
      <button className={button} disabled={locked}>Conferma modifica dell’attività</button>
    </form><p role="status">{state.message}</p>
    {state.outcome?.status === 'RECORDED' && <a className="font-semibold underline" href={technicalWorkPath(preview.target)}>Torna al lavoro aggiornato</a>}
    {state.message && !state.ok && !state.uncertain && <a className="font-semibold underline" href={technicalWorkPath(preview.target)}>Ricarica il lavoro corrente</a>}
    {state.uncertain && <TechnicalWorkItemRecovery target={preview.target} commandId={preview.command.commandId} action={recovery} />}
  </section>;
}

export function TechnicalWorkItemForm({ target, data, initialCommandId, previewAction, confirmAction, receiptAction }: {
  target: TechnicalTargetReference; data: Data; initialCommandId: string; previewAction: TechnicalWorkItemAction;
  confirmAction: TechnicalWorkItemAction; receiptAction: TechnicalWorkItemAction }) {
  const ready = useSyncExternalStore(subscribe, client, server), [state, submit, pending] = useActionState(previewAction, initial);
  const [commandId, setCommand] = useState(initialCommandId), [selected, setSelected] = useState<string[]>([]);
  const [values, setValues] = useState<Record<string, string>>(Object.fromEntries(Object.entries(data.fields).map(([key, value]) => [key, value ?? ''])));
  const preview = state.preview?.command.commandId === commandId ? state.preview : null;
  const locked = !ready || pending || !!preview;
  const changed = () => setCommand(crypto.randomUUID());
  const command = { commandId, assignmentId: data.assignmentId, assignmentRevision: data.assignmentRevision,
    bindingId: data.bindingId, bindingRevision: data.bindingRevision, kind: data.kind, itemId: data.itemId,
    expectedContextSha256: data.expectedContextSha256, expectedItemVersion: data.expectedItemVersion,
    action: 'update_fields', patch: Object.fromEntries(selected.map(key => [key, values[key] || null])) };
  return <section className="min-w-0 space-y-4" data-technical-item-ready={ready ? 'true' : 'false'}>
    <h2 className="text-xl font-bold">Aggiorna i campi assegnati</h2>
    <form action={submit} onSubmit={event => { event.preventDefault(); const form = new FormData(event.currentTarget); startTransition(() => submit(form)); }} className="space-y-4">
      <input type="hidden" name="target" value={JSON.stringify(target)} /><input type="hidden" name="command" value={JSON.stringify(command)} />
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">{data.editableFields.map(key => <div key={key} className="min-w-0 space-y-2 rounded-xl border p-3">
        <label className="flex items-center gap-2 font-semibold"><input type="checkbox" checked={selected.includes(key)} disabled={locked}
          onChange={event => { setSelected(event.target.checked ? [...selected, key] : selected.filter(field => field !== key)); changed(); }} />Modifica {technicalItemFieldLabels[key].toLocaleLowerCase('it-IT')}</label>
        {key === 'priority' ? <select aria-label={technicalItemFieldLabels[key]} className={control} disabled={locked || !selected.includes(key)} value={values[key]}
          onChange={event => { setValues({ ...values, [key]: event.target.value }); changed(); }}>{['bassa', 'media', 'alta', 'urgente'].map(value => <option key={value} value={value}>{value}</option>)}</select>
          : key === 'dueAt' ? <RomeDateTimeInput label={technicalItemFieldLabels[key]} className={control} disabled={locked || !selected.includes(key)}
            value={values[key]} onChange={instant => { setValues({ ...values, [key]: instant }); changed(); }} />
            : <textarea aria-label={technicalItemFieldLabels[key]} className={control} rows={3} maxLength={key === 'title' ? 200 : 5000}
              disabled={locked || !selected.includes(key)} value={values[key]} onChange={event => { setValues({ ...values, [key]: event.target.value }); changed(); }} />}
      </div>)}</div>
      <button className={button} disabled={locked || !selected.length}>Prepara riepilogo dell’attività</button><p role="status">{state.message}</p>
    </form>{preview && <Confirm key={preview.token} preview={preview} action={confirmAction} recovery={receiptAction} edit={changed} />}
  </section>;
}
