export const dynamic = 'force-dynamic';

import { PrimaryButton } from '@/components/actions';
import { Card, EmptyState, MetaCell, PageHeader, StatusBadge, Table, formatDateTime } from '@/components/ui';
import { canViewClient } from '@/lib/access-control';
import { hasPermission, requirePermission } from '@/lib/auth';
import { registerPaymentAndRefresh } from '@/lib/form-actions';
import { prisma } from '@/lib/prisma';

export default async function Page() {
  const session = await requirePermission('payment.read');
  const [items, clientRows, contracts] = await Promise.all([
    prisma.payment.findMany({ orderBy: { dueDate: 'asc' } }),
    prisma.client.findMany({ where: { deletedAt: null } }),
    prisma.contract.findMany(),
  ]);
  const visibleClients = clientRows.filter((client) => canViewClient(session, client));
  const clientById = new Map(visibleClients.map((client) => [client.id, client]));
  const contractById = new Map(contracts.map((contract) => [contract.id, contract]));
  const visibleContracts = contracts.filter((contract) => clientById.has(contract.clientId));
  const visibleItems = items.filter((payment) => {
    const contract = contractById.get(payment.contractId);
    return clientById.has(payment.clientId) && !!contract && contract.clientId === payment.clientId;
  });
  const canWrite = hasPermission(session, 'payment.write');

  return <div className="space-y-6">
    <PageHeader title="Pagamenti" description="Scadenze, incassi e note amministrative collegate ai contratti accessibili." />
    {canWrite ? <Card title="Registra pagamento">
      <form action={registerPaymentAndRefresh} className="grid gap-3 md:grid-cols-5">
        <select className="rounded-xl border p-3" name="contractId" required>{visibleContracts.map((contract) => <option key={contract.id} value={contract.id}>{contract.contractNumber}</option>)}</select>
        <select className="rounded-xl border p-3" name="clientId" required>{visibleClients.map((client) => <option key={client.id} value={client.id}>{client.displayName}</option>)}</select>
        <input className="rounded-xl border p-3" name="taxableAmount" type="number" min="0" step="0.01" placeholder="Imponibile" required />
        <input className="rounded-xl border p-3" name="vatAmount" type="number" min="0" step="0.01" placeholder="IVA" required />
        <input className="rounded-xl border p-3" name="totalAmount" type="number" min="0" step="0.01" placeholder="Totale" required />
        <PrimaryButton type="submit" className="md:col-span-5">Registra pagamento</PrimaryButton>
      </form>
    </Card> : null}
    <Card title="Elenco operativo">
      {visibleItems.length === 0 ? <EmptyState title="Nessun elemento presente">Non ci sono pagamenti disponibili nel tuo perimetro.</EmptyState> : <Table headers={['Cliente', 'Totale', 'Metodo', 'Scadenza', 'Stato', 'Tracciabilità']} rows={visibleItems.map((payment) => [clientById.get(payment.clientId)?.displayName ?? '—', `€ ${Number(payment.totalAmount).toLocaleString('it-IT')}`, payment.method ?? '—', formatDateTime(payment.dueDate), <StatusBadge status={payment.status} key="s" />, <MetaCell key="m" createdAt={payment.createdAt} updatedAt={payment.updatedAt} />])} />}
    </Card>
  </div>;
}
