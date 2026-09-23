'use client';

import { useActionState } from 'react';
import { adminResetPassword, revokeAllAccountSessions, saveAccountProfile, saveOwnPassword } from '@/lib/user-account-actions';
import { initialAccountFormState } from '@/lib/user-account-contract';

const field = 'block w-full rounded-xl border p-3';
const button = 'rounded-xl bg-fai-green px-4 py-3 font-bold text-white disabled:opacity-50';

export function UserAccountForms({ user, own, admin, available }: {
  user: { id: string; name: string; email: string }; own: boolean; admin: boolean; available: boolean;
}) {
  const [profileState, profileAction, profilePending] = useActionState(saveAccountProfile, initialAccountFormState);
  const [passwordState, passwordAction, passwordPending] = useActionState(own ? saveOwnPassword : adminResetPassword, initialAccountFormState);
  const [revokeState, revokeAction, revokePending] = useActionState(revokeAllAccountSessions, initialAccountFormState);
  if (!available) return <p role="status">La gestione del profilo e delle sessioni non è disponibile. Contatta un amministratore.</p>;
  return <div className="space-y-6">
    <form action={profileAction} aria-label="Modifica profilo" className="space-y-3">
      <h3 className="text-lg font-bold">Dati professionali</h3>
      <input type="hidden" name="userId" value={user.id} />
      <label className="block">Nome<input className={field} name="name" defaultValue={user.name} required maxLength={120} /></label>
      <label className="block">Email di accesso<input className={field} name="email" type="email" defaultValue={user.email} required readOnly={!admin} maxLength={254} /></label>
      {admin && <p className="text-sm">Il cambio dell’email revoca tutte le sessioni dell’account.</p>}
      <button className={button} disabled={profilePending}>Salva profilo</button>
      <p role="status">{profileState.message}</p>
    </form>
    <form action={passwordAction} aria-label={own ? 'Cambia password' : 'Reimposta password'} className="space-y-3">
      <h3 className="text-lg font-bold">{own ? 'Cambia password' : 'Reimposta password'}</h3>
      <input type="hidden" name="userId" value={user.id} />
      {own && <label className="block">Password attuale<input className={field} type="password" name="currentPassword" autoComplete="current-password" required /></label>}
      <label className="block">Nuova password<input className={field} type="password" name="password" autoComplete="new-password" minLength={12} maxLength={72} required /></label>
      <label className="block">Conferma password<input className={field} type="password" name="confirmation" autoComplete="new-password" minLength={12} maxLength={72} required /></label>
      <p className="text-sm">Usa almeno 12 caratteri. La modifica revoca tutte le sessioni, anche sugli altri dispositivi.{own ? ' Dovrai accedere nuovamente.' : ''}</p>
      <button className={button} disabled={passwordPending}>{own ? 'Aggiorna password' : 'Reimposta password'}</button>
      <p role="status">{passwordState.message}</p>
    </form>
    <form action={revokeAction} aria-label="Revoca sessioni" className="space-y-3">
      <input type="hidden" name="userId" value={user.id} />
      <h3 className="text-lg font-bold">Accessi aperti</h3>
      <p className="text-sm">Chiudi tutte le sessioni dell’account.{own ? ' Anche questa sessione verrà chiusa.' : ' Il prossimo accesso richiederà la password.'}</p>
      <button className={button} disabled={revokePending}>Revoca tutte le sessioni</button>
      <p role="status">{revokeState.message}</p>
    </form>
  </div>;
}
