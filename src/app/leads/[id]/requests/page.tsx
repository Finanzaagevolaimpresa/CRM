import { notFound } from 'next/navigation';
import { SecondaryLink } from '@/components/actions';
import { LeadAcquisitionList } from '@/components/lead-acquisition-list';
import { PaginationNav } from '@/components/pagination-nav';
import { PageHeader } from '@/components/ui';
import { requirePermission } from '@/lib/auth';
import { LeadAcquisitionDenied, readLeadAcquisitions } from '@/lib/lead-acquisition';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';
export default async function Page({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<Record<string, string | undefined>>;
}) {
  const actor = await requirePermission('lead.read');
  const { id } = await params;
  const search = (await searchParams) ?? {};
  const page = await readLeadAcquisitions(prisma, actor, { leadId: id, page: search.page })
    .catch((error: unknown) => { if (error instanceof LeadAcquisitionDenied) notFound(); throw error; });
  return <div className="crm-space-y-6"><PageHeader title="Richieste e provenienza" description="Ogni invio acquisito rimane distinto, anche quando viene collegato allo stesso lead. Il collegamento conserva il contenuto originale della nuova richiesta." />
    <SecondaryLink href={`/leads/${id}`}>Torna al lead</SecondaryLink>
    <LeadAcquisitionList items={page.items} />
    <PaginationNav pathname={`/leads/${id}/requests`} params={{}} {...page} />
  </div>;
}
