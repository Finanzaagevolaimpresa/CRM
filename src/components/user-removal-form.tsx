'use client';

import { useActionState, useSyncExternalStore } from 'react';
import { removeInternalAccount, restoreInternalAccount } from '@/lib/user-continuity-actions';
import { InlinePrivilegedConfirmation } from './inline-privileged-confirmation';
import { initialAccountFormState } from '@/lib/user-account-contract';

const subscribeReady = () => () => {};
const browserReady = () => true;
const serverReady = () => false;

export function UserRemovalForm({ userId, disabled }: { userId: string; disabled: boolean }) {
  const ready = useSyncExternalStore(subscribeReady, browserReady, serverReady);
  const [state, action, pending] = useActionState(removeInternalAccount, initialAccountFormState);
  const blocked = !ready || disabled || pending;
  return <div><form action={action} onReset={event => event.preventDefault()} aria-label="Rimozione account" className="crm-space-y-3" data-interactive-ready={ready} aria-busy={pending}>
    <input type="hidden" name="userId" value={userId} />
    <p className="text-sm">L’accesso viene revocato. Nome, storico e riferimenti restano conservati; le attività assegnate rimangono nella coda dell’amministratore fino alla riassegnazione.</p>
    <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="retainHistory" required disabled={blocked} />Conservo storico e attività nella coda amministrativa.</label>
    <button disabled={blocked} className="rounded-xl bg-fai-orange px-4 py-3 font-bold text-white disabled:opacity-50">Rimuovi account</button>
    {state.message ? <p role="status">{state.message}</p> : null}
  </form>{state.stepUpRequired && <InlinePrivilegedConfirmation />}</div>;
}

export function UserRestorationForm({ userId }: { userId: string }) {
  const ready = useSyncExternalStore(subscribeReady, browserReady, serverReady);
  const [state, action, pending] = useActionState(restoreInternalAccount, initialAccountFormState);
  return <div className="crm-space-y-3"><form action={action} onReset={event => event.preventDefault()} aria-label="Ripristino account" className="crm-space-y-3">
    <input type="hidden" name="userId" value={userId} />
    <p>Ripristina la stessa identità e lo storico. L’account resta disattivato; le sessioni revocate restano chiuse.</p>
    <label className="flex items-start gap-2"><input type="checkbox" name="restoreInactive" required disabled={!ready || pending || state.ok} />Ripristino l’identità conservando l’accesso disattivato.</label>
    <button disabled={!ready || pending || state.ok} className="rounded-xl bg-fai-green px-4 py-3 font-bold text-white">Ripristina account disattivato</button>
    <p role="status">{state.message}</p>
  </form>{state.stepUpRequired && <InlinePrivilegedConfirmation />}
    {state.ok && <a href={`/settings/users/${userId}`} className="font-semibold underline">Rivedi account e permessi</a>}
  </div>;
}
