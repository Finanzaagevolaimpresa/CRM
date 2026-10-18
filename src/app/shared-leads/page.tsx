export const dynamic = 'force-dynamic';
import { SecondaryLink } from '@/components/actions';
import { Card, EmptyState, PageHeader } from '@/components/ui';
import { requirePermission } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { listSharedLeadIds } from '@/lib/selective-lead-access';
import { parseCoreQueryPage } from '@/lib/core-query-policy';

export default async function Page({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const session = await requirePermission('lead.read'), page = parseCoreQueryPage((await searchParams).page);
  const data = await listSharedLeadIds(prisma, session, page).catch(() => null);
  return <div className="space-y-6"><PageHeader title="Lead condivisi con me" description="Le selezioni personali restano separate dalla pipeline ordinaria. Ogni apertura verifica i permessi correnti." />
    <SecondaryLink href="/leads">Torna ai lead</SecondaryLink>
    <Card title="Selezioni ricevute">{data?.ids.length ? <div className="space-y-3">{data.ids.map((id, index) => <div key={id} className="rounded-xl border p-4">
      <SecondaryLink href={`/shared-leads/${id}`}>Apri selezione {(page - 1) * 30 + index + 1}</SecondaryLink>
      <p className="mt-2 text-sm text-slate-600">Revoca, scadenza o modifica dei permessi possono renderla non disponibile.</p>
    </div>)}</div> : <EmptyState title="Nessuna selezione disponibile" />}</Card>
    <div className="flex flex-wrap gap-3">{page > 1 && <SecondaryLink href={`/shared-leads?page=${page - 1}`}>Precedenti</SecondaryLink>}
      {data?.hasNext && <SecondaryLink href={`/shared-leads?page=${page + 1}`}>Successive</SecondaryLink>}</div>
  </div>;
}
