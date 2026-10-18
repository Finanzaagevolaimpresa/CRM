export const dynamic = 'force-dynamic';
import { SecondaryLink } from '@/components/actions';
import { Card, EmptyState, PageHeader } from '@/components/ui';
import { requirePermission } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { listSharedClientIds } from '@/lib/selective-client-access';
import { parseCoreQueryPage } from '@/lib/core-query-policy';

export default async function Page({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const session = await requirePermission('client.read'), page = parseCoreQueryPage((await searchParams).page);
  const data = await listSharedClientIds(prisma, session, page).catch(() => null);
  return <div className="space-y-6"><PageHeader title="Clienti condivisi con me" description="Le selezioni personali restano separate dalle schede ordinarie. Ogni apertura verifica i permessi correnti." />
    <SecondaryLink href="/clients">Torna ai clienti</SecondaryLink>
    <Card title="Selezioni ricevute">{data?.ids.length ? <div className="space-y-3">{data.ids.map((id, index) => <div key={id} className="rounded-xl border p-4">
      <SecondaryLink href={`/shared-clients/${id}`}>Apri selezione {(page - 1) * 30 + index + 1}</SecondaryLink>
      <p className="mt-2 text-sm text-slate-600">Revoca, scadenza o modifica dei permessi possono renderla non disponibile.</p>
    </div>)}</div> : <EmptyState title="Nessuna selezione disponibile" />}</Card>
    <div className="flex flex-wrap gap-3">{page > 1 && <SecondaryLink href={`/shared-clients?page=${page - 1}`}>Precedenti</SecondaryLink>}
      {data?.hasNext && <SecondaryLink href={`/shared-clients?page=${page + 1}`}>Successive</SecondaryLink>}</div>
  </div>;
}
