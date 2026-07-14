export const dynamic = 'force-dynamic';

import { SecondaryLink } from '@/components/actions';
import { Card, PageHeader, StatusBadge, TimestampMeta } from '@/components/ui';
import { requirePermission } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { getContractReadAccess } from '@/lib/read-access';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission('contract.read');
  const { id } = await params;
  const context = await getContractReadAccess(session, id);
  if (!context) return <PageHeader title="Contratto non trovato" description="Il record richiesto non esiste o non è accessibile." />;
  const { contract } = context;
  const client = await prisma.client.findFirst({ where: { id: contract.clientId, deletedAt: null } });

  return <div className="space-y-6">
    <PageHeader title={`Contratto — ${contract.contractNumber}`} description="Contratto interno con stato e gestione manuale di invio/firma." />
    <SecondaryLink href="/contracts">← Torna alla lista</SecondaryLink>
    <Card title="Dati contratto">
      <p>Cliente: {client?.displayName ?? 'Cliente non disponibile'}</p>
      <p>Servizio: {contract.serviceName}</p>
      <p>Totale: € {Number(contract.totalAmount).toLocaleString('it-IT')}</p>
      <p>Stato: <StatusBadge status={contract.status} /></p>
      <p className="mt-2 text-sm text-fai-gray">{contract.notes ?? 'Nessun dato presente'}</p>
      <TimestampMeta createdAt={contract.createdAt} updatedAt={contract.updatedAt} />
    </Card>
  </div>;
}
