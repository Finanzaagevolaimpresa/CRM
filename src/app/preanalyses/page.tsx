export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { PrimaryButton } from '@/components/actions';
import { Card, EmptyState, MetaCell, PageHeader, StatusBadge, Table } from '@/components/ui';
import { canViewClient, canViewProject } from '@/lib/access-control';
import { hasPermission, requirePermission } from '@/lib/auth';
import { createPreAnalysisAndRedirect } from '@/lib/form-actions';
import { prisma } from '@/lib/prisma';

export default async function Page() {
  const session = await requirePermission('dossier.read');
  const [items, clientRows, projectRows] = await Promise.all([
    prisma.preAnalysis.findMany({ orderBy: { approvedAt: 'desc' } }),
    prisma.client.findMany({ where: { deletedAt: null } }),
    prisma.project.findMany({ where: { deletedAt: null } }),
  ]);
  const visibleClients = clientRows.filter((client) => canViewClient(session, client));
  const clientById = new Map(visibleClients.map((client) => [client.id, client]));
  const visibleProjects = projectRows.filter((project) => {
    const client = clientById.get(project.clientId);
    return !!client && canViewProject(session, { ...project, client });
  });
  const projectById = new Map(visibleProjects.map((project) => [project.id, project]));
  const visibleItems = items.filter((item) => {
    const project = projectById.get(item.projectId);
    return clientById.has(item.clientId) && !!project && project.clientId === item.clientId;
  });
  const canWrite = hasPermission(session, 'project.write');

  return <div className="space-y-6">
    <PageHeader title="Pre-analisi" description="Bozze interne nel perimetro autorizzato: nessun output viene considerato approvato senza controllo umano." />
    {canWrite ? <Card title="Crea pre-analisi"><form action={createPreAnalysisAndRedirect} className="grid gap-3 md:grid-cols-4"><select className="rounded-xl border p-3" name="clientId" required>{visibleClients.map((client) => <option key={client.id} value={client.id}>{client.displayName}</option>)}</select><select className="rounded-xl border p-3" name="projectId" required>{visibleProjects.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}</select><input className="rounded-xl border p-3 md:col-span-2" name="internalSummary" placeholder="Sintesi interna"/><PrimaryButton type="submit" className="md:col-span-4">Crea pre-analisi</PrimaryButton></form></Card> : null}
    <Card title="Elenco operativo">{visibleItems.length === 0 ? <EmptyState title="Nessun elemento presente">Non ci sono pre-analisi disponibili nel tuo perimetro.</EmptyState> : <Table headers={['Cliente', 'Progetto', 'Stato', 'Sintesi', 'Tracciabilità', 'Azione']} rows={visibleItems.map((item) => [clientById.get(item.clientId)?.displayName ?? '—', projectById.get(item.projectId)?.title ?? '—', <StatusBadge status={item.status} key="s" />, item.internalSummary ?? 'Bozza interna', <MetaCell key="m" createdAt={item.createdAt} updatedAt={item.updatedAt} />, <Link className="font-bold text-fai-blue underline" href={`/preanalyses/${item.id}`} key="a">Apri</Link>])} />}</Card>
  </div>;
}
