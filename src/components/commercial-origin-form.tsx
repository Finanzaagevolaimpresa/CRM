'use client';

import { useActionState } from 'react';
import { saveCommercialOrigin } from '@/lib/commercial-origin-actions';

export function CommercialOriginForm({ clientId, entryId, current, users }: {
  clientId: string; entryId: string | null;
  current: { acquiredById: string | null; contractedById: string | null; sourceReference: string } | null;
  users: Array<{ id: string; name: string; active: boolean; deletedAt: string | null }>;
}) {
  const [state, action, pending] = useActionState(saveCommercialOrigin, { ok: false, message: '' });
  const options = users.map(user => <option key={user.id} value={user.id}>{user.name}{user.deletedAt ? ' (rimosso)' : !user.active ? ' (sospeso)' : ''}</option>);
  return <form action={action} aria-label="Provenienza commerciale" className="grid gap-3 md:grid-cols-2">
    <input type="hidden" name="clientId" value={clientId} />
    <input type="hidden" name="expectedEntryId" value={entryId ?? ''} />
    <label>Acquisizione cliente<select name="acquiredById" defaultValue={current?.acquiredById ?? ''} className="block w-full rounded-xl border p-2"><option value="">Non documentata</option>{options}</select></label>
    <label>Contrattualizzazione<select name="contractedById" defaultValue={current?.contractedById ?? ''} className="block w-full rounded-xl border p-2"><option value="">Non documentata</option>{options}</select></label>
    <label className="md:col-span-2">Riferimento alla prova<input name="sourceReference" minLength={3} maxLength={300} required defaultValue={current?.sourceReference ?? ''} className="block w-full rounded-xl border p-2" /></label>
    <label className="md:col-span-2">{entryId ? 'Motivo della rettifica' : 'Motivo della registrazione'}<textarea name="reason" minLength={10} maxLength={1000} required className="block w-full rounded-xl border p-2" /></label>
    <button disabled={pending} className="rounded-xl border px-3 py-2 font-bold disabled:opacity-50">{pending ? 'Salvataggio…' : entryId ? 'Registra rettifica' : 'Registra provenienza'}</button>
    {state.message && <p role="status" className={state.ok ? 'text-green-800' : 'text-red-800'}>{state.message}</p>}
  </form>;
}
