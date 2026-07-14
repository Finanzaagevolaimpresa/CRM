export const dynamic = 'force-dynamic';

import { OpenLink } from '@/components/actions';
import { Card, EmptyState, MetaCell, PageHeader, StatusBadge, Table } from '@/components/ui';
import { requirePermission } from '@/lib/auth';
import { canViewClient, canViewClientContext } from '@/lib/access-control';
import { prisma } from '@/lib/prisma';

export default async function Page() {
  const session = await requirePermission('dossier.read');
  const [dossiers, clients, projects, services] = await Promise.all([
    prisma.clientDossier.findMany({ orderBy: { updatedAt: 'desc' } }),
    prisma.client.findMany({ where: { deletedAt: null } }),
    prisma.project.findMany({ where: { deletedAt: null } }),
    prisma.clientService.findMany({ where: { deletedAt: null } }),
  ]);
  const clientsById = new Map(clients.map((client) => [client.id, client]));
  const projectsById = new Map(projects.map((project) => [project.id, { ...project, client: clientsById.get(project.clientId) ?? null }]));
  const servicesById = new Map(services.map((service) => [service.id, { ...service, client: clientsById.get(service.clientId) ?? null, project: service.projectId ? projectsById.get(service.projectId) ?? null : null }]));
  const visibleDossiers = dossiers.filter((dossier) => {
    const client = clientsById.get(dossier.clientId);
    if (!client || !canViewClient(session, client)) return false;
    const project = dossier.projectId ? projectsById.get(dossier.projectId) ?? null : null;
    const clientService = dossier.clientServiceId ? servicesById.get(dossier.clientServiceId) ?? null : null;
    if (dossier.projectId && !project) return false;
    if (dossier.clientServiceId && !clientService) return false;
    return canViewClientContext(session, { clientId: dossier.clientId, client, project, clientService });
  });

  return <div className="space-y-6"><PageHeader title="Dossier AI / Bozze" description="Elenco interno delle bozze dossier e pre-analisi salvate nel CRM. Nessuna bozza viene inviata automaticamente al cliente."/><Card title="Bozze dossier">{visibleDossiers.length === 0 ? <EmptyState title="Nessuna bozza disponibile">Le bozze create da output AI o lavorazioni interne appariranno in questa coda protetta.</EmptyState> : <Table headers={['Titolo', 'Cliente', 'Tipo', 'Stato', 'Tracciabilità', 'Azione']} rows={visibleDossiers.map((dossier) => [<span className="font-semibold text-fai-navy" key="t">{dossier.title}</span>, clientsById.get(dossier.clientId)?.displayName ?? '—', dossier.type.replaceAll('_', ' '), <StatusBadge status={dossier.status} key="s" />, <MetaCell key="m" createdAt={dossier.createdAt} updatedAt={dossier.updatedAt} />, <OpenLink href={`/client-dossiers/${dossier.id}`} key="a">Apri</OpenLink>])} />}</Card></div>;
}
