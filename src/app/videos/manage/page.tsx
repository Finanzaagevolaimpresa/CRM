import { compareVideoOrder } from '@/lib/video-order';
import { withTechnicalPage } from '@/lib/technical-surface-guards';
import Link from 'next/link';
import { randomUUID } from 'node:crypto';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/ui';
import { VideoUploadForm } from '@/components/video-upload-form';
import { requireSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { listVideos, VideoLibraryError } from '@/lib/video-library';
import { listDriveVideos } from '@/lib/drive-video-library';
import { uploadVideoAction, verifyVideoUploadAction } from '@/lib/video-actions';
export const dynamic = 'force-dynamic';
  async function Page() {
  const session = await requireSession(); let rows, driveRows;
  try { rows = await listVideos(prisma, session, '', true); driveRows = await listDriveVideos(prisma, session, '', true); }
  catch (error) { if (error instanceof VideoLibraryError) notFound(); throw error; }
  const entries = [...rows.map(row => ({ ...row, drive: false, href: '/videos/manage/' + row.id })),
    ...driveRows.map(row => ({ ...row, drive: true, href: '/videos/manage/drive/' + row.id }))].sort(compareVideoOrder);
  return <div className="crm-space-y-6 min-w-0"><PageHeader title="Gestione video" description="Carica una bozza privata, poi scegli le persone e conferma la pubblicazione."/>
    <Link href="/videos" className="font-bold underline">← Libreria personale</Link>
    <p><Link href="/videos/manage/drive/new" className="inline-block rounded-xl border p-3 font-bold">Aggiungi da Google Drive</Link></p>
    <p>In alternativa, carica un file locale entro 20 MiB. I collegamenti Drive non richiedono il caricamento del file nel CRM.</p>
    <VideoUploadForm commandId={randomUUID()} actions={{ upload: uploadVideoAction, verify: verifyVideoUploadAction }}/>
    <section className="space-y-3"><h2 className="text-xl font-bold">Bozze, pubblicazioni e archivio</h2>
      {entries.map(row => <article key={row.id} className="min-w-0 space-y-2 rounded-xl border bg-white p-4"><h3 className="break-words font-bold">{row.title}</h3>
        <p>{row.drive ? 'Google Drive · ' : ''}{row.state === 'PUBLISHED' ? 'Pubblicato' : row.state === 'ARCHIVED' ? 'Archiviato' : 'Bozza privata'} · versione {row.version}</p>
        <Link className="font-bold underline" href={row.href}>{row.drive ? 'Gestisci riferimento e destinatari' : 'Gestisci video'}</Link></article>)}
      {!rows.length && !driveRows.length && <p>Nessun video caricato o collegato.</p>}
    </section>
  </div>;
}

export default withTechnicalPage("/videos/manage", Page);
