import Link from 'next/link';
import { SecondaryLink } from '@/components/actions';
import { Card, EmptyState, PageHeader, Stat, StatusBadge, Table, formatDateTime } from '@/components/ui';
import { requirePermission } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

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
  await requirePermission('technical.read');
  const [grouped, urgent, clients, users] = await Promise.all([
    prisma.technicalPractice.groupBy({ by: ['status'], where: { deletedAt: null }, _count: { _all: true } }),
    prisma.technicalPractice.findMany({ where: { deletedAt: null, OR: [{ priority: 'urgente' }, { dueDate: { lte: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) } }] }, orderBy: [{ dueDate: 'asc' }, { priority: 'desc' }], take: 10 }),
    prisma.client.findMany({ select: { id: true, displayName: true } }),
    prisma.user.findMany({ where: { active: true }, select: { id: true, name: true } }),
  ]);
  const count = (status: string) => grouped.find((item) => item.status === status)?._count._all ?? 0;
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
