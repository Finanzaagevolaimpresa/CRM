import Link from 'next/link';
import type { AuthSession } from '@/lib/auth';
import { recordUpdatePermission } from '@/lib/record-update-context';
import { listDriveFolders } from '@/lib/drive-folder-library';
import { prisma } from '@/lib/prisma';
import { Card } from './ui';
import { DriveFolderList } from './drive-folder-list';

/** Render only after the parent page has authorized the client projection.
 * New/converted clients use this same empty box; no creation hook is required. */
export async function ClientDriveFolders({ session, clientId }: { session: AuthSession; clientId: string }) {
  const manage = session.role === 'admin' && recordUpdatePermission(session, 'drive_folders.manage');
  const enabled = recordUpdatePermission(session, 'drive_folders.read');
  const rows = enabled ? await listDriveFolders(prisma, session, { clientId, manage }).catch(() => null) : null;
  return <Card title="File condivisi" id="file-condivisi"><div className="space-y-4">
    <p>Collegamenti alle cartelle Google Drive selezionate per te. Nessun file viene caricato nel CRM.</p>
    {enabled && rows ? <DriveFolderList rows={rows} manage={manage}/> : <p>Nessuna cartella disponibile per il tuo account. L’Admin gestisce separatamente sezione e singoli collegamenti.</p>}
    {manage && <Link className="font-bold underline" href={'/drive-folders/manage/new?client=' + encodeURIComponent(clientId)}>Collega cartella Drive a questo cliente</Link>}
    <p className="text-sm">Il riferimento CRM non aggiunge diritti su altri dati. I permessi Google sono separati; un link già copiato non viene revocato disabilitando il riferimento.</p>
  </div></Card>;
}
