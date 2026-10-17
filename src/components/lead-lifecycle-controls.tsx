'use client';

import { useActionState, useId, useRef } from 'react';
import { changeLeadLifecycle } from '@/lib/lead-lifecycle-actions';
import { leadLifecycleCopy, leadLifecycleReasons, type LeadLifecycleAction } from '@/lib/lead-lifecycle-policy';

export function LeadLifecycleControls({ id, updatedAt, action, title }: {
  id: string; updatedAt: string; action: LeadLifecycleAction; title: string;
}) {
  const [state, submit, pending] = useActionState(changeLeadLifecycle, { ok: false, message: '' });
  const dialog = useRef<HTMLDialogElement>(null), headingId = useId();
  const copy = leadLifecycleCopy[action];
  return <>
    <button type="button" aria-haspopup="dialog" aria-label={`${copy.label}: ${title}`}
      onClick={() => dialog.current?.showModal()} className="rounded-xl border px-3 py-2 font-bold whitespace-normal">{copy.label}</button>
    <dialog ref={dialog} aria-labelledby={headingId} onCancel={event => { if (pending) event.preventDefault(); }}
      className="fixed inset-0 rounded-2xl border bg-white p-5 text-fai-navy shadow-xl backdrop:bg-black/50"
      style={{ margin: 'auto', width: 'min(36rem, calc(100vw - 2rem))', maxHeight: 'calc(100dvh - 2rem)', overflow: 'auto', overflowWrap: 'anywhere' }}>
    <h2 id={headingId} className="text-xl font-bold">{copy.label}</h2>
    <form action={submit} aria-label={`${copy.label}: ${title}`} className="mt-3 min-w-0 space-y-3 whitespace-normal">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="updatedAt" value={updatedAt} />
      <input type="hidden" name="action" value={action} />
      <p className="font-semibold break-words">{title}</p>
      <p className="text-sm">{copy.consequence}</p>
      <label className="block text-sm">Motivo facoltativo
        <select name="reasonCode" defaultValue="" disabled={pending} className="mt-1 w-full rounded-lg border p-2">
          <option value="">Nessun motivo indicato</option>
          {Object.entries(leadLifecycleReasons).map(([code, label]) => <option key={code} value={code}>{label}</option>)}
        </select>
      </label>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="confirmed" value="yes" required disabled={pending} />Confermo queste conseguenze per questo lead</label>
      <div className="flex flex-wrap gap-3">
        <button type="button" disabled={pending} onClick={() => dialog.current?.close()} className="rounded-xl border px-4 py-2 font-bold disabled:opacity-50">Annulla</button>
        <button type="submit" disabled={pending || Boolean(state.message)} className="rounded-xl bg-fai-blue px-4 py-2 font-bold text-white disabled:opacity-50">
          {pending ? 'Operazione in corso…' : copy.label}
        </button>
      </div>
      <p role="status" className="text-sm">{state.message}</p>
    </form>
    </dialog>
  </>;
}
