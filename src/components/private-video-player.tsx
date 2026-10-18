'use client';

import { useState } from 'react';

/** Metadata is supplied only after server admission. Content/HEAD/range and
 * download must repeat that admission independently of this presentation. */
export function PrivateVideoPlayer({ video, adminPreview = false, asRecipient }: { adminPreview?: boolean; asRecipient?: string; video: {
  id: string; title: string; description: string; mimeType: 'video/mp4' | 'video/webm';
  downloadAllowed: boolean; expiresAt: string | null;
} }) {
  const [unavailable, setUnavailable] = useState(false);
  const content = '/videos/' + encodeURIComponent(video.id) + '/content'
    + (adminPreview ? '?preview=1' + (asRecipient ? '&as=' + encodeURIComponent(asRecipient) : '') : '');
  return <section aria-label={video.title} className="min-w-0 space-y-4">
    <h1 className="break-words text-2xl font-bold">{video.title}</h1>
    {video.description && <p className="whitespace-pre-wrap break-words">{video.description}</p>}
    {unavailable ? <p role="status" className="rounded-xl border p-4">Il video non è disponibile. Riapri la libreria per verificare il tuo accesso corrente.</p>
      : <video controls playsInline preload="metadata" aria-label={video.title}
          className="aspect-video w-full max-w-full rounded-xl bg-slate-950"
          controlsList={video.downloadAllowed ? undefined : 'nodownload'} onError={() => setUnavailable(true)}>
          <source src={content} type={video.mimeType} onError={() => setUnavailable(true)}/>
          Il browser non supporta la riproduzione di questo video.
        </video>}
    {video.expiresAt && <p className="text-sm">Disponibile fino al {new Date(video.expiresAt).toLocaleString('it-IT')}.</p>}
    {!unavailable && video.downloadAllowed && <a href={content + '?download=1'} className="inline-block rounded-xl border px-4 py-2 font-bold">Scarica video</a>}
  </section>;
}
