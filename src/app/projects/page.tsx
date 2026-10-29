export const dynamic = 'force-dynamic';
import Link from 'next/link';
import { PrimaryButton } from '@/components/actions';
import { createProjectAndRedirect } from '@/lib/form-actions';
import { Card, EmptyState, MetaCell, PageHeader, StatusBadge, Table } from '@/components/ui';
import { prisma } from '@/lib/prisma';
import { hasPermission, requirePermission } from '@/lib/auth';
import { canEditClient, canViewProject } from '@/lib/access-control';
import { notFound } from 'next/navigation';
import { listManagedProjectLifecycle } from '@/lib/project-lifecycle';
import { ProjectLifecycleControls } from '@/components/project-lifecycle-controls';
import { OperationalWorkList } from '@/components/operational-work-list';
import { isOperationalTechnician } from '@/lib/operational-work';
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requirePermission('project.read');
  const query = await searchParams;
  const view = query.view;
  if (isOperationalTechnician(session.role) && view !== 'archive' && view !== 'trash' && query.new !== '1')
    return <OperationalWorkList session={session} kind="Project" title="Progetti" path="/projects" query={query} />;
  const tabs = <nav aria-label="Stato progetti" className="flex flex-wrap gap-4">
    <Link href="/projects" className="font-bold underline">Progetti operativi</Link>
    {hasPermission(session, 'project.write') && <><Link href="/projects?view=archive" className="font-bold underline">Archivio</Link><Link href="/projects?view=trash" className="font-bold underline">Cestino</Link></>}
  </nav>;
  if (view === 'archive' || view === 'trash') {
    if (!hasPermission(session, 'project.write')) notFound();
    const rows = await listManagedProjectLifecycle(prisma, session, view === 'trash' ? 'trash' : 'archived');
    return <div className="crm-space-y-6"><PageHeader title={view === 'trash' ? 'Cestino progetti' : 'Archivio progetti'}
      description="Progetti sospesi, con documenti e collegamenti conservati. Solo i gestori già autorizzati possono ripristinarli." />
      {tabs}
      {rows.length === 0 ? <EmptyState title="Nessun progetto" /> : rows.map(row => <Card key={row.id} title={row.title}>
        <p className="mb-3">Cliente: {row.clientName}</p>
        <ProjectLifecycleControls id={row.id} updatedAt={row.updatedAt} state={row.state} />
      </Card>)}
    </div>;
  }
  const [projectItems, clientRows, userRows] = await Promise.all([prisma.project.findMany({ where: { deletedAt: null, status: { not: 'archiviato' } }, orderBy: { updatedAt: 'desc' } }), prisma.client.findMany({ where: { deletedAt: null } }), prisma.user.findMany({ where: { active: true } })]);
  const clientById = new Map(clientRows.map((c) => [c.id, c]));
  const items = projectItems.filter((project) => canViewProject(session, { ...project, client: clientById.get(project.clientId) }));
  const clients = new Map(clientRows.map((c) => [c.id, c.displayName]));
  const users = new Map(userRows.map((u) => [u.id, u.name]));
  const writableClients = hasPermission(session, 'project.write') ? clientRows.filter((client) => canEditClient(session, client)) : [];
  return <div className="crm-space-y-6"><PageHeader title="Progetti" description="Progetti di investimento, priorità, scenari e condizioni operative."/>{tabs}{writableClients.length ? <Card title="Crea progetto base"><form action={createProjectAndRedirect} className="grid gap-3 md:grid-cols-5"><select className="rounded-xl border p-3" name="clientId" required>{writableClients.map(c=><option key={c.id} value={c.id}>{c.displayName}</option>)}</select><input className="rounded-xl border p-3 md:col-span-2" name="title" placeholder="Titolo progetto" required/><input className="rounded-xl border p-3" name="totalInvestment" type="number" min="0" step="0.01" placeholder="Investimento"/><PrimaryButton type="submit">Crea progetto</PrimaryButton></form></Card> : null}<Card title="Elenco operativo">{items.length === 0 ? <EmptyState title="Nessun elemento presente">Non ci sono record da lavorare per questa sezione.</EmptyState> : <Table headers={['Titolo', 'Cliente', 'Investimento', 'Stato', 'Tracciabilità', 'Azione']} rows={items.map((x) => [<span className='font-semibold text-fai-navy' key='n'>{x.title}</span>, clients.get(x.clientId) ?? '—', x.totalInvestment ? `€ ${Number(x.totalInvestment).toLocaleString('it-IT')}` : '—', <StatusBadge status={x.status} key='s' />, <MetaCell key='m' createdAt={x.createdAt} updatedAt={x.updatedAt} owner={x.consultantId ? users.get(x.consultantId) : null} />, <Link className='font-bold text-fai-blue underline' href={`/projects/${x.id}`} key='a'>Apri</Link>])} />}</Card></div>;
}
