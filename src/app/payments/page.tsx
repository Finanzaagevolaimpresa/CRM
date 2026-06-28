export const dynamic = 'force-dynamic';
import Link from 'next/link';
import { PrimaryButton } from '@/components/actions';
import { registerPaymentAndRefresh } from '@/lib/form-actions';
import { Card, EmptyState, PageHeader, StatusBadge, Table } from '@/components/ui';
import { prisma } from '@/lib/prisma';
export default async function Page() {
  const [items, clientRows, projectRows] = await Promise.all([prisma.payment.findMany({ orderBy: { dueDate: 'asc' } }), prisma.client.findMany({ where: { deletedAt: null } }), prisma.project.findMany({ where: { deletedAt: null } })]);
  const clients = new Map(clientRows.map((c) => [c.id, c.displayName]));
  const projects = new Map(projectRows.map((p) => [p.id, p.title])); const contracts=await prisma.contract.findMany();
  return <div className="space-y-6"><PageHeader title="Pagamenti" description="Scadenze, incassi e note amministrative collegate ai contratti."/><Card title="Registra pagamento"><form action={registerPaymentAndRefresh} className="grid gap-3 md:grid-cols-5"><select className="rounded-xl border p-3" name="contractId" required>{contracts.map(c=><option key={c.id} value={c.id}>{c.contractNumber}</option>)}</select><select className="rounded-xl border p-3" name="clientId" required>{clientRows.map(c=><option key={c.id} value={c.id}>{c.displayName}</option>)}</select><input className="rounded-xl border p-3" name="taxableAmount" type="number" min="0" step="0.01" placeholder="Imponibile" required/><input className="rounded-xl border p-3" name="vatAmount" type="number" min="0" step="0.01" placeholder="IVA" required/><input className="rounded-xl border p-3" name="totalAmount" type="number" min="0" step="0.01" placeholder="Totale" required/><PrimaryButton type="submit" className="md:col-span-5">Registra pagamento</PrimaryButton></form></Card><Card title="Elenco operativo">{items.length === 0 ? <EmptyState title="Nessun elemento presente">Non ci sono record da lavorare per questa sezione.</EmptyState> : <Table headers={['Cliente', 'Totale', 'Metodo', 'Scadenza', 'Stato']} rows={items.map((x) => [clients.get(x.clientId) ?? '—', `€ ${Number(x.totalAmount).toLocaleString('it-IT')}`, x.method ?? '—', x.dueDate ? x.dueDate.toISOString().slice(0,10) : '—', <StatusBadge status={x.status} key='s' />])} />}</Card></div>;
}
