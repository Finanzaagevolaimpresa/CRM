export const dynamic = 'force-dynamic';
import Link from 'next/link';
import { Card, EmptyState, PageHeader, StatusBadge, Table } from '@/components/ui';
import { prisma } from '@/lib/prisma';
export default async function Page() {
  const [items, clientRows, projectRows] = await Promise.all([prisma.payment.findMany({ orderBy: { dueDate: 'asc' } }), prisma.client.findMany({ where: { deletedAt: null } }), prisma.project.findMany({ where: { deletedAt: null } })]);
  const clients = new Map(clientRows.map((c) => [c.id, c.displayName]));
  const projects = new Map(projectRows.map((p) => [p.id, p.title]));
  return <div className="space-y-6"><PageHeader title="Pagamenti" description="Scadenze, incassi e note amministrative collegate ai contratti."/><Card title="Elenco operativo">{items.length === 0 ? <EmptyState title="Nessun elemento presente">Non ci sono record da lavorare per questa sezione.</EmptyState> : <Table headers={['Cliente', 'Totale', 'Metodo', 'Scadenza', 'Stato']} rows={items.map((x) => [clients.get(x.clientId) ?? '—', `€ ${Number(x.totalAmount).toLocaleString('it-IT')}`, x.method ?? '—', x.dueDate ? x.dueDate.toISOString().slice(0,10) : '—', <StatusBadge status={x.status} key='s' />])} />}</Card></div>;
}
