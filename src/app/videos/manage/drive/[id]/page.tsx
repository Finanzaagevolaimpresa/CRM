import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { withTechnicalPage } from '@/lib/technical-surface-guards';
import { requireSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { driveVideoSetup } from '@/lib/drive-video-library';
import { DriveVideoEditor } from '@/components/drive-video-editor';
import { PageHeader } from '@/components/ui';
export const dynamic = 'force-dynamic';
async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params, session = await requireSession();
  const setup = await driveVideoSetup(prisma, session, id === 'new' ? randomUUID() : id).catch(() => notFound());
  if (id !== 'new' && !setup.current) notFound();
  return <div className="space-y-6 min-w-0"><PageHeader title={setup.current ? 'Gestisci video Google Drive' : 'Aggiungi da Google Drive'}
    description="Riferimento privato con pubblicazione selettiva; il file rimane su Google Drive."/>
    <Link className="font-bold underline" href="/videos/manage">← Gestione video</Link>
    <DriveVideoEditor key={setup.current?.revision ?? 0} id={setup.id} current={setup.current} people={setup.people}/>
    <section><h2 className="font-bold">Storico del riferimento</h2><ul>{setup.history.map(row =>
      <li key={row.commandId}>Versione {row.revision} · {row.state} · {row.createdAt} · autore {row.actorId} · comando {row.commandId}</li>)}</ul></section>
  </div>;
}
export default withTechnicalPage('/videos/manage/drive/[id]', Page);
