'use client';
import { useActionState } from 'react';
import { assignExceptionTask } from '@/lib/exception-task-actions';

export function ExceptionTaskForm({ id, updatedAt, assignedToId, users }: {
  id: string; updatedAt: string; assignedToId: string | null; users: Array<{ id: string; name: string }>;
}) {
  const [state, action, pending] = useActionState(assignExceptionTask, { ok: false, message: '' });
  return <form action={action} aria-label="Riassegna attività" className="space-y-4">
    <input type="hidden" name="id" value={id} /><input type="hidden" name="updatedAt" value={updatedAt} />
    <label className="block">Nuovo responsabile
      <select name="assignedToId" required defaultValue={users.some(user => user.id === assignedToId) ? assignedToId! : ''} className="block w-full rounded-xl border p-3">
        <option value="">Seleziona utente attivo</option>{users.map(user => <option key={user.id} value={user.id}>{user.name}</option>)}
      </select>
    </label>
    <button disabled={pending} className="rounded-xl bg-fai-green p-3 font-bold text-white">Riassegna attività</button>
    <p role="status">{state.message}</p>
  </form>;
}
