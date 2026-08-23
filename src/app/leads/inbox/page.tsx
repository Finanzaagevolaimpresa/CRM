import type { Prisma } from '@prisma/client';
import { PrimaryButton, SecondaryLink } from '@/components/actions';
import { PaginationNav } from '@/components/pagination-nav';
import { Card, EmptyState, PageHeader, StatusBadge, formatDateTime } from '@/components/ui';
import { hasPermission, requirePermission } from '@/lib/auth';
import { commercialLeadInboxMode } from '@/lib/commercial-lead-inbox-contract';
import {
  assignCommercialLeadInbox,
  claimCommercialLeadInbox,
  closeCommercialLeadInbox,
  recordCommercialLeadFirstResponse,
  reopenCommercialLeadInbox,
  unassignCommercialLeadInbox,
} from '@/lib/form-actions';
import {
  coreQueryFetchSize,
  coreQueryOffset,
  leadVisibilityWhere,
  parseCoreQueryPage,
  toCoreQueryPage,
} from '@/lib/core-query-policy';
import { prisma } from '@/lib/prisma';
import { privilegedAccessReadiness } from '@/lib/privileged-access';

const queues = ['open', 'unassigned', 'mine', 'due', 'closed'] as const;
type Queue = typeof queues[number];

function queueValue(value: string | undefined): Queue {
  return queues.includes(value as Queue) ? value as Queue : 'open';
}

