export const dynamic = 'force-dynamic';

import { notFound } from 'next/navigation';
import { SecondaryLink } from '@/components/actions';
import { Card, EmptyState, PageHeader, StatusBadge } from '@/components/ui';
import { LeadLifecycleControls } from '@/components/lead-lifecycle-controls';
import { requirePermission, hasPermission } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { listTrashedLeads } from '@/lib/lead-lifecycle';
import { parseCoreQueryPage } from '@/lib/core-query-policy';

export default async function Page({ searchParams }: { searchParams?: Promise<Record<string, string | undefined>> }) {
  const session = await requirePermission('lead.read');
  if (session.role !== 'admin') notFound();
  const params = await searchParams ?? {};
  const page = parseCoreQueryPage(params.page);
  const result = await listTrashedLeads(prisma, session, page);
  return <div className="crm-space-y-6">
    <PageHeader title="Cestino lead" description="Area riservata all’amministratore. I lead sono conservati e possono essere ripristinati; non è prevista una cancellazione definitiva." />
    <SecondaryLink href="/leads">Torna alla pipeline</SecondaryLink>
    {params.result === 'trashed' && <p role="status" className="rounded-xl bg-green-50 p-3">Lead spostato nel cestino. Dati e collegamenti conservati.</p>}
    <Card title="Lead nel cestino">{result.items.length === 0 ? <EmptyState title="Cestino vuoto" /> : <div className="space-y-4">
      {result.items.map(lead => {
        const title = lead.companyName || `${lead.firstName} ${lead.lastName}`;
        return <article key={lead.id} className="space-y-3 rounded-xl border p-4">
          <h2 className="break-words font-bold">{title}</h2>
          <p className="text-sm">Nel cestino dal {lead.deletedAt?.toLocaleString('it-IT')} · Stato conservato: <StatusBadge status={lead.status} /></p>
          {lead.clientId && <p className="text-sm">Il cliente già convertito è conservato separatamente con i suoi permessi attuali.</p>}
          {hasPermission(session, 'lead.write') && <LeadLifecycleControls id={lead.id} title={title} updatedAt={lead.updatedAt.toISOString()} action="restore" />}
        </article>;
      })}
    </div>}</Card>
    <nav aria-label="Pagine del cestino" className="flex gap-3">
      {page > 1 && <SecondaryLink href={`/leads/trash?page=${page - 1}`}>Precedente</SecondaryLink>}
      {result.hasNext && <SecondaryLink href={`/leads/trash?page=${page + 1}`}>Successiva</SecondaryLink>}
    </nav>
  </div>;
}
