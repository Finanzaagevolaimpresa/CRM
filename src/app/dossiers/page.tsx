export const dynamic = 'force-dynamic';
import Link from 'next/link';
import { PrimaryButton } from '@/components/actions';
import { createDossierAndRedirect } from '@/lib/form-actions';
import { Card, EmptyState, MetaCell, PageHeader, StatusBadge, Table } from '@/components/ui';
import { prisma } from '@/lib/prisma';
import { hasPermission, requirePermission } from '@/lib/auth';
import { canViewClient, canViewProject } from '@/lib/access-control';
export default async function Page() {
  const session = await requirePermission('dossier.read');
  const canWrite = hasPermission(session, 'dossier.write');
  const [items, clientRows, projectRows] = await Promise.all([prisma.dossier.findMany(), prisma.client.findMany({ where: { deletedAt: null } }), prisma.project.findMany({ where: { deletedAt: null } })]);
  const clientById = new Map(clientRows.map((c) => [c.id, c]));
  const visibleClients = clientRows.filter((client) => canViewClient(session, client));
  const visibleClientIds = new Set(visibleClients.map((client) => client.id));
  const visibleProjects = projectRows.filter((project) => canViewProject(session, { ...project, client: clientById.get(project.clientId) ?? null }));
  const visibleProjectIds = new Set(visibleProjects.map((project) => project.id));
  const visibleItems = items.filter((dossier) => visibleClientIds.has(dossier.clientId) && visibleProjectIds.has(dossier.projectId));
  const clients = new Map(visibleClients.map((c) => [c.id, c.displayName]));
  return <div className="space-y-6"><PageHeader title="Dossier" description="Dossier operativi in bozza, revisione interna o consegna manuale."/>{canWrite ? <Card title="Crea dossier"><form action={createDossierAndRedirect} className="grid gap-3 md:grid-cols-5"><select className="rounded-xl border p-3" name="clientId" required>{visibleClients.map(c=><option key={c.id} value={c.id}>{c.displayName}</option>)}</select><select className="rounded-xl border p-3" name="projectId" required>{visibleProjects.map(p=><option key={p.id} value={p.id}>{p.title}</option>)}</select><input className="rounded-xl border p-3" name="title" placeholder="Titolo" required/><input className="rounded-xl border p-3" name="type" placeholder="Tipo" defaultValue="operativo" required/><PrimaryButton type="submit">Crea dossier</PrimaryButton></form></Card> : null}<Card title="Elenco operativo">{visibleItems.length === 0 ? <EmptyState title="Nessun elemento presente">Non ci sono record da lavorare per questa sezione.</EmptyState> : <Table headers={['Titolo', 'Cliente', 'Tipo', 'Stato', 'Tracciabilità', 'Azione']} rows={visibleItems.map((x) => [<span className='font-semibold text-fai-navy' key='n'>{x.title}</span>, clients.get(x.clientId) ?? '—', x.type, <StatusBadge status={x.status} key='s' />, <MetaCell key='m' createdAt={x.createdAt} updatedAt={x.updatedAt} owner={x.modifiedById ?? null} />, <Link className='font-bold text-fai-blue underline' href={`/dossiers/${x.id}`} key='a'>Apri</Link>])} />}</Card></div>;
}
