'use client';

import { useRef, useState, type FormEvent } from 'react';

const confirmation = 'Richiesta registrata. Il blocco delle email promozionali è stato acquisito.';

/** Same-site screen prepared for the future public host; intentionally not mounted by R13. */
export function MarketingWithdrawalForm({ endpoint, requestId: initialRequestId }: { endpoint: string; requestId: string }) {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  // The public host supplies a fresh server-generated UUID for each uncached form render.
  // It is included in native HTML submissions as well as the enhanced JSON request.
  const [requestId, setRequestId] = useState(initialRequestId);
  const attempt = useRef<{ email: string; requestId: string } | null>(null);
  if (!/^\/(?!\/)[^\\]*$/u.test(endpoint)) throw new Error('SAME_SITE_ENDPOINT_REQUIRED');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(initialRequestId)) {
    throw new Error('SERVER_REQUEST_ID_REQUIRED');
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const email = String(new FormData(event.currentTarget).get('email') ?? '').trim();
    setBusy(true);
    setMessage('');
    try {
      const url = new URL(endpoint, window.location.origin);
      if (url.origin !== window.location.origin) throw new Error('CROSS_ORIGIN_DENIED');
      if (!attempt.current || attempt.current.email !== email) attempt.current = { email, requestId };
      const response = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        credentials: 'omit', cache: 'no-store', redirect: 'error', body: JSON.stringify(attempt.current),
      });
      if (response.status !== 200) throw new Error('REQUEST_NOT_COMMITTED');
      const result: unknown = await response.json();
      if (!result || typeof result !== 'object' || !('message' in result) || result.message !== confirmation) {
        throw new Error('RESPONSE_INVALID');
      }
      setMessage(confirmation);
      // A later click is a new withdrawal intent, including after a later re-consent.
      // Failed or uncertain attempts retain their request ID for an idempotent retry.
      attempt.current = null;
      setRequestId(crypto.randomUUID());
    } catch { setMessage('Richiesta non completata. Riprova più tardi.'); }
    finally { setBusy(false); }
  }

  return <section aria-labelledby="email-preferences-title">
    <h1 id="email-preferences-title">Preferenze email</h1>
    <p>Indica l’indirizzo per cui vuoi interrompere le email promozionali sui servizi FAI.</p>
    <form onSubmit={submit} method="post" action={endpoint}>
      <input type="hidden" name="requestId" value={requestId} />
      <label htmlFor="marketing-withdrawal-email">Indirizzo email</label>
      <input id="marketing-withdrawal-email" name="email" type="email" autoComplete="email" maxLength={254} required disabled={busy} />
      <button type="submit" disabled={busy}>Non inviarmi più email promozionali</button>
    </form>
    <p role="status" aria-live="polite">{message}</p>
  </section>;
}
