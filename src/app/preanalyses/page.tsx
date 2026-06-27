export const dynamic = 'force-dynamic';
import Link from 'next/link';
import { Card, EmptyState, PageHeader, StatusBadge, Table } from '@/components/ui';
import { prisma } from '@/lib/prisma';
export default async function Page() {
  const [items, clientRows, projectRows] = await Promise.all([prisma.preAnalysis.findMany({ orderBy: { approvedAt: 'desc' } }), prisma.client.findMany({ where: { deletedAt: null } }), prisma.project.findMany({ where: { deletedAt: null } })]);
  const clients = new Map(clientRows.map((c) => [c.id, c.displayName]));
  const projects = new Map(projectRows.map((p) => [p.id, p.title]));
  return <div className="space-y-6"><PageHeader title="Pre-analisi" description="Bozze interne da revisionare: nessun output viene considerato approvato senza controllo umano."/><Card title="Elenco operativo">{items.length === 0 ? <EmptyState title="Nessun elemento presente">Non ci sono record da lavorare per questa sezione.</EmptyState> : <Table headers={['Cliente', 'Progetto', 'Stato', 'Sintesi', 'Azione']} rows={items.map((x) => [clients.get(x.clientId) ?? '—', projects.get(x.projectId) ?? '—', <StatusBadge status={x.status} key='s' />, x.internalSummary ?? 'Bozza interna', <Link className='font-bold text-fai-blue underline' href={`/preanalyses/${x.id}`} key='a'>Apri</Link>])} />}</Card></div>;
}
