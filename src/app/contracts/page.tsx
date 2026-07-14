export const dynamic = 'force-dynamic';
import Link from 'next/link';
import { OpenLink, PrimaryButton } from '@/components/actions';
import { createContractAndRefresh } from '@/lib/form-actions';
import { Card, EmptyState, MetaCell, PageHeader, StatusBadge, Table } from '@/components/ui';
import { prisma } from '@/lib/prisma';
import { hasPermission, requirePermission } from '@/lib/auth';
import { canViewClient } from '@/lib/access-control';
export default async function Page() {
  const session = await requirePermission('contract.read');
  const canWrite = hasPermission(session, 'contract.write');
  const [items, clientRows, projectRows] = await Promise.all([prisma.contract.findMany(), prisma.client.findMany({ where: { deletedAt: null } }), prisma.project.findMany({ where: { deletedAt: null } })]);
  const visibleClientRows = clientRows.filter((client) => canViewClient(session, client));
  const visibleClientIds = new Set(visibleClientRows.map((client) => client.id));
  const visibleItems = items.filter((item) => visibleClientIds.has(item.clientId));
  const clients = new Map(visibleClientRows.map((c) => [c.id, c.displayName]));
  const projects = new Map(projectRows.map((p) => [p.id, p.title]));
  return <div className="space-y-6"><PageHeader title="Contratti" description="Contratti gestiti internamente con invio e firma manuali."/>{canWrite ? <Card title="Crea contratto"><form action={createContractAndRefresh} className="grid gap-3 md:grid-cols-5"><select className="rounded-xl border p-3" name="clientId" required>{visibleClientRows.map(c=><option key={c.id} value={c.id}>{c.displayName}</option>)}</select><input className="rounded-xl border p-3" name="contractNumber" placeholder="Numero" required/><input className="rounded-xl border p-3" name="serviceName" placeholder="Servizio" required/><input className="rounded-xl border p-3" name="taxableAmount" type="number" min="0" step="0.01" placeholder="Imponibile" required/><input className="rounded-xl border p-3" name="vatAmount" type="number" min="0" step="0.01" placeholder="IVA" required/><input className="rounded-xl border p-3" name="totalAmount" type="number" min="0" step="0.01" placeholder="Totale" required/><PrimaryButton type="submit" className="md:col-span-4">Crea contratto</PrimaryButton></form></Card> : null}<Card title="Elenco operativo">{visibleItems.length === 0 ? <EmptyState title="Nessun elemento presente">Non ci sono record da lavorare per questa sezione.</EmptyState> : <Table headers={['Numero', 'Cliente', 'Servizio', 'Totale', 'Stato', 'Tracciabilità', 'Azione']} rows={visibleItems.map((x) => [<span className='font-semibold text-fai-navy' key='n'>{x.contractNumber}</span>, clients.get(x.clientId) ?? '—', x.serviceName, `€ ${Number(x.totalAmount).toLocaleString('it-IT')}`, <StatusBadge status={x.status} key='s' />, <MetaCell key='m' createdAt={x.createdAt} updatedAt={x.updatedAt} />, <OpenLink href={`/contracts/${x.id}`} key='a'>Apri</OpenLink>])} />}</Card></div>;
}
