export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { PrimaryButton } from '@/components/actions';
import { Card, EmptyState, MetaCell, PageHeader, StatusBadge, Table } from '@/components/ui';
import { canViewClient, canViewProject } from '@/lib/access-control';
import { hasPermission, requirePermission } from '@/lib/auth';
import { createDossierAndRedirect } from '@/lib/form-actions';
import { prisma } from '@/lib/prisma';

export default async function Page() {
  const session = await requirePermission('dossier.read');
  const [items, clientRows, projectRows, preAnalyses] = await Promise.all([
    prisma.dossier.findMany(),
    prisma.client.findMany({ where: { deletedAt: null } }),
    prisma.project.findMany({ where: { deletedAt: null } }),
    prisma.preAnalysis.findMany({ select: { id: true, clientId: true, projectId: true } }),
  ]);
  const visibleClients = clientRows.filter((client) => canViewClient(session, client));
  const clientById = new Map(visibleClients.map((client) => [client.id, client]));
  const visibleProjects = projectRows.filter((project) => {
    const client = clientById.get(project.clientId);
    return !!client && canViewProject(session, { ...project, client });
  });
  const projectById = new Map(visibleProjects.map((project) => [project.id, project]));
  const preAnalysisById = new Map(preAnalyses.map((item) => [item.id, item]));
  const visibleItems = items.filter((item) => {
    const project = projectById.get(item.projectId);
    if (!clientById.has(item.clientId) || !project || project.clientId !== item.clientId) return false;
    if (!item.preAnalysisId) return true;
    const preAnalysis = preAnalysisById.get(item.preAnalysisId);
    return !!preAnalysis && preAnalysis.clientId === item.clientId && preAnalysis.projectId === item.projectId;
  });
  const canWrite = hasPermission(session, 'project.write');

  return <div className="space-y-6">
    <PageHeader title="Dossier" description="Dossier operativi nel perimetro cliente/progetto autorizzato." />
    {canWrite ? <Card title="Crea dossier"><form action={createDossierAndRedirect} className="grid gap-3 md:grid-cols-5"><select className="rounded-xl border p-3" name="clientId" required>{visibleClients.map((client) => <option key={client.id} value={client.id}>{client.displayName}</option>)}</select><select className="rounded-xl border p-3" name="projectId" required>{visibleProjects.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}</select><input className="rounded-xl border p-3" name="title" placeholder="Titolo" required/><input className="rounded-xl border p-3" name="type" placeholder="Tipo" defaultValue="operativo" required/><PrimaryButton type="submit">Crea dossier</PrimaryButton></form></Card> : null}
    <Card title="Elenco operativo">{visibleItems.length === 0 ? <EmptyState title="Nessun elemento presente">Non ci sono dossier disponibili nel tuo perimetro.</EmptyState> : <Table headers={['Titolo', 'Cliente', 'Tipo', 'Stato', 'Tracciabilità', 'Azione']} rows={visibleItems.map((item) => [<span className="font-semibold text-fai-navy" key="n">{item.title}</span>, clientById.get(item.clientId)?.displayName ?? '—', item.type, <StatusBadge status={item.status} key="s" />, <MetaCell key="m" createdAt={item.createdAt} updatedAt={item.updatedAt} owner={item.modifiedById ?? null} />, <Link className="font-bold text-fai-blue underline" href={`/dossiers/${item.id}`} key="a">Apri</Link>])} />}</Card>
  </div>;
}
