'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function ManualMessageDownload({ messageId, revision, snapshotHash, requestId, resume = false }: {
  messageId: string; revision: number; snapshotHash: string; requestId: string; resume?: boolean;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const router = useRouter();
  return <form onSubmit={async event => {
    event.preventDefault(); if (busy) return;
    setBusy(true); setError('');
    const data = new FormData(); data.set('expectedRevision', String(revision)); data.set('snapshotHash', snapshotHash); data.set('requestId', requestId);
    try {
      const response = await fetch(`/communications/${messageId}/package`, { method: 'POST', body: data });
      if (!response.ok) { setError(await response.text()); return; }
      const blob = await response.blob();
      const actualHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))).map(byte => byte.toString(16).padStart(2, '0')).join('');
      if (actualHash !== response.headers.get('X-FAI-Artifact-SHA256')) { setError('Integrità del pacchetto non confermata. Riconcilia il tentativo aperto.'); router.refresh(); return; }
      const url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = `messaggio-approvato-${messageId}.zip`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000); router.refresh();
    } catch { setError('Ricezione del pacchetto non confermata. Aggiorna la pagina e riconcilia il tentativo; non avviarne un altro.'); }
    finally { setBusy(false); }
  }}>
    <button disabled={busy} className="rounded-xl bg-fai-blue px-4 py-2 font-bold text-white disabled:opacity-50">{busy ? 'Preparazione in corso…' : resume ? 'Riscarica lo stesso pacchetto' : 'Prepara invio manuale e scarica'}</button>
    {error ? <p role="alert" className="mt-2 text-red-700">{error}</p> : null}
  </form>;
}
