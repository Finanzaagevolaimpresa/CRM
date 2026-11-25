import Link from 'next/link';
import { notFound } from 'next/navigation';
import { withTechnicalPage } from '@/lib/technical-surface-guards';
import { hasPermission, requirePermission } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { LeadWorkQueue, leadWorkQueues, leadWorkWhere, leadWorkHref } from '@/lib/lead-work-queues';
import { parseCoreQueryPage, coreQueryOffset, coreQueryFetchSize, toCoreQueryPage } from '@/lib/core-query-policy';
import { openLeadDuplicateReviewWhere } from '@/lib/lead-duplicate-review';
import { Card, PageHeader, formatDateTime } from '@/components/ui';
import { PaginationNav } from '@/components/pagination-nav';
export const dynamic = 'force-dynamic';

async function Page({ searchParams }: { searchParams: Promise<{ queue?: string; page?: string }> }) {
  const session = await requirePermission('lead.read');
  const params = await searchParams, queue = params.queue ?? 'contact';
  if (!Object.hasOwn(leadWorkQueues, queue)) notFound();
  const key = queue as LeadWorkQueue, where = leadWorkWhere(session, key, new Date());
  const pageNumber = parseCoreQueryPage(params.page);
  const [total, rows] = await prisma.$transaction([
    prisma.lead.count({ where }),
    prisma.lead.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      skip: coreQueryOffset(pageNumber), take: coreQueryFetchSize(), select: {
        id: true, companyName: true, firstName: true, lastName: true, nextActionDate: true, nextAction: true, assignedToId: true,
      } }),
  ], { isolationLevel: 'RepeatableRead' });
  const page = toCoreQueryPage(rows, pageNumber);
  const review = hasPermission(session, 'lead.duplicate.resolve')
    ? await prisma.leadDuplicateCase.count({ where: openLeadDuplicateReviewWhere(session.userId) }) : null;
  return <div className="crm-space-y-6"><PageHeader title={leadWorkQueues[key]} description="Lead nel tuo perimetro. Richiami e scadenze seguono il calendario di Roma."/>
    <nav className="flex flex-wrap gap-4">{(Object.keys(leadWorkQueues) as LeadWorkQueue[]).map(q =>
      <Link key={q} className="underline" aria-current={q === key ? 'page' : undefined} href={leadWorkHref(q)}>{leadWorkQueues[q]}</Link>)}</nav>
    <Card title={total + ' lead in elenco'}>
      {page.items.map(row => <p className="border-b py-3" key={row.id}>
        <Link className="font-bold underline" href={'/leads/' + row.id}>{row.companyName || [row.firstName,row.lastName].join(' ')}</Link>
        {' · '}{row.assignedToId ? 'Assegnato' : 'Da assegnare'}{(row.nextActionDate ?? row.nextAction) && ' · ' + formatDateTime(row.nextActionDate ?? row.nextAction)}
      </p>)}
      <PaginationNav pathname="/leads/work" params={{ queue: key }} {...page}/>
    </Card>
    <Card title="Eccezioni"><nav className="flex flex-wrap gap-4">
      <Link className="underline" href={leadWorkHref('missing')}>Lead assegnati senza prossimo passo</Link>
      {review !== null && <Link className="underline" href="/leads/duplicates">Richieste da verificare ({review})</Link>}
      {session.role === 'admin' && <Link className="underline" href="/leads/acquisition?queue=unlinked">Ricevute del sito senza scheda</Link>}
    </nav></Card><Link className="underline" href="/leads/inbox">Coda e assegnazioni</Link></div>;
}
export default withTechnicalPage("/leads/work", Page);
