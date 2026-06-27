export const dynamic = 'force-dynamic';
import Link from 'next/link';
import { Card, EmptyState, PageHeader, StatusBadge, Table } from '@/components/ui';
import { prisma } from '@/lib/prisma';
export default async function Page() {
  const [items, clientRows, projectRows] = await Promise.all([prisma.document.findMany({ where: { deletedAt: null }, orderBy: { createdAt: 'desc' } }), prisma.client.findMany({ where: { deletedAt: null } }), prisma.project.findMany({ where: { deletedAt: null } })]);
  const clients = new Map(clientRows.map((c) => [c.id, c.displayName]));
  const projects = new Map(projectRows.map((p) => [p.id, p.title]));
  return <div className="space-y-6"><PageHeader title="Documenti" description="Metadati documentali interni: i file restano in storage privato e non sono esposti pubblicamente."/><Card title="Elenco operativo">{items.length === 0 ? <EmptyState title="Nessun elemento presente">Non ci sono record da lavorare per questa sezione.</EmptyState> : <Table headers={['Documento', 'Cliente', 'Sezione', 'Categoria', 'Stato']} rows={items.map((x) => [<span className='font-semibold text-fai-navy' key='n'>{x.title}</span>, x.clientId ? clients.get(x.clientId) ?? '—' : '—', x.serviceArea, x.documentCategory, <StatusBadge status={x.status} key='s' />])} />}</Card></div>;
}
