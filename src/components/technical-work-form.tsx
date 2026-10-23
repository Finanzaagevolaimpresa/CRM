'use client';

import { useActionState, useState } from 'react';
import type { readTechnicalWork } from '@/lib/technical-assignment-access';
import type { previewTechnicalWork, readTechnicalWorkOutcome } from '@/lib/technical-work-service';
import { technicalWorkPath, type TechnicalTargetReference } from '@/lib/technical-assignment-display';

type Data = Awaited<ReturnType<typeof readTechnicalWork>>;
export type TechnicalWorkState = { ok: boolean; message: string; uncertain?: boolean;
  preview?: Awaited<ReturnType<typeof previewTechnicalWork>>; outcome?: Awaited<ReturnType<typeof readTechnicalWorkOutcome>> };
export type TechnicalWorkAction = (previous: TechnicalWorkState, form: FormData) => Promise<TechnicalWorkState>;
const initial: TechnicalWorkState = { ok: false, message: '' };
const button = 'rounded-xl bg-blue-900 px-4 py-3 font-semibold text-white disabled:opacity-50';
const control = 'block w-full min-w-0 rounded-xl border border-slate-300 bg-white p-3 disabled:bg-slate-100';
const dateFields = new Set(['dueDate', 'submittedAt', 'nextClientUpdateAt']);
const statuses = { Project: ['idea', 'raccolta_dati', 'in_analisi', 'preanalisi_pronta', 'dossier_pronto', 'pratica_attiva', 'chiuso'],
  TechnicalPractice: ['da_progettare', 'in_progettazione', 'documenti_richiesti', 'documenti_completi', 'pronta_presentazione',
    'presentata', 'integrazione_richiesta', 'in_istruttoria', 'approvata', 'respinta'] } as const;

export function TechnicalWorkRecovery({ target, commandId, action }: { target: TechnicalTargetReference; commandId: string; action: TechnicalWorkAction }) {
  const [state, submit, pending] = useActionState(action, initial);
  return <section className="space-y-3 rounded-xl border border-amber-400 bg-amber-50 p-4" aria-label="Verifica esito del lavoro tecnico">
    <p>Un salvataggio è stato preparato. Verifica l’esito prima di ripeterlo.</p>
    <form action={submit}><input type="hidden" name="target" value={JSON.stringify(target)} />
      <input type="hidden" name="commandId" value={commandId} /><button className={button} disabled={pending}>Verifica esito del salvataggio</button></form>
    <p role="status">{state.message}</p>
    {state.outcome?.status === 'RECORDED' && <a href={technicalWorkPath(target)} className="font-semibold underline">Ricarica il lavoro corrente</a>}
  </section>;
}

function Confirmation({ preview, action, recovery, edit }: { preview: NonNullable<TechnicalWorkState['preview']>;
  action: TechnicalWorkAction; recovery: TechnicalWorkAction; edit: () => void }) {
  const [state, submit, pending] = useActionState(action, initial), [sent, setSent] = useState(false);
  const locked = sent || pending;
  return <section className="space-y-4 rounded-xl border border-blue-400 bg-blue-50 p-4" aria-label="Riepilogo modifica tecnica">
    <h3 className="text-lg font-bold">Riepilogo della modifica</h3>
    <div className="grid min-w-0 gap-3 sm:grid-cols-2">{preview.fields.map(field => <div key={field.key} className="min-w-0 rounded-xl bg-white p-3">
      <strong>{field.label}</strong><p className="whitespace-pre-wrap break-words">Prima: {preview.before.find(row => row.key === field.key)?.value ?? '—'}</p>
      <p className="whitespace-pre-wrap break-words">Dopo: {field.value ?? '—'}</p></div>)}</div>
    <p>Il salvataggio mantiene il referente commerciale e gli altri incarichi. Eventuali regole di aggiornamento già abilitate dall’Admin restano soggette ai loro permessi; nessuna email viene inviata da questo comando.</p>
    <button type="button" className="font-semibold underline disabled:opacity-50" disabled={locked} onClick={edit}>Rivedi le modifiche prima della conferma</button>
    <form action={submit} onSubmit={() => {
      const url = new URL(window.location.href); url.searchParams.set('workDecision', preview.command.commandId);
      window.history.replaceState(window.history.state, '', url); setSent(true);
    }} className="space-y-3">
      <input type="hidden" name="target" value={JSON.stringify(preview.target)} />
      <input type="hidden" name="command" value={JSON.stringify(preview.command)} /><input type="hidden" name="token" value={preview.token} />
      <label className="flex items-start gap-2"><input type="checkbox" name="confirmed" required />Confermo soltanto le modifiche riepilogate.</label>
      <button className={button} disabled={locked}>{pending ? 'Salvataggio in corso…' : 'Conferma modifica tecnica'}</button>
    </form><p role="status">{state.message}</p>
    {state.outcome?.status === 'RECORDED' && <a className="font-semibold underline" href={technicalWorkPath(preview.target)}>Ricarica il lavoro corrente</a>}
    {state.message && !state.ok && !state.uncertain && <a className="font-semibold underline" href={technicalWorkPath(preview.target)}>Ricarica e prepara una nuova modifica</a>}
    {state.uncertain && <TechnicalWorkRecovery target={preview.target} commandId={preview.command.commandId} action={recovery} />}
  </section>;
}

