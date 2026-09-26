'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { PrimaryButton } from './actions';

export function EngagementWorkDownload({ dossierId, versionId, packageId }: { dossierId: string; versionId: string; packageId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  async function download(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const body = new URLSearchParams();
    for (const [name, value] of form) if (typeof value === 'string') body.set(name, value);
    setBusy(true); setMessage('');
    try {
      // CORS-mode fetch preserves Origin with the application's no-referrer policy.
      // The URL is fixed to this origin; redirects and cross-origin credentials are disallowed.
      const response = await fetch(`/client-dossiers/${encodeURIComponent(dossierId)}/work-export`, {
        method: 'POST', body, mode: 'cors', credentials: 'same-origin', redirect: 'error',
        referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(45_000),
      });
      if (!response.ok || response.headers.get('content-type') !== 'application/zip'
        || response.headers.get('x-work-package-id') !== packageId) throw new Error('DOWNLOAD_DENIED');
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url; link.download = `work-${packageId}.zip`;
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      setMessage('Pacchetto pronto. Il risultato potrà essere registrato come nuova bozza.');
      router.refresh();
    } catch {
      setMessage('Download non completato. Riapri il dossier per verificare versione, permessi e ricevute prima di riprovare.');
    } finally { setBusy(false); }
  }
  return <form method="post" action={`/client-dossiers/${encodeURIComponent(dossierId)}/work-export`} onSubmit={download} className="my-4 grid gap-3">
    <input type="hidden" name="expectedVersionId" value={versionId}/><input type="hidden" name="packageId" value={packageId}/>
    <label className="flex items-center gap-2"><input type="checkbox" name="manualTransferAuthorized" required disabled={busy}/>Confermo la lavorazione manuale autorizzata dei materiali in Work.</label>
    <PrimaryButton type="submit" disabled={busy}>{busy ? 'Preparazione pacchetto…' : 'Scarica pacchetto Work'}</PrimaryButton>
    {message ? <p role="status">{message}</p> : null}
  </form>;
}
