export const dynamic = 'force-dynamic';
import Link from 'next/link';
import { PrimaryButton } from '@/components/actions';
import { createDossierAndRedirect } from '@/lib/form-actions';
import { Card, EmptyState, MetaCell, PageHeader, StatusBadge, Table } from '@/components/ui';
import { prisma } from '@/lib/prisma';
export default async function Page() {
  const [items, clientRows, projectRows] = await Promise.all([prisma.dossier.findMany(), prisma.client.findMany({ where: { deletedAt: null } }), prisma.project.findMany({ where: { deletedAt: null } })]);
  const clients = new Map(clientRows.map((c) => [c.id, c.displayName]));
  const projects = new Map(projectRows.map((p) => [p.id, p.title]));
  return <div className="space-y-6"><PageHeader title="Dossier" description="Dossier operativi in bozza, revisione interna o consegna manuale."/><Card title="Crea dossier"><form action={createDossierAndRedirect} className="grid gap-3 md:grid-cols-5"><select className="rounded-xl border p-3" name="clientId" required>{clientRows.map(c=><option key={c.id} value={c.id}>{c.displayName}</option>)}</select><select className="rounded-xl border p-3" name="projectId" required>{projectRows.map(p=><option key={p.id} value={p.id}>{p.title}</option>)}</select><input className="rounded-xl border p-3" name="title" placeholder="Titolo" required/><input className="rounded-xl border p-3" name="type" placeholder="Tipo" defaultValue="operativo" required/><PrimaryButton type="submit">Crea dossier</PrimaryButton></form></Card><Card title="Elenco operativo">{items.length === 0 ? <EmptyState title="Nessun elemento presente">Non ci sono record da lavorare per questa sezione.</EmptyState> : <Table headers={['Titolo', 'Cliente', 'Tipo', 'Stato', 'Tracciabilità', 'Azione']} rows={items.map((x) => [<span className='font-semibold text-fai-navy' key='n'>{x.title}</span>, clients.get(x.clientId) ?? '—', x.type, <StatusBadge status={x.status} key='s' />, <MetaCell key='m' createdAt={x.createdAt} updatedAt={x.updatedAt} owner={x.modifiedById ?? null} />, <Link className='font-bold text-fai-blue underline' href={`/dossiers/${x.id}`} key='a'>Apri</Link>])} />}</Card></div>;
}
