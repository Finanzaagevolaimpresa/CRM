import Link from 'next/link';
import { notFound } from 'next/navigation';
import { withTechnicalPage } from '@/lib/technical-surface-guards';
import { requireSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { listDriveFolders } from '@/lib/drive-folder-library';
import { DriveFolderList } from '@/components/drive-folder-list';
import { PageHeader } from '@/components/ui';
export const dynamic = 'force-dynamic';
async function Page({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const session = await requireSession(), { q = '' } = await searchParams;
  const rows = await listDriveFolders(prisma, session, { query: q, manage: true }).catch(() => notFound());
  return <div className="space-y-6 min-w-0"><PageHeader title="Gestisci Fascicoli Drive" description="Collegamenti ai clienti, accessi nominativi e storico. Nessun upload documentale."/>
    <div className="flex flex-wrap gap-4"><Link className="underline" href="/drive-folders">← Le mie cartelle</Link>
      <Link className="font-bold underline" href="/drive-folders/manage/new">Collega cartella Drive</Link>
      <Link className="underline" href="/settings/users">Abilita o disabilita la sezione per account</Link></div>
    <form className="flex flex-wrap gap-3"><label>Cerca cliente o titolo<input className="ml-2 rounded-xl border p-3" name="q" maxLength={160} defaultValue={q}/></label><button className="rounded-xl border p-3 font-bold">Cerca</button></form>
    <p>«Aprire Fascicoli Drive» abilita la sezione; ogni cartella richiede anche una selezione esplicita. Una variazione dei responsabili o del ciclo di vita del cliente può richiedere di riconfermare l’associazione.</p>
    <DriveFolderList rows={rows} manage/>
  </div>;
}
export default withTechnicalPage('/drive-folders/manage', Page);
