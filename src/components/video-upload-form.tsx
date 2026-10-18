'use client';

import Link from 'next/link';
import { useRef, useState, useSyncExternalStore } from 'react';
import { videoMaxBytes } from '@/lib/video-file-contract';

type UploadReply = { ok: true; videoId: string } | { ok: false; message: string };
const subscribe = () => () => {}, ready = () => true, server = () => false;

/** The supplied server actions own current Admin/step-up checks, the immutable
 * upload command, quota reservation, byte verification and draft creation. */
export function VideoUploadForm({ commandId, actions }: { commandId: string; actions: {
  upload: (form: FormData) => Promise<UploadReply>;
  verify: (commandId: string) => Promise<UploadReply>;
} }) {
  const interactive = useSyncExternalStore(subscribe, ready, server);
  const pending = useRef(false);
  const [busy, setBusy] = useState(false), [submitted, setSubmitted] = useState(false);
  const [videoId, setVideoId] = useState<string | null>(null), [message, setMessage] = useState('');
  function receive(reply: UploadReply) {
    if (reply.ok && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(reply.videoId)) {
      setVideoId(reply.videoId); setMessage('File caricato. La bozza è privata finché non confermi la pubblicazione.');
    } else setMessage(reply.ok ? 'Esito da verificare.' : reply.message);
  }
  async function upload(form: FormData) {
    if (pending.current || submitted || !interactive) return;
    const file = form.get('file');
    if (!(file instanceof File) || file.size < 12 || file.size > videoMaxBytes || !/\.(mp4|webm)$/i.test(file.name)) {
      setMessage('Scegli un video MP4 o WebM, massimo 20 MiB.'); return;
    }
    pending.current = true; setBusy(true); setSubmitted(true); setMessage('Caricamento in corso…');
    form.set('commandId', commandId);
    try { receive(await actions.upload(form)); }
    catch { setMessage('Risposta non ricevuta. Verifica l’esito prima di caricare di nuovo il file.'); }
    finally { pending.current = false; setBusy(false); }
  }
  async function verify() {
    if (pending.current || !submitted || videoId) return;
    pending.current = true; setBusy(true);
    try { receive(await actions.verify(commandId)); }
    catch { setMessage('Verifica non disponibile. Mantieni questa pagina e riprova la verifica più tardi.'); }
    finally { pending.current = false; setBusy(false); }
  }
  return <section aria-label="Carica video" data-interactive-ready={interactive} className="min-w-0 space-y-4 rounded-xl border p-4">
    <h2 className="text-lg font-bold">Nuovo video</h2>
    <p>MP4 o WebM, massimo 20 MiB per file. La libreria ha una quota di 1 GiB, inclusi file in bozza, archiviati e caricamenti da riconciliare.</p>
    <form action={upload} className="min-w-0 space-y-3">
      <label className="block font-bold">Video da caricare<input type="file" name="file" accept=".mp4,.webm" required
        disabled={!interactive || busy || submitted} className="mt-2 block w-full max-w-full font-normal"/></label>
      <button disabled={!interactive || busy || submitted} className="rounded-xl bg-fai-green px-4 py-2 font-bold text-white disabled:opacity-50">Carica come bozza privata</button>
    </form>
    <p className="text-sm">Serve la <Link href="/settings/security" className="underline">conferma amministrativa personale</Link>.</p>
    {message && <p role="status" className="break-words">{message}</p>}
    {submitted && !videoId && <button disabled={busy} onClick={verify} className="rounded-xl border px-4 py-2 font-bold disabled:opacity-50">Verifica esito del caricamento</button>}
    {videoId && <Link href={'/videos/manage/' + videoId} className="inline-block rounded-xl border px-4 py-2 font-bold">Apri bozza e scegli i destinatari</Link>}
  </section>;
}
