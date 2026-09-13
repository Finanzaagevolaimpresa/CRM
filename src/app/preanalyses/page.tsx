export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { Card, EmptyState, MetaCell, PageHeader, StatusBadge, Table } from '@/components/ui';
import { canViewClient, canViewProject } from '@/lib/access-control';
import { canViewPreAnalysisListRecord } from '@/lib/business-list-access';
import { hasPermission, requirePermission } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export default async function Page() {
  const session = await requirePermission('dossier.read');
  const [items, clientRows, projectRows, companyRows] = await Promise.all([
    prisma.preAnalysis.findMany({ orderBy: { approvedAt: 'desc' } }),
    prisma.client.findMany({ where: { deletedAt: null } }),
    prisma.project.findMany({ where: { deletedAt: null } }),
    prisma.company.findMany({ where: { deletedAt: null }, select: { id: true, clientId: true } }),
  ]);
  const visibleClients = clientRows.filter((client) => canViewClient(session, client));
  const clientById = new Map(visibleClients.map((client) => [client.id, client]));
  const visibleProjects = projectRows.filter((project) => {
    const client = clientById.get(project.clientId);
    return !!client && canViewProject(session, { ...project, client });
  });
  const projectById = new Map(visibleProjects.map((project) => [project.id, project]));
  const companyById = new Map(companyRows.map((company) => [company.id, company]));
  const visibleItems = items.filter((item) => {
    const project = projectById.get(item.projectId);
    return canViewPreAnalysisListRecord(session, {
      preAnalysis: item, client: clientById.get(item.clientId) ?? null, project: project ?? null,
      company: item.companyId ? companyById.get(item.companyId) ?? null : null,
    });
  });
  const canWrite = hasPermission(session, 'project.write');

  return <div className="space-y-6">
    <PageHeader title="Pre-analisi" description="Bozze interne nel perimetro autorizzato: nessun output viene considerato approvato senza controllo umano." />
    {canWrite ? <Card title="Crea pre-analisi"><p className="text-sm text-slate-600">Avvia la bozza dal fascicolo cliente o dalla scheda progetto: il contesto sarà vincolato e verificato dal server.</p></Card> : null}
    <Card title="Elenco operativo">{visibleItems.length === 0 ? <EmptyState title="Nessun elemento presente">Non ci sono pre-analisi disponibili nel tuo perimetro.</EmptyState> : <Table headers={['Cliente', 'Progetto', 'Stato', 'Sintesi', 'Tracciabilità', 'Azione']} rows={visibleItems.map((item) => [clientById.get(item.clientId)?.displayName ?? '—', projectById.get(item.projectId)?.title ?? '—', <StatusBadge status={item.status} key="s" />, item.internalSummary ?? 'Bozza interna', <MetaCell key="m" createdAt={item.createdAt} updatedAt={item.updatedAt} />, <Link className="font-bold text-fai-blue underline" href={`/preanalyses/${item.id}`} key="a">Apri</Link>])} />}</Card>
  </div>;
}
