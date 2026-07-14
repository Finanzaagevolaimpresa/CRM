export const dynamic = 'force-dynamic';
import Link from 'next/link';
import { PrimaryButton } from '@/components/actions';
import { createPreAnalysisAndRedirect } from '@/lib/form-actions';
import { Card, EmptyState, MetaCell, PageHeader, StatusBadge, Table } from '@/components/ui';
import { prisma } from '@/lib/prisma';
import { hasPermission, requirePermission } from '@/lib/auth';
export default async function Page() {
  const session = await requirePermission('dossier.read');
  const canWrite = hasPermission(session, 'project.write');
  const [items, clientRows, projectRows] = await Promise.all([prisma.preAnalysis.findMany({ orderBy: { approvedAt: 'desc' } }), prisma.client.findMany({ where: { deletedAt: null } }), prisma.project.findMany({ where: { deletedAt: null } })]);
  const clients = new Map(clientRows.map((c) => [c.id, c.displayName]));
  const projects = new Map(projectRows.map((p) => [p.id, p.title]));
  return <div className="space-y-6"><PageHeader title="Pre-analisi" description="Bozze interne da revisionare: nessun output viene considerato approvato senza controllo umano."/>{canWrite ? <Card title="Crea pre-analisi"><form action={createPreAnalysisAndRedirect} className="grid gap-3 md:grid-cols-4"><select className="rounded-xl border p-3" name="clientId" required>{clientRows.map(c=><option key={c.id} value={c.id}>{c.displayName}</option>)}</select><select className="rounded-xl border p-3" name="projectId" required>{projectRows.map(p=><option key={p.id} value={p.id}>{p.title}</option>)}</select><input className="rounded-xl border p-3 md:col-span-2" name="internalSummary" placeholder="Sintesi interna"/><PrimaryButton type="submit" className="md:col-span-4">Crea pre-analisi</PrimaryButton></form></Card> : null}<Card title="Elenco operativo">{items.length === 0 ? <EmptyState title="Nessun elemento presente">Non ci sono record da lavorare per questa sezione.</EmptyState> : <Table headers={['Cliente', 'Progetto', 'Stato', 'Sintesi', 'Tracciabilità', 'Azione']} rows={items.map((x) => [clients.get(x.clientId) ?? '—', projects.get(x.projectId) ?? '—', <StatusBadge status={x.status} key='s' />, x.internalSummary ?? 'Bozza interna', <MetaCell key='m' createdAt={x.createdAt} updatedAt={x.updatedAt} />, <Link className='font-bold text-fai-blue underline' href={`/preanalyses/${x.id}`} key='a'>Apri</Link>])} />}</Card></div>;
}
