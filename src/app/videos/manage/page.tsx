import Link from 'next/link';
import { randomUUID } from 'node:crypto';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/ui';
import { VideoUploadForm } from '@/components/video-upload-form';
import { requireSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { listVideos, VideoLibraryError } from '@/lib/video-library';
import { uploadVideoAction, verifyVideoUploadAction } from '@/lib/video-actions';
export const dynamic = 'force-dynamic';
export default async function Page() {
  const session = await requireSession(); let rows;
  try { rows = await listVideos(prisma, session, '', true); }
  catch (error) { if (error instanceof VideoLibraryError) notFound(); throw error; }
  return <div className="crm-space-y-6 min-w-0"><PageHeader title="Gestione video" description="Carica una bozza privata, poi scegli le persone e conferma la pubblicazione."/>
    <Link href="/videos" className="font-bold underline">← Libreria personale</Link>
    <VideoUploadForm commandId={randomUUID()} actions={{ upload: uploadVideoAction, verify: verifyVideoUploadAction }}/>
    <section className="space-y-3"><h2 className="text-xl font-bold">Bozze, pubblicazioni e archivio</h2>
      {rows.map(row => <article key={row.id} className="min-w-0 space-y-2 rounded-xl border bg-white p-4"><h3 className="break-words font-bold">{row.title}</h3>
        <p>{row.state === 'PUBLISHED' ? 'Pubblicato' : row.state === 'ARCHIVED' ? 'Archiviato' : 'Bozza privata'} · versione {row.version}</p>
        <Link className="font-bold underline" href={'/videos/manage/' + row.id}>Gestisci video</Link></article>)}
      {!rows.length && <p>Nessun video caricato.</p>}
    </section>
  </div>;
}
