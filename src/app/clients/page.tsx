export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { Card, MetaCell, Table } from '@/components/ui';
import { PaginationNav } from '@/components/pagination-nav';
import { prisma } from '@/lib/prisma';
import { requirePermission } from '@/lib/auth';
import {
  clientVisibilityWhere,
  coreQueryFetchSize,
  coreQueryOffset,
  parseCoreQueryPage,
  toCoreQueryPage,
} from '@/lib/core-query-policy';

export default async function Page({ searchParams }: { searchParams?: Promise<Record<string, string | undefined>> }) {
  const session = await requirePermission('client.read');
  const params = (await searchParams) ?? {};
  const pageNumber = parseCoreQueryPage(params.page);
  const rows = await prisma.client.findMany({
    where: { deletedAt: null, AND: [clientVisibilityWhere(session)] },
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    skip: coreQueryOffset(pageNumber),
    take: coreQueryFetchSize(),
  });
  const page = toCoreQueryPage(rows, pageNumber);
  const clients = page.items;
  const clientIds = clients.map((client) => client.id);
  const ownerIds = [...new Set(clients.flatMap((client) => [client.consultantId, client.salesOwnerId]).filter((id): id is string => Boolean(id)))];
  const [users, serviceCounts, documentCounts, latestServices] = clientIds.length ? await Promise.all([
    ownerIds.length ? prisma.user.findMany({ where: { id: { in: ownerIds }, active: true }, select: { id: true, name: true } }) : Promise.resolve([]),
    prisma.clientService.groupBy({ by: ['clientId'], where: { clientId: { in: clientIds }, deletedAt: null }, _count: { _all: true } }),
    prisma.document.groupBy({ by: ['clientId'], where: { clientId: { in: clientIds }, deletedAt: null }, _count: { _all: true } }),
    prisma.clientService.findMany({
      where: { clientId: { in: clientIds }, deletedAt: null, operationalStatus: { notIn: ['chiusa','archiviata'] } },
      orderBy: [{ clientId: 'asc' }, { statusUpdatedAt: 'desc' }, { id: 'desc' }],
      distinct: ['clientId'],
      select: { clientId: true, operationalStatus: true, statusUpdatedAt: true },
    }),
  ]) : [[], [], [], []];
  const userById = new Map(users.map((user) => [user.id, user.name]));
  const serviceCountByClient = new Map(serviceCounts.map((row) => [row.clientId, row._count._all]));
  const documentCountByClient = new Map(documentCounts.map((row) => [row.clientId, row._count._all]));
  const mainStatusByClient = new Map(latestServices.map((service) => [service.clientId, service.operationalStatus]));
  const userName = (id?: string | null) => id ? userById.get(id) : undefined;
  const serviceCount = (clientId: string) => serviceCountByClient.get(clientId) ?? 0;
  const documentCount = (clientId: string) => documentCountByClient.get(clientId) ?? 0;
  const ownerLabel = (client: (typeof clients)[number]) => userName(client.consultantId) ?? userName(client.salesOwnerId) ?? 'Da assegnare';
  const mainStatus = (clientId: string) => mainStatusByClient.get(clientId);

  return <div className="space-y-6">
    <header>
      <h1 className="text-3xl font-bold text-fai-navy">Clienti</h1>
      <p className="mt-2 text-fai-gray">Lista clienti reale collegata a Prisma. Apri il fascicolo interno per consultare servizi, documenti, output AI e attività operative.</p>
    </header>
    <Card title="Fascicoli Cliente Interni">
      {clients.length === 0 ? <p className="text-sm text-fai-gray">Nessun cliente registrato. Esegui il seed demo o crea un cliente dal flusso operativo interno.</p> : <><Table headers={['Nome cliente', 'Tipo cliente', 'Stato', 'Stato pratica', 'Referente / responsabile', 'Servizi acquistati', 'Documenti', 'Tracciabilità', 'Azione']} rows={clients.map((client) => [
        <span className="font-semibold text-fai-navy" key="name">{client.displayName}</span>,
        client.type,
        client.status,
        mainStatus(client.id)?.replaceAll('_', ' ') ?? '—',
        ownerLabel(client),
        serviceCount(client.id),
        documentCount(client.id),
        <MetaCell key="m" createdAt={client.createdAt} updatedAt={client.updatedAt} owner={ownerLabel(client)} />,
        <Link className="font-semibold text-fai-blue underline" href={`/clients/${client.id}`} key="open">Apri fascicolo</Link>,
      ])} /><PaginationNav pathname="/clients" params={params} page={page.page} hasPrevious={page.hasPrevious} hasNext={page.hasNext} /></>}
    </Card>
  </div>;
}
