'use client';

import { useActionState } from 'react';
import { changeLeadLifecycle } from '@/lib/lead-lifecycle-actions';
import { leadLifecycleCopy, leadLifecycleReasons, type LeadLifecycleAction } from '@/lib/lead-lifecycle-policy';

export function LeadLifecycleControls({ id, updatedAt, action, title }: {
  id: string; updatedAt: string; action: LeadLifecycleAction; title: string;
}) {
  const [state, submit, pending] = useActionState(changeLeadLifecycle, { ok: false, message: '' });
  const copy = leadLifecycleCopy[action];
  return <details className="max-w-xl rounded-xl border p-3">
    <summary className="cursor-pointer font-bold">{copy.label}</summary>
    <form action={submit} aria-label={`${copy.label}: ${title}`} className="mt-3 space-y-3 whitespace-normal">
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
      <button type="submit" disabled={pending || Boolean(state.message)} className="rounded-xl bg-fai-blue px-4 py-2 font-bold text-white disabled:opacity-50">
        {pending ? 'Operazione in corso…' : copy.label}
      </button>
      <p role="status" className="text-sm">{state.message}</p>
    </form>
  </details>;
}
