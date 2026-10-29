'use client';
import { useState, useSyncExternalStore, type ReactNode } from 'react';
import { submitAdminUserCommand, checkAdminUserCommand } from '@/lib/user-actions';
import type { AdminUserCommandIdentity, AdminUserCommandState } from '@/lib/admin-user-command-contract';
import { InlinePrivilegedConfirmation } from './inline-privileged-confirmation';
import { adminUserCommandIdentity } from '@/lib/admin-user-command-contract';
const subscribe = () => () => {}, hydrated = () => true, server = () => false;
export function AdminUserForm({ identity: initial, children, className, label, disabled = false }: {
  identity: AdminUserCommandIdentity; children: ReactNode; className?: string; label: string; disabled?: boolean;
}) {
  const ready = useSyncExternalStore(subscribe, hydrated, server), [identity] = useState(initial);
  const [state, setState] = useState<AdminUserCommandState>({ ok: false, message: '' }), [pending, setPending] = useState(false);
  const frozen = !ready || disabled || pending || state.ok || state.closed || state.uncertain;
  function remember(value: boolean) {
    const url = new URL(window.location.href);
    url.hash = value ? 'account-command=' + encodeURIComponent(JSON.stringify(identity)) : '';
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
  }
  return <div><form aria-label={label} onReset={event => event.preventDefault()} onSubmit={async event => {
    event.preventDefault(); if (frozen) return;
    const element = event.currentTarget, form = new FormData(element);
    for (const [key, value] of Object.entries(identity)) form.set(key, value);
    remember(true); setPending(true);
    try {
      const result = await submitAdminUserCommand(form); setState(result);
      if (result.ok) for (const field of element.querySelectorAll<HTMLInputElement>('input[type="password"]')) field.value = '';
      // A successful action can refresh the route without its fragment. Restore
      // the same receipt reference after that response, including known success.
      remember(Boolean(result.uncertain || result.ok || result.closed));
    }
    catch { setState({ ok: false, uncertain: true, message: 'Risposta interrotta. Il riferimento è conservato nell’indirizzo della pagina: verifica l’esito.' }); }
    finally { setPending(false); }
  }}><fieldset disabled={Boolean(frozen)} className={className}>{children}</fieldset><p role="status">{state.message}</p></form>
    {state.stepUpRequired && <InlinePrivilegedConfirmation />}
    {state.uncertain && <AdminUserRecovery identity={identity} onResult={setState} />}
    {(state.ok || state.closed) && <a className="font-semibold underline" href={state.closed && identity.operation === 'CREATE' ? '/settings/users' : '/settings/users/' + identity.userId}>Riapri account e permessi</a>}
  </div>;
}
export function AdminUserRecoveryGuard({ children }: { children: ReactNode }) {
  const ready = useSyncExternalStore(subscribe, hydrated, server);
  const [saved] = useState(() => {
    if (typeof window === 'undefined' || !window.location.hash.startsWith('#account-command=')) return null;
    try { const value = adminUserCommandIdentity.safeParse(JSON.parse(decodeURIComponent(window.location.hash.slice(17)))); return value.success ? value.data : null; }
    catch { return null; }
  });
  return ready && saved ? <AdminUserRecovery identity={saved} /> : children;
}
export function AdminUserRecovery({ identity, onResult }: { identity: AdminUserCommandIdentity; onResult?: (state: AdminUserCommandState) => void }) {
  const [state, setState] = useState<AdminUserCommandState | null>(null), [pending, setPending] = useState(false), [confirmed, setConfirmed] = useState(false);
  async function check(close: boolean) {
    if (pending) return; setPending(true);
    try { const result = await checkAdminUserCommand(identity, close); setState(result); onResult?.(result); }
    catch { setState({ ok: false, uncertain: true, message: 'Verifica non disponibile. Nessun comando ripetuto.' }); }
    finally { setPending(false); }
  }
  return <section aria-label="Verifica operazione account" className="space-y-3 rounded-xl border border-amber-300 p-4">
    <p>Riferimento: <code>{identity.commandId}</code>. La verifica non ripete il salvataggio.</p>
    <button type="button" disabled={pending} className="underline" onClick={() => void check(false)}>Verifica esito account</button>
    {!state?.ok && !state?.closed && <><label className="flex gap-2"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />Riconcilia le richieste in corso e chiudi il tentativo solo se non è registrato.</label>
      <button type="button" disabled={pending || !confirmed} className="underline" onClick={() => void check(true)}>Riconcilia e chiudi tentativo account</button></>}
    <p role="status">{state?.message}</p>
    {(state?.ok || state?.closed) && <a className="underline" href={state.closed && identity.operation === 'CREATE' ? '/settings/users' : '/settings/users/' + identity.userId}>Riapri account e permessi</a>}
  </section>;
}
