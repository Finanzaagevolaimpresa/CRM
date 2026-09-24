'use client';

import { useActionState } from 'react';
import type { RoleCode } from '@prisma/client';
import { assignClientOwners, assignProjectOwner } from '@/lib/manual-assignment-actions';

export function ManualAssignmentForm({ kind, id, updatedAt, commercialOwnerId, technicalOwnerId, users }: {
  kind: 'client' | 'project'; id: string; updatedAt: string;
  commercialOwnerId?: string | null; technicalOwnerId?: string | null;
  users: Array<{ id: string; name: string; role: RoleCode }>;
}) {
  const [state, action, pending] = useActionState(kind === 'client' ? assignClientOwners : assignProjectOwner, { ok: false, message: '' });
  const sales = users.filter(user => ['admin', 'direzione', 'commerciale'].includes(user.role));
  const technicians = users.filter(user => ['admin', 'direzione', 'consulente', 'backoffice'].includes(user.role));
  return <form action={action} aria-label="Assegna responsabili" className="space-y-3">
    <input type="hidden" name="id" value={id} />
    <input type="hidden" name="updatedAt" value={updatedAt} />
    {kind === 'client' ? <label className="block">Responsabile commerciale
      <select name="commercialOwnerId" defaultValue={commercialOwnerId ?? ''} className="block w-full rounded-xl border p-3">
        <option value="">Da assegnare</option>{sales.map(user => <option key={user.id} value={user.id}>{user.name}</option>)}
      </select>
    </label> : <input type="hidden" name="commercialOwnerId" value="" />}
    <label className="block">Responsabile tecnico
      <select name="technicalOwnerId" defaultValue={technicalOwnerId ?? ''} className="block w-full rounded-xl border p-3">
        <option value="">Da assegnare</option>{technicians.map(user => <option key={user.id} value={user.id}>{user.name}</option>)}
      </select>
    </label>
    <button disabled={pending} className="rounded-xl bg-fai-green px-4 py-3 font-bold text-white disabled:opacity-50">Salva responsabili</button>
    <p role="status">{state.message}</p>
  </form>;
}
