'use client';

import { useActionState } from 'react';
import { acceptResponsibilityAction, saveResponsibilityAction } from '@/lib/responsibility-actions';
import type { ResponsibilityKind, ResponsibilityState } from '@/lib/responsibility-contract';

export function ResponsibilityAssignmentForm({ kind, id, entryId, updatedAt, state: current, department, users }: {
  kind: ResponsibilityKind; id: string; entryId: string; updatedAt: string; state: ResponsibilityState; department: string | null;
  users: Array<{ id: string; name: string; role: string }>;
}) {
  const [state, action, pending] = useActionState(saveResponsibilityAction, { ok: false, message: '' });
  return <form action={action} aria-label="Decisione responsabilità" className="grid gap-3">
    <input type="hidden" name="kind" value={kind} /><input type="hidden" name="id" value={id} />
    <input type="hidden" name="expectedEntryId" value={entryId} /><input type="hidden" name="expectedUpdatedAt" value={updatedAt} />
    {kind === 'TechnicalPractice' ? <>
      <label>Responsabile commerciale<select aria-label="Responsabile commerciale" name="commercialOwnerId" defaultValue={current.commercialOwnerId ?? ''} className="block rounded-xl border p-2"><option value="">Non assegnato</option>{users.filter(user => user.id === current.commercialOwnerId || ['admin', 'direzione', 'commerciale'].includes(user.role)).map(user => <option key={user.id} value={user.id}>{user.name}</option>)}</select></label>
      <label>Reparto tecnico<input name="departmentCode" maxLength={80} defaultValue={department ?? ''} className="block rounded-xl border p-2" /></label>
      <label>Referente tecnico<select aria-label="Referente tecnico" name="technicalOwnerId" defaultValue={current.technicalOwnerId ?? ''} className="block rounded-xl border p-2"><option value="">Referente da individuare</option>{users.filter(user => user.id === current.technicalOwnerId || ['admin', 'direzione', 'consulente', 'backoffice'].includes(user.role)).map(user => <option key={user.id} value={user.id}>{user.name}</option>)}</select></label>
    </> : <><input type="hidden" name="commercialOwnerId" value={current.commercialOwnerId ?? ''} /><input type="hidden" name="technicalOwnerId" value="" /><input type="hidden" name="departmentCode" value="" /><p>Conferma il responsabile corrente; per cambiarlo usa la scheda del lead o la Commercial Lead Inbox.</p></>}
    <label>Motivazione<textarea name="reason" minLength={10} maxLength={500} required className="block w-full rounded-xl border p-2" /></label>
    <button disabled={pending} className="rounded-xl border p-3 font-bold">Registra decisione</button>
    {state.message && <p role="status">{state.message}</p>}
  </form>;
}
export function ResponsibilityAcceptanceForm({ kind, id, decisionId, role }: { kind: ResponsibilityKind; id: string; decisionId: string; role: 'commerciale' | 'tecnico' }) {
  const [state, action, pending] = useActionState(acceptResponsibilityAction, { ok: false, message: '' });
  return <form action={action} aria-label={`Presa in carico ${role}`}>
    <input type="hidden" name="kind" value={kind} /><input type="hidden" name="id" value={id} /><input type="hidden" name="decisionId" value={decisionId} /><input type="hidden" name="role" value={role} />
    <button disabled={pending} className="rounded-xl border p-3 font-bold">Confermo la presa in carico {role}</button>
    {state.message && <p role="status">{state.message}</p>}
  </form>;
}
