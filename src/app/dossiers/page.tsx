export const dynamic = 'force-dynamic';
import Link from 'next/link';
import { Card, EmptyState, PageHeader, StatusBadge, Table } from '@/components/ui';
import { prisma } from '@/lib/prisma';
export default async function Page() {
  const [items, clientRows, projectRows] = await Promise.all([prisma.dossier.findMany(), prisma.client.findMany({ where: { deletedAt: null } }), prisma.project.findMany({ where: { deletedAt: null } })]);
  const clients = new Map(clientRows.map((c) => [c.id, c.displayName]));
  const projects = new Map(projectRows.map((p) => [p.id, p.title]));
  return <div className="space-y-6"><PageHeader title="Dossier" description="Dossier operativi in bozza, revisione interna o consegna manuale."/><Card title="Elenco operativo">{items.length === 0 ? <EmptyState title="Nessun elemento presente">Non ci sono record da lavorare per questa sezione.</EmptyState> : <Table headers={['Titolo', 'Cliente', 'Tipo', 'Stato', 'Azione']} rows={items.map((x) => [<span className='font-semibold text-fai-navy' key='n'>{x.title}</span>, clients.get(x.clientId) ?? '—', x.type, <StatusBadge status={x.status} key='s' />, <Link className='font-bold text-fai-blue underline' href={`/dossiers/${x.id}`} key='a'>Apri</Link>])} />}</Card></div>;
}
