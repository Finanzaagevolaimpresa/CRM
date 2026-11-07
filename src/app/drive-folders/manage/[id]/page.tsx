import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { withTechnicalPage } from '@/lib/technical-surface-guards';
import { requireSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { driveFolderSetup } from '@/lib/drive-folder-library';
import { DriveFolderEditor } from '@/components/drive-folder-editor';
import { PageHeader } from '@/components/ui';
export const dynamic = 'force-dynamic';
async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ client?: string }> }) {
  const { id } = await params, { client } = await searchParams, session = await requireSession();
  const setup = await driveFolderSetup(prisma, session, id === 'new' ? randomUUID() : id).catch(() => notFound());
  if (id !== 'new' && !setup.current) notFound();
  const initialClientId = setup.clients.some(c => c.id === client) ? client : undefined;
  return <div className="space-y-6 min-w-0"><PageHeader title={setup.current ? 'Gestisci fascicolo Drive' : 'Collega cartella Drive'}
    description="Un solo riferimento per l’elenco Fascicoli Drive e il riquadro File condivisi del cliente."/>
    <Link className="font-bold underline" href="/drive-folders/manage">← Gestione Fascicoli Drive</Link>
    <DriveFolderEditor key={id} id={setup.id} current={setup.current} people={setup.people} clients={setup.clients} initialClientId={initialClientId}/>
    {setup.current && <p><a className="underline" href={setup.current.details.url} target="_blank" rel="noopener noreferrer">Apri cartella Drive come Admin</a> · controllo esterno, senza modifica dei permessi Google</p>}
    <section><h2 className="font-bold">Storico del riferimento</h2><ul>{setup.history.map(row =>
      <li key={row.commandId}>Revisione {row.revision} · {row.state} · {row.createdAt} · autore {row.actorId} · comando {row.commandId}</li>)}</ul></section>
  </div>;
}
export default withTechnicalPage('/drive-folders/manage/[id]', Page);
