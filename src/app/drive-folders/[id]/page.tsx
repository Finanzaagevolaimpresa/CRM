import Link from 'next/link';
import { notFound } from 'next/navigation';
import { withTechnicalPage } from '@/lib/technical-surface-guards';
import { requireSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { readDriveFolder } from '@/lib/drive-folder-library';
import { PageHeader } from '@/components/ui';
export const dynamic = 'force-dynamic';
async function Page({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession(), { id } = await params;
  const row = await readDriveFolder(prisma, session, id).catch(() => notFound());
  return <div className="space-y-5"><PageHeader title={row.title} description={row.clientName}/>
    <Link className="underline" href="/drive-folders">← Fascicoli Drive</Link>
    <p>Riferimento attivo · revisione {row.version}{row.expiresAt ? ' · scadenza ' + new Date(row.expiresAt).toLocaleString('it-IT') : ''}</p>
    <a className="block font-bold underline" href={'/drive-folders/' + id + '/open'} target="_blank" rel="noopener noreferrer">Apri cartella Drive</a>
    <p>La cartella si apre su Google Drive, che può richiedere un accesso Google. Se non è disponibile, chiedi all’Admin di verificare il link e i permessi Google.</p>
    <p>Questo collegamento non apre altri dati CRM del cliente. La revoca CRM non ritira un link già copiato; evita di inoltrarlo a persone non autorizzate.</p>
  </div>;
}
export default withTechnicalPage('/drive-folders/[id]', Page);
