import Link from 'next/link';
import { SecondaryLink } from '@/components/actions';
import { Card, EmptyState, PageHeader, Stat, StatusBadge, Table, formatDateTime } from '@/components/ui';
import { requirePermission } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { canViewTechnicalPractice } from '@/lib/access-control';

export const dynamic = 'force-dynamic';

const buckets = [
  ['da_progettare', 'Pratiche da progettare'],
  ['in_progettazione', 'In progettazione'],
  ['documenti_richiesti', 'Documenti richiesti'],
  ['pronta_presentazione', 'Pronte per presentazione'],
  ['presentata', 'Presentate'],
  ['integrazione_richiesta', 'Integrazioni richieste'],
  ['in_istruttoria', 'In istruttoria'],
  ['approvata', 'Approvate'],
  ['respinta', 'Respinte'],
] as const;

export default async function Page() {
  const session = await requirePermission('technical.read');
  const [practices, clients, projects, services, users] = await Promise.all([
    prisma.technicalPractice.findMany({ where: { deletedAt: null } }),
    prisma.client.findMany({ where: { deletedAt: null } }),
    prisma.project.findMany({ where: { deletedAt: null }, select: { id: true, clientId: true } }),
    prisma.clientService.findMany({ where: { deletedAt: null }, select: { id: true, clientId: true, projectId: true } }),
    prisma.user.findMany({ where: { active: true }, select: { id: true, name: true } }),
  ]);
  const clientById = new Map(clients.map((client) => [client.id, client]));
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const serviceById = new Map(services.map((service) => [service.id, service]));
  const visiblePractices = practices.filter((practice) => {
    const client = clientById.get(practice.clientId) ?? null;
    const project = practice.projectId ? projectById.get(practice.projectId) ?? null : null;
    const service = practice.clientServiceId ? serviceById.get(practice.clientServiceId) ?? null : null;
    if (!client) return false;
    if (practice.projectId && (!project || project.clientId !== practice.clientId)) return false;
    if (practice.clientServiceId && (!service || service.clientId !== practice.clientId)) return false;
    if (service?.projectId) {
      const serviceProject = projectById.get(service.projectId);
      if (!serviceProject || serviceProject.clientId !== practice.clientId) return false;
      if (project && project.id !== serviceProject.id) return false;
    }
    return canViewTechnicalPractice(session, { ...practice, client });
  });
  const next7 = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const priorityRank = { urgente: 0, alta: 1, media: 2, bassa: 3 } as const;
  const urgent = visiblePractices
    .filter((practice) => practice.priority === 'urgente' || (practice.dueDate && practice.dueDate <= next7))
    .sort((left, right) => {
      const leftDue = left.dueDate?.getTime() ?? Number.POSITIVE_INFINITY;
      const rightDue = right.dueDate?.getTime() ?? Number.POSITIVE_INFINITY;
      return leftDue - rightDue || priorityRank[left.priority] - priorityRank[right.priority];
    })
    .slice(0, 10);
  const count = (status: string) => visiblePractices.filter((item) => item.status === status).length;
  const clientOf = (id: string) => clients.find((client) => client.id === id)?.displayName ?? 'Cliente';
  const userOf = (id?: string | null) => users.find((user) => user.id === id)?.name ?? 'Da assegnare';

  return <div className="space-y-6">
    <PageHeader title="Ufficio Tecnico" description="Dashboard operativa per progettare, preparare e monitorare pratiche verso enti e portali. Nessun invio automatico: ogni aggiornamento cliente va verificato prima dell’invio." />
    <div className="flex flex-wrap gap-2"><SecondaryLink href="/technical-office/practices">Lista pratiche</SecondaryLink><SecondaryLink href="/technical-office/practices?new=1">Nuova pratica</SecondaryLink></div>
    <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">{buckets.map(([status, label]) => <Stat key={status} label={label} value={count(status)} description={status.replaceAll('_', ' ')} tone={status.includes('approv') ? 'green' : status.includes('resp') || status.includes('integrazione') ? 'orange' : 'blue'} />)}</section>
    <Card title="Scadenze urgenti e prossime azioni">
      {urgent.length === 0 ? <EmptyState title="Nessuna urgenza tecnica" /> : <Table headers={['Pratica','Cliente','Stato','Priorità','Scadenza','Responsabili']} rows={urgent.map((p) => [<Link key="p" className="font-bold text-fai-blue underline" href={`/technical-office/practices/${p.id}`}>{p.title}</Link>, clientOf(p.clientId), <StatusBadge key="s" status={p.status} />, <StatusBadge key="p" status={p.priority} />, formatDateTime(p.dueDate), `${userOf(p.technicalOwnerId)} · Comm.: ${userOf(p.commercialOwnerId)}`])} />}
    </Card>
  </div>;
}
