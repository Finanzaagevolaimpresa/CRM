'use client';

import { useActionState } from 'react';
import { removeInternalAccount } from '@/lib/user-continuity-actions';
import { initialAccountFormState } from '@/lib/user-account-contract';

export function UserRemovalForm({ userId, disabled }: { userId: string; disabled: boolean }) {
  const [state, action, pending] = useActionState(removeInternalAccount, initialAccountFormState);
  return <form action={action} aria-label="Rimozione account" className="space-y-3">
    <input type="hidden" name="userId" value={userId} />
    <p className="text-sm">L’accesso viene revocato. Nome, storico e riferimenti restano conservati; le attività assegnate rimangono nella coda dell’amministratore fino alla riassegnazione.</p>
    <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="retainHistory" required disabled={disabled || pending} />Conservo storico e attività nella coda amministrativa.</label>
    <button disabled={disabled || pending} className="rounded-xl bg-fai-orange px-4 py-3 font-bold text-white disabled:opacity-50">Rimuovi account</button>
    {state.message ? <p role="status">{state.message}</p> : null}
  </form>;
}
