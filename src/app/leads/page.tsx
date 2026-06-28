export const dynamic = 'force-dynamic';
import Link from 'next/link';
import { PrimaryButton } from '@/components/actions';
import { createLeadAndRedirect } from '@/lib/form-actions';
import { Card, EmptyState, PageHeader, StatusBadge, Table } from '@/components/ui';
import { prisma } from '@/lib/prisma';
export default async function Page() {
  const [items, clientRows, projectRows] = await Promise.all([prisma.lead.findMany({ where: { deletedAt: null }, orderBy: { updatedAt: 'desc' } }), prisma.client.findMany({ where: { deletedAt: null } }), prisma.project.findMany({ where: { deletedAt: null } })]);
  const clients = new Map(clientRows.map((c) => [c.id, c.displayName]));
  const projects = new Map(projectRows.map((p) => [p.id, p.title]));
  return <div className="space-y-6"><PageHeader title="Lead" description="Gestione commerciale dei contatti: stato, interesse, assegnazione e prossima azione."/><Card title="Crea lead"><form action={createLeadAndRedirect} className="grid gap-3 md:grid-cols-4"><input className="rounded-xl border p-3" name="firstName" placeholder="Nome" required/><input className="rounded-xl border p-3" name="lastName" placeholder="Cognome" required/><input className="rounded-xl border p-3" name="email" type="email" placeholder="Email"/><input className="rounded-xl border p-3" name="phone" placeholder="Telefono"/><input className="rounded-xl border p-3 md:col-span-3" name="interest" placeholder="Interesse"/><PrimaryButton type="submit">Crea lead</PrimaryButton></form></Card><Card title="Elenco operativo">{items.length === 0 ? <EmptyState title="Nessun elemento presente">Non ci sono record da lavorare per questa sezione.</EmptyState> : <Table headers={['Nome', 'Interesse', 'Stato', 'Prossima azione', 'Azione']} rows={items.map((x) => [<span className='font-semibold text-fai-navy' key='n'>{x.firstName} {x.lastName}</span>, x.interest ?? '—', <StatusBadge status={x.status} key='s' />, x.nextAction ? x.nextAction.toISOString().slice(0,10) : 'Da pianificare', <Link className='font-bold text-fai-blue underline' href={`/leads/${x.id}`} key='a'>Apri</Link>])} />}</Card></div>;
}
