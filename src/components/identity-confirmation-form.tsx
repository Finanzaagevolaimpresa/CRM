'use client';

import { establishPrivilegedStepUpInline } from '@/lib/privileged-access-actions';
import { useState, useSyncExternalStore, useTransition, type ReactNode } from 'react';

const subscribe = () => () => {};

// A native form POST may carry an opaque Origin under the CRM's no-referrer
// policy. Submit through the hydrated same-origin action, retaining all guards.
export function IdentityConfirmationForm({ returnToInbox, children }: {
  returnToInbox: boolean; children: ReactNode;
}) {
  const ready = useSyncExternalStore(subscribe, () => true, () => false);
  const [pending, start] = useTransition();
  const [error, setError] = useState('');
  return <form className="max-w-lg crm-space-y-4" data-identity-ready={ready} aria-busy={pending}
    onSubmit={event => {
      event.preventDefault();
      if (!ready || pending) return;
      const data = new FormData(event.currentTarget);
      setError('');
      start(async () => {
        try {
          const result = await establishPrivilegedStepUpInline({ ok: false, message: '' }, data);
          if (result.ok) window.location.assign(returnToInbox ? '/leads/inbox' : '/settings/security?status=active');
          else setError(result.message);
        } catch {
          setError('Verifica lo stato della conferma dalla sessione corrente prima di riprovare.');
        }
      });
    }}>
    <fieldset disabled={!ready || pending} className="crm-space-y-4">{children}</fieldset>
    {error && <p role="alert">{error}</p>}
  </form>;
}
