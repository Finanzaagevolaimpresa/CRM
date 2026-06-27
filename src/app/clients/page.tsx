export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { Card, Table } from '@/components/ui';
import { prisma } from '@/lib/prisma';

export default async function Page() {
  const [clients, users, serviceCounts, documentCounts] = await Promise.all([
    prisma.client.findMany({ where: { deletedAt: null }, orderBy: { updatedAt: 'desc' } }),
    prisma.user.findMany({ where: { active: true } }),
    prisma.clientService.groupBy({ by: ['clientId'], where: { deletedAt: null }, _count: { _all: true } }),
    prisma.document.groupBy({ by: ['clientId'], where: { deletedAt: null, clientId: { not: null } }, _count: { _all: true } }),
  ]);

  const userName = (id?: string | null) => users.find((user) => user.id === id)?.name;
  const serviceCount = (clientId: string) => serviceCounts.find((row) => row.clientId === clientId)?._count._all ?? 0;
  const documentCount = (clientId: string) => documentCounts.find((row) => row.clientId === clientId)?._count._all ?? 0;
  const ownerLabel = (client: (typeof clients)[number]) => userName(client.consultantId) ?? userName(client.salesOwnerId) ?? 'Da assegnare';

  return <div className="space-y-6">
    <header>
      <h1 className="text-3xl font-bold text-fai-navy">Clienti</h1>
      <p className="mt-2 text-fai-gray">Lista clienti reale collegata a Prisma. Apri il fascicolo interno per consultare servizi, documenti, output AI e attività operative.</p>
    </header>
    <Card title="Fascicoli Cliente Interni">
      {clients.length === 0 ? <p className="text-sm text-fai-gray">Nessun cliente registrato. Esegui il seed demo o crea un cliente dal flusso operativo interno.</p> : <Table headers={['Nome cliente', 'Tipo cliente', 'Stato', 'Referente / responsabile', 'Servizi acquistati', 'Documenti', 'Azione']} rows={clients.map((client) => [
        <span className="font-semibold text-fai-navy" key="name">{client.displayName}</span>,
        client.type,
        client.status,
        ownerLabel(client),
        serviceCount(client.id),
        documentCount(client.id),
        <Link className="font-semibold text-fai-blue underline" href={`/clients/${client.id}`} key="open">Apri fascicolo</Link>,
      ])} />}
    </Card>
  </div>;
}
