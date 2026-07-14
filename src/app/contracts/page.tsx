export const dynamic = 'force-dynamic';
import Link from 'next/link';
import { OpenLink, PrimaryButton } from '@/components/actions';
import { createContractAndRefresh } from '@/lib/form-actions';
import { Card, EmptyState, MetaCell, PageHeader, StatusBadge, Table } from '@/components/ui';
import { prisma } from '@/lib/prisma';
import { canViewClient, canViewProject } from '@/lib/access-control';
import { hasPermission, requirePermission } from '@/lib/auth';
export default async function Page() {
  const session = await requirePermission('contract.read');
  const [items, clientRows, projectRows] = await Promise.all([prisma.contract.findMany(), prisma.client.findMany({ where: { deletedAt: null } }), prisma.project.findMany({ where: { deletedAt: null } })]);
  const visibleClients = clientRows.filter((client) => canViewClient(session, client));
  const clientById = new Map(visibleClients.map((client) => [client.id, client]));
  const projectById = new Map(projectRows.map((project) => [project.id, project]));
  const visibleItems = items.filter((contract) => {
    const client = clientById.get(contract.clientId);
    if (!client) return false;
    if (!contract.projectId) return true;
    const project = projectById.get(contract.projectId);
    return !!project && project.clientId === contract.clientId && canViewProject(session, { ...project, client });
  });
  const canWrite = hasPermission(session, 'contract.write');
  return <div className="space-y-6"><PageHeader title="Contratti" description="Contratti gestiti internamente con invio e firma manuali."/>{canWrite ? <Card title="Crea contratto"><form action={createContractAndRefresh} className="grid gap-3 md:grid-cols-5"><select className="rounded-xl border p-3" name="clientId" required>{visibleClients.map(c=><option key={c.id} value={c.id}>{c.displayName}</option>)}</select><input className="rounded-xl border p-3" name="contractNumber" placeholder="Numero" required/><input className="rounded-xl border p-3" name="serviceName" placeholder="Servizio" required/><input className="rounded-xl border p-3" name="taxableAmount" type="number" min="0" step="0.01" placeholder="Imponibile" required/><input className="rounded-xl border p-3" name="vatAmount" type="number" min="0" step="0.01" placeholder="IVA" required/><input className="rounded-xl border p-3" name="totalAmount" type="number" min="0" step="0.01" placeholder="Totale" required/><PrimaryButton type="submit" className="md:col-span-4">Crea contratto</PrimaryButton></form></Card> : null}<Card title="Elenco operativo">{visibleItems.length === 0 ? <EmptyState title="Nessun elemento presente">Non ci sono contratti disponibili nel tuo perimetro.</EmptyState> : <Table headers={['Numero', 'Cliente', 'Servizio', 'Totale', 'Stato', 'Tracciabilità', 'Azione']} rows={visibleItems.map((x) => [<span className='font-semibold text-fai-navy' key='n'>{x.contractNumber}</span>, clientById.get(x.clientId)?.displayName ?? '—', x.serviceName, `€ ${Number(x.totalAmount).toLocaleString('it-IT')}`, <StatusBadge status={x.status} key='s' />, <MetaCell key='m' createdAt={x.createdAt} updatedAt={x.updatedAt} />, <OpenLink href={`/contracts/${x.id}`} key='a'>Apri</OpenLink>])} />}</Card></div>;
}
