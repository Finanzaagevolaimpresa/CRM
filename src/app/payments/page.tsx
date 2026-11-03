import { withTechnicalPage } from '@/lib/technical-surface-guards';
import { AdminRecordShortcut } from '@/components/admin-record-shortcut';
export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { PrimaryButton } from '@/components/actions';
import { Card, EmptyState, MetaCell, PageHeader, StatusBadge, Table, formatDateTime } from '@/components/ui';
import { canViewClient, canViewProject } from '@/lib/access-control';
import { canViewPaymentListRecord } from '@/lib/business-list-access';
import { hasPermission, requirePermission } from '@/lib/auth';
import { registerPaymentAndRefresh } from '@/lib/form-actions';
import { prisma } from '@/lib/prisma';
import { historicalPaymentSummaries } from '@/lib/payment-historical-attestation';
import { historicalDayLabel } from '@/lib/payment-historical-attestation-contract';

  async function Page() {
  const session = await requirePermission('payment.read');
  const [items, clientRows, contracts, projects] = await Promise.all([
    prisma.payment.findMany({ orderBy: { dueDate: 'asc' } }),
    prisma.client.findMany({ where: { deletedAt: null } }),
    prisma.contract.findMany(),
    prisma.project.findMany({ where: { deletedAt: null }, select: { id: true, clientId: true, consultantId: true } }),
  ]);
  const visibleClients = clientRows.filter((client) => canViewClient(session, client));
  const clientById = new Map(visibleClients.map((client) => [client.id, client]));
  const contractById = new Map(contracts.map((contract) => [contract.id, contract]));
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const visibleContracts = contracts.filter((contract) => {
    const client = clientById.get(contract.clientId);
    if (!client || session.selectiveContractIds?.includes(contract.id)) return false;
    const project = contract.projectId ? projectById.get(contract.projectId) : null;
    return !contract.projectId || Boolean(project && canViewProject(session, { ...project, client }));
  });
  const visibleItems = items.filter((payment) => {
    const contract = contractById.get(payment.contractId);
    return canViewPaymentListRecord(session, {
      payment, contract: contract ?? null, client: clientById.get(payment.clientId) ?? null,
      project: contract?.projectId ? projectById.get(contract.projectId) ?? null : null,
    });
  });
  const canWrite = hasPermission(session, 'payment.write');
  const attestations = await historicalPaymentSummaries(prisma, session, visibleItems);

  return <div className="crm-space-y-6">
    <PageHeader title="Pagamenti" description="Scadenze, incassi e note amministrative collegate ai contratti accessibili." />
    <AdminRecordShortcut session={session} model="Payment" />
    {session.role === 'admin' && canWrite && <Card title="Conferma pagamento">
      <p>Per registrare <strong>Incassato</strong>, scegli <strong>Conferma pagamento · Incassato</strong> accanto alla rata già presente nell’elenco.</p>
      <p className="mt-2">La conferma documentale richiede data e ora effettive, prova verificata e conferma personale. Per un incasso storico attestato espressamente dal titolare, usa Rettifica storica: registra il giorno e la fonte amministrativa senza richiedere allegati o attestare una verifica bancaria.</p>
    </Card>}
    {canWrite ? <Card title="Crea rata da incassare">
      <form action={registerPaymentAndRefresh} className="grid gap-3 md:grid-cols-5">
        <select className="rounded-xl border p-3" name="contractId" required>{visibleContracts.map((contract) => <option key={contract.id} value={contract.id}>{contract.contractNumber}</option>)}</select>
        <select className="rounded-xl border p-3" name="clientId" required>{visibleClients.map((client) => <option key={client.id} value={client.id}>{client.displayName}</option>)}</select>
        <input className="rounded-xl border p-3" name="taxableAmount" type="number" min="0" step="0.01" placeholder="Imponibile" required />
        <input className="rounded-xl border p-3" name="vatAmount" type="number" min="0" step="0.01" placeholder="IVA" required />
        <input className="rounded-xl border p-3" name="totalAmount" type="number" min="0" step="0.01" placeholder="Totale" required />
        <PrimaryButton type="submit" className="md:col-span-5">Crea rata da incassare</PrimaryButton>
      </form>
    </Card> : null}
    <Card title="Elenco operativo">
      {visibleItems.length === 0 ? <EmptyState title="Nessun elemento presente">Non ci sono pagamenti disponibili nel tuo perimetro.</EmptyState> : <Table headers={['Cliente', 'Conferma pagamento', 'Stato', 'Totale', 'Metodo', 'Scadenza', ...(session.role === 'admin' ? ['Incasso e fonte'] : []), 'Tracciabilità']} rows={visibleItems.map((payment) => [
        clientById.get(payment.clientId)?.displayName ?? '—',
        session.role === 'admin' && canWrite ? <span key="collection" className="grid gap-2"><Link className="font-semibold text-fai-blue underline" href={`/payments/${payment.id}/collection`}>
          {['da_incassare', 'scaduto'].includes(payment.status) ? 'Conferma pagamento · Incassato' : 'Apri incasso e verifiche'}
        </Link><Link className="font-semibold underline" href={`/payments/${payment.id}/historical-attestation`}>{attestations.has(payment.id) ? 'Apri attestazione storica' : 'Rettifica storica · attestazione Admin'}</Link></span> : '—',
        <StatusBadge status={payment.status} key="s" />, `€ ${Number(payment.totalAmount).toLocaleString('it-IT')}`,
        payment.method ?? '—', formatDateTime(payment.dueDate),
        ...(session.role === 'admin' ? [attestations.has(payment.id)
          ? <span key="source">{historicalDayLabel(attestations.get(payment.id)!.effectiveDay)} · solo giorno<br />Attestazione Admin · ora e metodo non dichiarati</span>
          : payment.collectedAt ? formatDateTime(payment.collectedAt) : '—'] : []),
        <MetaCell key="m" createdAt={payment.createdAt} updatedAt={payment.updatedAt} />,
      ])} />}
    </Card>
  </div>;
}

export default withTechnicalPage("/payments", Page);
