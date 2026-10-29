'use client';
import { startTransition, useActionState, useState, useSyncExternalStore } from 'react';
import { technicalManagementPath, type TechnicalTargetReference } from '@/lib/technical-assignment-display';
import type { TechnicalPrivateItemCommand } from '@/lib/technical-private-item-contract';
import type { TechnicalPrivateItemAction, TechnicalPrivateItemState } from '@/lib/technical-private-item-ui-state';
import { RomeDateTimeInput } from './rome-date-time-input';
import { operationalRomeTime } from '@/lib/operational-time';
import { InlinePrivilegedConfirmation } from './inline-privileged-confirmation';

const initial: TechnicalPrivateItemState = { ok: false, message: '' };
const subscribe = () => () => {}, client = () => true, server = () => false;
const button = 'rounded-xl bg-blue-900 px-4 py-3 font-semibold text-white disabled:opacity-50';
const control = 'block w-full min-w-0 rounded-xl border border-slate-300 bg-white p-3';
export function TechnicalPrivateItemRecovery({ target, commandId, action }: {
  target: TechnicalTargetReference; commandId: string; action: TechnicalPrivateItemAction }) {
  const ready = useSyncExternalStore(subscribe, client, server), [state, submit, pending] = useActionState(action, initial);
  return <section aria-label="Verifica creazione privata" className="space-y-3 rounded-xl border border-amber-400 bg-amber-50 p-4">
    <p>Verifica la ricevuta della creazione precedente. Una ricevuta non osservata non conferma che il salvataggio sia fallito.</p>
    <form action={submit}><input type="hidden" name="target" value={JSON.stringify(target)} />
      <input type="hidden" name="commandId" value={commandId} /><button className={button} disabled={!ready || pending}>Verifica esito della creazione</button></form>
    <p role="status">{state.message}</p>{state.outcome?.status === 'RECORDED' &&
      <a className="font-semibold underline" href={technicalManagementPath(target)}>Scegli persone e perimetri</a>}
  </section>;
}
function Confirm({ preview, action, recovery, edit, renew, preparing }: { preview: NonNullable<TechnicalPrivateItemState['preview']>;
  action: TechnicalPrivateItemAction; recovery: TechnicalPrivateItemAction; edit: () => void; renew: () => void; preparing: boolean }) {
  const ready = useSyncExternalStore(subscribe, client, server), [state, submit, pending] = useActionState(async (previous: TechnicalPrivateItemState, form: FormData) => {
    const result = await action(previous, form);
    if (result.stepUpRequired !== undefined) { const url = new URL(window.location.href); url.searchParams.delete('privateItemDecision'); window.history.replaceState(window.history.state, '', url); }
    return result;
  }, initial);
  const [sent, setSent] = useState(false), locked = !ready || sent || pending || preparing, c = preview.command;
  return <section aria-label="Riepilogo creazione privata" className="min-w-0 space-y-4 rounded-xl border border-blue-400 bg-blue-50 p-4">
    <h2 className="text-xl font-bold">Conferma la creazione privata</h2>
    <dl className="min-w-0 space-y-2"><dt className="font-semibold">Tipo</dt><dd>{c.kind === 'Task' ? 'Attività' : 'Voce checklist'}</dd>
      <dt className="font-semibold">Titolo</dt><dd className="whitespace-pre-wrap break-words">{c.values.title}</dd>
      <dt className="font-semibold">{c.kind === 'Task' ? 'Descrizione' : 'Note'}</dt><dd className="whitespace-pre-wrap break-words">{(c.kind === 'Task' ? c.values.description : c.values.notes) || '—'}</dd>
      {c.kind === 'Task' && <><dt className="font-semibold">Priorità</dt><dd>{c.values.priority}</dd><dt className="font-semibold">Scadenza</dt><dd>{operationalRomeTime(c.values.dueAt)}</dd></>}
    </dl><p>L’elemento appartiene solo a questo progetto o pratica. La scelta di persone e permessi avviene separatamente.</p>
    <button type="button" disabled={locked} className="font-semibold underline disabled:opacity-50" onClick={edit}>Rivedi il contenuto</button>
    <form action={submit} className="space-y-3" onReset={event => event.preventDefault()} onSubmit={() => { const url = new URL(window.location.href);
      url.searchParams.set('privateItemDecision', c.commandId); window.history.replaceState(window.history.state, '', url); setSent(true); }}>
      <input type="hidden" name="command" value={JSON.stringify(c)} /><input type="hidden" name="token" value={preview.token} />
      <label className="flex items-start gap-2"><input type="checkbox" name="confirmed" required />Confermo il contenuto e la creazione privata.</label>
      <button className={button} disabled={locked}>Crea elemento privato</button></form><p role="status">{state.message}</p>
    {state.stepUpRequired && <InlinePrivilegedConfirmation />}
    {state.stepUpRequired !== undefined && <button type="button" className="font-semibold underline" disabled={pending || preparing} onClick={renew}>Aggiorna riepilogo dopo la conferma</button>}
    {state.outcome?.status === 'RECORDED' && <a className="font-semibold underline" href={technicalManagementPath(c.target)}>Scegli persone e perimetri</a>}
    {state.outcome?.status === 'RECORDED' && <a className="font-semibold underline" href={`/admin/records/${c.kind === 'Task' ? 'Task' : 'DocumentChecklistItem'}/${c.itemId}`}>Riapri elemento e correzioni Admin</a>}
    {state.uncertain && <TechnicalPrivateItemRecovery target={c.target} commandId={c.commandId} action={recovery} />}
  </section>;
}
export function TechnicalPrivateItemForm({ target, contextSha256, initialCommandId, initialItemId, previewAction, confirmAction, receiptAction }: {
  target: TechnicalTargetReference; contextSha256: string; initialCommandId: string; initialItemId: string;
  previewAction: TechnicalPrivateItemAction; confirmAction: TechnicalPrivateItemAction; receiptAction: TechnicalPrivateItemAction }) {
  const ready = useSyncExternalStore(subscribe, client, server), [state, submit, pending] = useActionState(previewAction, initial);
  const [identity, setIdentity] = useState({ commandId: initialCommandId, itemId: initialItemId });
  const [kind, setKind] = useState<'Task' | 'ChecklistItem'>('Task'), [title, setTitle] = useState(''), [text, setText] = useState('');
  const [priority, setPriority] = useState<'bassa' | 'media' | 'alta' | 'urgente'>('media'), [dueAt, setDueAt] = useState('');
  const preview = state.preview?.command.commandId === identity.commandId ? state.preview : null, locked = !ready || pending || !!preview;
  const common = { ...identity, target, expectedContextSha256: contextSha256 };
  const date = dueAt ? new Date(dueAt) : null, invalidDate = date !== null && !Number.isFinite(date.getTime());
  const command: TechnicalPrivateItemCommand = kind === 'Task'
    ? { ...common, kind, values: { title, description: text || null, priority, dueAt: date && !invalidDate ? date.toISOString() : null } }
    : { ...common, kind, values: { title, notes: text || null } };
  return <section className="min-w-0 space-y-4" data-private-item-ready={ready ? 'true' : 'false'}>
    <form action={submit} className="space-y-4" onSubmit={event => { event.preventDefault(); const form = new FormData(event.currentTarget); startTransition(() => submit(form)); }}>
      <input type="hidden" name="command" value={JSON.stringify(command)} />
      <label className="block space-y-2">Tipo di elemento<select aria-label="Tipo di elemento" className={control} disabled={locked} value={kind}
        onChange={e => setKind(e.target.value as typeof kind)}><option value="Task">Attività</option><option value="ChecklistItem">Voce checklist</option></select></label>
      <label className="block space-y-2">Titolo<input className={control} value={title} required maxLength={200} disabled={locked} onChange={e => setTitle(e.target.value)} /></label>
      <label className="block space-y-2">{kind === 'Task' ? 'Descrizione' : 'Note'}<textarea className={control} value={text} rows={4} maxLength={5000} disabled={locked} onChange={e => setText(e.target.value)} /></label>
      {kind === 'Task' && <div className="grid min-w-0 gap-4 sm:grid-cols-2"><label className="block space-y-2">Priorità<select aria-label="Priorità" className={control} disabled={locked} value={priority}
        onChange={e => setPriority(e.target.value as typeof priority)}>{['bassa', 'media', 'alta', 'urgente'].map(p => <option key={p} value={p}>{p}</option>)}</select></label>
        <RomeDateTimeInput label="Scadenza facoltativa" className={control} value={dueAt} disabled={locked} onChange={setDueAt} /></div>}
      <button className={button} disabled={locked || !title.trim() || (kind === 'Task' && invalidDate)}>Prepara riepilogo</button><p role="status">{state.message}</p>
    </form>{state.stepUpRequired && <InlinePrivilegedConfirmation />}{preview && <Confirm key={preview.token} preview={preview} action={confirmAction} recovery={receiptAction}
      edit={() => setIdentity({ commandId: crypto.randomUUID(), itemId: crypto.randomUUID() })} preparing={pending}
      renew={() => { const form = new FormData(); form.set('command', JSON.stringify(command)); startTransition(() => submit(form)); }} />}
  </section>;
}