export function TechnicalWorkForm({ data, commandId: initialId, previewAction, confirmAction, receiptAction }:
  { data: Data; commandId: string; previewAction: TechnicalWorkAction; confirmAction: TechnicalWorkAction; receiptAction: TechnicalWorkAction }) {
  const [state, submit, pending] = useActionState(previewAction, initial);
  const [commandId, setCommandId] = useState(initialId), [action, setAction] = useState<'update_fields' | 'update_status'>(
    data.actions.includes('update_fields') ? 'update_fields' : 'update_status');
  const [selected, setSelected] = useState<string[]>([]), [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(data.fields.map(field => [field.key, field.value ?? ''])));
  const [error, setError] = useState('');
  const editable = data.fields.filter(field => data.editableFields.some(key => key === field.key));
  const preview = state.preview?.command.commandId === commandId ? state.preview : null;
  const locked = pending || !!preview;
  function changed() { setCommandId(crypto.randomUUID()); setError(''); }
  return <section className="min-w-0 space-y-4" aria-label="Lavora sul tuo incarico">
    <h2 className="text-xl font-bold">Aggiorna il lavoro tecnico</h2>
    <form action={submit} onReset={event => event.preventDefault()} onSubmit={event => {
      if (action === 'update_fields' && !selected.length) { event.preventDefault(); setError('Scegli almeno un campo da modificare.'); }
    }} className="space-y-4">
      <input type="hidden" name="target" value={JSON.stringify(data.target)} />
      <input type="hidden" name="command" value={JSON.stringify({ commandId, assignmentId: data.assignmentId,
        assignmentRevision: data.assignmentRevision, expectedContextSha256: data.contextSha256, expectedTargetSha256: data.targetSha256,
        action, patch: action === 'update_status' ? { status: values.status } : Object.fromEntries(selected.map(key => [key, values[key] || null])) })} />
      <label className="block font-semibold">Operazione<select className={control} value={action} disabled={locked} onChange={event => {
        setAction(event.target.value as typeof action); changed();
      }}>{data.actions.includes('update_fields') && <option value="update_fields">Modifica i campi scelti</option>}
        {data.actions.includes('update_status') && <option value="update_status">Aggiorna lo stato</option>}</select></label>
      {action === 'update_status' ? <label className="block">Nuovo stato<select className={control} value={values.status ?? ''} disabled={locked}
        onChange={event => { setValues({ ...values, status: event.target.value }); changed(); }}>
        <option value="">Scegli uno stato</option>{statuses[data.target.kind].map(status => <option key={status} value={status}>{status.replaceAll('_', ' ')}</option>)}</select></label>
        : <div className="grid min-w-0 gap-3 sm:grid-cols-2">{editable.map(field => <div key={field.key} className="min-w-0 space-y-2 rounded-xl border p-3">
          <label className="flex items-center gap-2 font-semibold"><input type="checkbox" checked={selected.includes(field.key)} disabled={locked}
            onChange={event => { setSelected(event.target.checked ? [...selected, field.key] : selected.filter(key => key !== field.key)); changed(); }} />Modifica {field.label.toLocaleLowerCase('it-IT')}</label>
          {field.key === 'priority' ? <select aria-label={field.label} className={control} disabled={locked || !selected.includes(field.key)} value={values[field.key]}
            onChange={event => { setValues({ ...values, [field.key]: event.target.value }); changed(); }}>{['bassa', 'media', 'alta', 'urgente'].map(value => <option key={value} value={value}>{value}</option>)}</select>
            : dateFields.has(field.key) ? <input aria-label={field.label} type="datetime-local" className={control} disabled={locked || !selected.includes(field.key)}
              value={values[field.key] ? new Date(new Date(values[field.key]).getTime() - new Date(values[field.key]).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : ''}
              onChange={event => { setValues({ ...values, [field.key]: event.target.value ? new Date(event.target.value).toISOString() : '' }); changed(); }} />
              : <textarea aria-label={field.label} rows={3} maxLength={5000} className={control} disabled={locked || !selected.includes(field.key)}
                value={values[field.key]} onChange={event => { setValues({ ...values, [field.key]: event.target.value }); changed(); }} />}
        </div>)}</div>}
      <button className={button} disabled={locked}>Prepara riepilogo della modifica</button>
      <p role="status">{error || state.message}</p>
    </form>
    {preview && <Confirmation preview={preview} action={confirmAction} recovery={receiptAction} edit={changed} />}
  </section>;
}
