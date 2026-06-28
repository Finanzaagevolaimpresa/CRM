export const dynamic = 'force-dynamic';
import Link from 'next/link';
import { PrimaryButton } from '@/components/actions';
import { createProjectAndRedirect } from '@/lib/form-actions';
import { Card, EmptyState, MetaCell, PageHeader, StatusBadge, Table } from '@/components/ui';
import { prisma } from '@/lib/prisma';
import { requirePermission } from '@/lib/auth';
import { canViewProject } from '@/lib/access-control';
export default async function Page() {
  const session = await requirePermission('project.read');
  const [projectItems, clientRows, projectRows, userRows] = await Promise.all([prisma.project.findMany({ where: { deletedAt: null }, orderBy: { updatedAt: 'desc' } }), prisma.client.findMany({ where: { deletedAt: null } }), prisma.project.findMany({ where: { deletedAt: null } }), prisma.user.findMany({ where: { active: true } })]);
  const clientById = new Map(clientRows.map((c) => [c.id, c]));
  const items = projectItems.filter((project) => canViewProject(session, { ...project, client: clientById.get(project.clientId) }));
  const clients = new Map(clientRows.map((c) => [c.id, c.displayName]));
  const projects = new Map(projectRows.map((p) => [p.id, p.title]));
  const users = new Map(userRows.map((u) => [u.id, u.name]));
  return <div className="space-y-6"><PageHeader title="Progetti" description="Progetti di investimento, priorità, scenari e condizioni operative."/><Card title="Crea progetto base"><form action={createProjectAndRedirect} className="grid gap-3 md:grid-cols-5"><select className="rounded-xl border p-3" name="clientId" required>{clientRows.map(c=><option key={c.id} value={c.id}>{c.displayName}</option>)}</select><input className="rounded-xl border p-3 md:col-span-2" name="title" placeholder="Titolo progetto" required/><input className="rounded-xl border p-3" name="totalInvestment" type="number" min="0" step="0.01" placeholder="Investimento"/><PrimaryButton type="submit">Crea progetto</PrimaryButton></form></Card><Card title="Elenco operativo">{items.length === 0 ? <EmptyState title="Nessun elemento presente">Non ci sono record da lavorare per questa sezione.</EmptyState> : <Table headers={['Titolo', 'Cliente', 'Investimento', 'Stato', 'Tracciabilità', 'Azione']} rows={items.map((x) => [<span className='font-semibold text-fai-navy' key='n'>{x.title}</span>, clients.get(x.clientId) ?? '—', x.totalInvestment ? `€ ${Number(x.totalInvestment).toLocaleString('it-IT')}` : '—', <StatusBadge status={x.status} key='s' />, <MetaCell key='m' createdAt={x.createdAt} updatedAt={x.updatedAt} owner={x.consultantId ? users.get(x.consultantId) : null} />, <Link className='font-bold text-fai-blue underline' href={`/projects/${x.id}`} key='a'>Apri</Link>])} />}</Card></div>;
}
