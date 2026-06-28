export const dynamic = 'force-dynamic';
import Link from 'next/link';
import { Card, EmptyState, PageHeader, StatusBadge, Table } from '@/components/ui';
import { prisma } from '@/lib/prisma';
import { requirePermission } from '@/lib/auth';
import { canViewProject } from '@/lib/access-control';
export default async function Page() {
  const session = await requirePermission('project.read');
  const [projectItems, clientRows, projectRows] = await Promise.all([prisma.project.findMany({ where: { deletedAt: null }, orderBy: { updatedAt: 'desc' } }), prisma.client.findMany({ where: { deletedAt: null } }), prisma.project.findMany({ where: { deletedAt: null } })]);
  const clientById = new Map(clientRows.map((c) => [c.id, c]));
  const items = projectItems.filter((project) => canViewProject(session, { ...project, client: clientById.get(project.clientId) }));
  const clients = new Map(clientRows.map((c) => [c.id, c.displayName]));
  const projects = new Map(projectRows.map((p) => [p.id, p.title]));
  return <div className="space-y-6"><PageHeader title="Progetti" description="Progetti di investimento, priorità, scenari e condizioni operative."/><Card title="Elenco operativo">{items.length === 0 ? <EmptyState title="Nessun elemento presente">Non ci sono record da lavorare per questa sezione.</EmptyState> : <Table headers={['Titolo', 'Cliente', 'Investimento', 'Stato', 'Azione']} rows={items.map((x) => [<span className='font-semibold text-fai-navy' key='n'>{x.title}</span>, clients.get(x.clientId) ?? '—', x.totalInvestment ? `€ ${Number(x.totalInvestment).toLocaleString('it-IT')}` : '—', <StatusBadge status={x.status} key='s' />, <Link className='font-bold text-fai-blue underline' href={`/projects/${x.id}`} key='a'>Apri</Link>])} />}</Card></div>;
}
