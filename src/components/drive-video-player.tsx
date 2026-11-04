'use client';
import { useEffect, useState } from 'react';
import { parseDriveVideoLink } from '@/lib/drive-video-contract';

export function DriveVideoPlayer({ id, version, url, expiresAt, preview = false }: {
  id: string; version: number; url: string; expiresAt: string | null; preview?: boolean;
}) {
  const [allowed, setAllowed] = useState(true), [opened, setOpened] = useState(false), [playerError, setPlayerError] = useState(false);
  const link = parseDriveVideoLink(url);
  useEffect(() => {
    if (preview) return;
    let live = true;
    const controller = new AbortController();
    const check = async () => {
      try {
        const response = await fetch('/videos/drive/' + id + '/access', { cache: 'no-store', signal: controller.signal });
        const result = response.ok ? await response.json() as { version?: number } : null;
        if (live && (!result || result.version !== version || expiresAt && new Date(expiresAt).getTime() <= Date.now())) setAllowed(false);
      } catch { if (live) setAllowed(false); }
    };
    const interval = setInterval(check, 5000);
    const timeout = expiresAt ? setTimeout(() => setAllowed(false), Math.max(0, Math.min(2_147_483_647, new Date(expiresAt).getTime() - Date.now()))) : undefined;
    void check();
    return () => { live = false; controller.abort(); clearInterval(interval); if (timeout) clearTimeout(timeout); };
  }, [id, version, expiresAt, preview]);
  if (!allowed) return <p role="status">Riferimento non più disponibile o verifica dell’accesso non riuscita. Riapri Video per lo stato corrente.</p>;
  return <section className="space-y-3 min-w-0" aria-label="Video su Google Drive">
    <p>Il video rimane su Google Drive. Accedi con l’account Google al quale il proprietario ha concesso la visione.
      La selezione nel CRM non concede automaticamente l’accesso al file.</p>
    {!opened ? <button className="rounded-xl border p-3 font-bold" onClick={() => setOpened(true)}>Apri player Google Drive</button>
      : <iframe title="Player Google Drive" src={link.previewUrl} className="aspect-video w-full rounded-xl border"
        allow="fullscreen" allowFullScreen referrerPolicy="no-referrer" onError={() => setPlayerError(true)}/>}
    {playerError && <p role="alert">Il player non si è aperto. Prova «Apri su Google Drive» e verifica il tuo account Google.</p>}
    <p>Se Google mostra «Accesso negato», «Richiedi accesso» o richiede il login, apri il file su Drive e chiedi
      al proprietario di condividerlo con il tuo account. Il CRM non può verificare l’esito interno del player Google.</p>
    <a className="font-bold underline" href={link.viewUrl} target="_blank" rel="noopener noreferrer">Apri su Google Drive</a>
    <p className="text-sm text-slate-600">Nessun comando di download o gestione è concesso dal CRM.
      Download e accessi diretti dipendono dai permessi Google; una revoca nel CRM non revoca un accesso già concesso su Drive.</p>
    {preview && <p className="text-sm">Anteprima privata Admin: non prova l’accesso Google dei destinatari.</p>}
  </section>;
}
