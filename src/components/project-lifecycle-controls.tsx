'use client';

import { useActionState } from 'react';
import { changeProjectLifecycle } from '@/lib/project-lifecycle-actions';
import { lifecycleActionCopy, type ProjectLifecycleAction, type ProjectLifecycleState } from '@/lib/project-lifecycle-policy';

function LifecycleAction({ id, updatedAt, action }: { id: string; updatedAt: string; action: ProjectLifecycleAction }) {
  const [state, submit, pending] = useActionState(changeProjectLifecycle, { ok: false, message: '' });
  const copy = lifecycleActionCopy[action];
  return <details className="rounded-xl border p-3">
    <summary className="cursor-pointer font-bold">{copy.label}</summary>
    <form action={submit} aria-label={copy.label} className="mt-3 space-y-3">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="updatedAt" value={updatedAt} />
      <input type="hidden" name="action" value={action} />
      <p className="text-sm">{copy.consequence}</p>
      <label className="flex items-start gap-2"><input type="checkbox" name="confirmed" value="yes" required disabled={pending} />Confermo queste conseguenze</label>
      <button type="submit" disabled={pending} className="rounded-xl bg-fai-blue px-4 py-2 font-bold text-white disabled:opacity-50">{pending ? 'Operazione in corso…' : copy.label}</button>
      <p role="status">{state.message}</p>
    </form>
  </details>;
}
export function ProjectLifecycleControls({ id, updatedAt, state }: { id: string; updatedAt: string; state: ProjectLifecycleState }) {
  const actions: ProjectLifecycleAction[] = state === 'trash' ? ['restore'] : state === 'archived' ? ['reactivate', 'trash'] : ['archive', 'trash'];
  return <div className="space-y-3">{actions.map(action => <LifecycleAction key={`${action}:${updatedAt}`} id={id} updatedAt={updatedAt} action={action} />)}</div>;
}
