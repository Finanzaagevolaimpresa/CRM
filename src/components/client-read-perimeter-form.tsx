'use client';

import { useActionState } from 'react';
import { updateClientReadPerimeter } from '@/lib/client-read-perimeter-actions';

export function ClientReadPerimeterForm({ userId, clientId, version, active, label }: {
  userId: string; clientId: string; version: number; active: boolean; label: string;
}) {
  const [state, action, pending] = useActionState(updateClientReadPerimeter, { ok: false, message: '' });
  return <form action={action} aria-label={`Consultazione ${label}`} className="space-y-2">
    <input type="hidden" name="userId" value={userId} />
    <input type="hidden" name="clientId" value={clientId} />
    <input type="hidden" name="expectedVersion" value={version} />
    <input type="hidden" name="active" value={active ? 'true' : 'false'} />
    <button disabled={pending} className="rounded-xl border px-3 py-2 font-bold disabled:opacity-50">{pending ? 'Salvataggio…' : active ? 'Consenti consultazione' : 'Revoca consultazione'}</button>
    {state.message ? <p role="status" className={state.ok ? 'text-green-800' : 'text-red-800'}>{state.message}</p> : null}
  </form>;
}
