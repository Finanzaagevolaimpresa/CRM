import Link from 'next/link';
import { notFound } from 'next/navigation';
import { withTechnicalPage } from '@/lib/technical-surface-guards';
import { requireSession } from '@/lib/auth';
import { recordUpdatePermission } from '@/lib/record-update-context';
import { prisma } from '@/lib/prisma';
import { listDriveFolders } from '@/lib/drive-folder-library';
import { DriveFolderList } from '@/components/drive-folder-list';
import { PageHeader } from '@/components/ui';
export const dynamic = 'force-dynamic';
async function Page({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const session = await requireSession(), { q = '' } = await searchParams;
  const rows = await listDriveFolders(prisma, session, { query: q }).catch(() => notFound());
  return <div className="space-y-6 min-w-0"><PageHeader title="Fascicoli Drive" description="Le cartelle attive selezionate per il tuo account. I file rimangono su Google Drive."/>
    {session.role === 'admin' && recordUpdatePermission(session, 'drive_folders.manage') && <Link className="font-bold underline" href="/drive-folders/manage">Gestisci collegamenti e accessi</Link>}
    <form className="flex flex-wrap gap-3"><label>Cerca cliente o titolo<input className="ml-2 rounded-xl border p-3" name="q" maxLength={160} defaultValue={q}/></label>
      <button className="rounded-xl border p-3 font-bold">Cerca</button><Link className="p-3 underline" href="/drive-folders">Mostra tutte le mie cartelle</Link></form>
    <DriveFolderList rows={rows}/>
    <p>Il CRM controlla la visibilità di questi riferimenti, non i permessi Google. La revoca qui non ritira un link già copiato o inoltrato.</p>
  </div>;
}
export default withTechnicalPage('/drive-folders', Page);
