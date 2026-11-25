'use client';

import { unstable_rethrow } from 'next/navigation';
import { useState, useSyncExternalStore, useTransition, type ReactNode } from 'react';

const subscribe = () => () => {};

// A native form POST may carry an opaque Origin under the CRM's no-referrer
// policy. Submit through the hydrated same-origin action, retaining all guards.
export function IdentityConfirmationForm({ action, children }: {
  action: (data: FormData) => Promise<void>; children: ReactNode;
}) {
  const ready = useSyncExternalStore(subscribe, () => true, () => false);
  const [pending, start] = useTransition();
  const [failed, setFailed] = useState(false);
  return <form className="max-w-lg crm-space-y-4" data-identity-ready={ready} aria-busy={pending}
    onSubmit={event => {
      event.preventDefault();
      if (!ready || pending) return;
      const data = new FormData(event.currentTarget);
      setFailed(false);
      start(async () => {
        try { await action(data); }
        catch (error) {
          unstable_rethrow(error);
          setFailed(true);
        }
      });
    }}>
    <fieldset disabled={!ready || pending} className="crm-space-y-4">{children}</fieldset>
    {failed && <p role="alert">Verifica lo stato della conferma e riprova dalla sessione corrente.</p>}
  </form>;
}