export default async function Page({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | undefined>>;
}) {
  const session = await requirePermission('lead.read');
  const mode = commercialLeadInboxMode();
  if (mode !== 'enforced') {
    return <div className="space-y-6">
      <PageHeader title="Commercial Lead Inbox" description="Foundation N14 dormiente: nessuna policy o activation è attiva." />
      <SecondaryLink href="/leads">← Torna alla pipeline</SecondaryLink>
      <EmptyState title="Inbox non attiva">Il deploy foundation non iscrive Lead e non avvia SLA.</EmptyState>
    </div>;
  }

  const params = (await searchParams) ?? {};
  const selectedQueue = queueValue(params.queue);
  const pageNumber = parseCoreQueryPage(params.page);
  const databaseClock = await prisma.$queryRaw<Array<{ now: Date }>>`
    SELECT clock_timestamp()::timestamptz(3) AS now
  `;
  const now = databaseClock[0]?.now ?? new Date(0);
  const dueThreshold = new Date(now.getTime() + 86_400_000);
  const leadWhere: Prisma.LeadWhereInput = { deletedAt: null, AND: [leadVisibilityWhere(session)] };
  if (selectedQueue === 'unassigned') leadWhere.assignedToId = null;
  if (selectedQueue === 'mine') leadWhere.assignedToId = session.userId;
  const where: Prisma.CommercialLeadInboxItemWhereInput = { lead: leadWhere };
  if (selectedQueue === 'closed') where.state = 'CLOSED';
  else where.state = 'OPEN';
  if (selectedQueue === 'due') {
    where.slaCycles = { some: { closedAt: null, dueAt: { lte: dueThreshold } } };
  }

  const [rows, userRows, readiness] = await Promise.all([
    prisma.commercialLeadInboxItem.findMany({
      where,
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      skip: coreQueryOffset(pageNumber),
      take: coreQueryFetchSize(),
      include: {
        lead: { select: { id: true, firstName: true, lastName: true, companyName: true, assignedToId: true, priority: true, status: true } },
        slaCycles: { orderBy: { sequence: 'desc' }, take: 1, include: { policyVersion: true } },
      },
    }),
    prisma.user.findMany({
      where: { active: true, deletedAt: null, role: { in: ['commerciale', 'direzione', 'admin'] } },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: 250,
      select: { id: true, name: true },
    }),
    privilegedAccessReadiness(session),
  ]);
  const page = toCoreQueryPage(rows, pageNumber);
  const users = new Map(userRows.map((user) => [user.id, user.name]));
  const canManage = hasPermission(session, 'lead.inbox.assign') && readiness.active;
  const canClaim = hasPermission(session, 'lead.inbox.claim');
  const canWork = hasPermission(session, 'lead.write');

  return <div className="space-y-6">
    <PageHeader title="Commercial Lead Inbox" description="Coda N14 con attribution immutabile e SLA first-response continuo 24x7 UTC." />
    <div className="flex flex-wrap gap-3">
      <SecondaryLink href="/leads">← Pipeline</SecondaryLink>
      {queues.map((queue) => <SecondaryLink key={queue} href={`/leads/inbox?queue=${queue}`}>{queue}</SecondaryLink>)}
    </div>
    <Card title={`Coda: ${selectedQueue}`}>
      {page.items.length === 0 ? <EmptyState title="Nessun item">La coda selezionata è vuota.</EmptyState> : <div className="space-y-4">
        {page.items.map((item) => {
          const cycle = item.slaCycles[0];
          const overdue = Boolean(cycle && !cycle.closedAt && !cycle.firstResponseAt && cycle.dueAt <= now);
          const owned = item.lead.assignedToId === session.userId;
          return <article key={item.id} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <a className="font-extrabold text-fai-blue underline" href={`/leads/${item.lead.id}`}>{item.lead.companyName || `${item.lead.firstName} ${item.lead.lastName}`}</a>
                <p className="mt-1 text-sm text-slate-600">Owner: {item.lead.assignedToId ? users.get(item.lead.assignedToId) ?? 'Assegnato' : 'Da assegnare'} · origine {item.originKind}</p>
              </div>
              <div className="flex gap-2"><StatusBadge status={item.state} /><StatusBadge status={overdue ? 'OVERDUE' : cycle?.outcome ?? 'IN SLA'} /></div>
            </div>
            <p className="mt-3 text-sm text-slate-600">Disponibile: {formatDateTime(cycle?.availableAt)} · Scadenza: {formatDateTime(cycle?.dueAt)} · Risposta: {formatDateTime(cycle?.firstResponseAt)}</p>
            <div className="mt-4 flex flex-wrap gap-2">
              {item.state === 'OPEN' && !item.lead.assignedToId && canClaim && <form action={claimCommercialLeadInbox}><input type="hidden" name="id" value={item.lead.id} /><input type="hidden" name="expectedInboxVersion" value={item.version} /><PrimaryButton type="submit">Prendi in carico</PrimaryButton></form>}
              {item.state === 'OPEN' && owned && canWork && !cycle?.firstResponseAt && <form action={recordCommercialLeadFirstResponse}><input type="hidden" name="id" value={item.lead.id} /><input type="hidden" name="expectedInboxVersion" value={item.version} /><PrimaryButton type="submit">Registra prima risposta</PrimaryButton></form>}
              {item.state === 'OPEN' && owned && canWork && <form action={closeCommercialLeadInbox} className="flex gap-2"><input type="hidden" name="id" value={item.lead.id} /><input type="hidden" name="expectedInboxVersion" value={item.version} /><select name="reasonCode" className="rounded-xl border p-2" defaultValue="QUALIFIED_OUT"><option value="QUALIFIED_OUT">Non qualificato</option><option value="LOST">Perso</option><option value="ARCHIVED">Archiviato</option></select><PrimaryButton type="submit">Chiudi</PrimaryButton></form>}
              {item.state === 'OPEN' && canManage && <form action={assignCommercialLeadInbox} className="flex gap-2"><input type="hidden" name="id" value={item.lead.id} /><input type="hidden" name="expectedInboxVersion" value={item.version} /><select name="targetUserId" className="rounded-xl border p-2" required>{userRows.map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}</select><PrimaryButton type="submit">Assegna</PrimaryButton></form>}
              {item.state === 'OPEN' && item.lead.assignedToId && canManage && <form action={unassignCommercialLeadInbox}><input type="hidden" name="id" value={item.lead.id} /><input type="hidden" name="expectedInboxVersion" value={item.version} /><PrimaryButton type="submit">Rilascia</PrimaryButton></form>}
              {item.state === 'CLOSED' && canManage && <form action={reopenCommercialLeadInbox}><input type="hidden" name="id" value={item.lead.id} /><input type="hidden" name="expectedInboxVersion" value={item.version} /><PrimaryButton type="submit">Riapri</PrimaryButton></form>}
            </div>
          </article>;
        })}
      </div>}
    </Card>
    <PaginationNav pathname="/leads/inbox" params={params} page={page.page} hasPrevious={page.hasPrevious} hasNext={page.hasNext} />
  </div>;
}

export const dynamic = 'force-dynamic';
