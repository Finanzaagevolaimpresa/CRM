export const dynamic = 'force-dynamic';

import { OpenLink } from '@/components/actions';
import { Card, EmptyState, MetaCell, PageHeader, StatusBadge, Table } from '@/components/ui';
import { requirePermission } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export default async function Page() {
  await requirePermission('lead.read');
  const [offers, leads, clients] = await Promise.all([
    prisma.commercialOffer.findMany({ where: { deletedAt: null }, orderBy: { updatedAt: 'desc' } }),
    prisma.lead.findMany({ where: { deletedAt: null } }),
    prisma.client.findMany({ where: { deletedAt: null } }),
  ]);
  const leadNames = new Map(leads.map((lead) => [lead.id, lead.companyName || `${lead.firstName} ${lead.lastName}`.trim()]));
  const clientNames = new Map(clients.map((client) => [client.id, client.displayName]));

  return <div className="space-y-6"><PageHeader title="Offerte" description="Vista autonoma delle offerte commerciali già registrate. Creazione e modifica restano collegate ai lead, senza automatismi verso il cliente."/><Card title="Elenco offerte">{offers.length === 0 ? <EmptyState title="Nessuna offerta presente">Le nuove offerte vengono preparate dalle schede lead e restano bozze interne fino alla gestione manuale.</EmptyState> : <Table headers={['Titolo', 'Contesto', 'Totale', 'Stato', 'Tracciabilità', 'Azione']} rows={offers.map((offer) => [<span className="font-semibold text-fai-navy" key="t">{offer.title}</span>, offer.clientId ? clientNames.get(offer.clientId) ?? 'Cliente non disponibile' : offer.leadId ? leadNames.get(offer.leadId) ?? 'Lead non disponibile' : '—', `€ ${Number(offer.totalAmount).toLocaleString('it-IT')}`, <StatusBadge status={offer.status} key="s" />, <MetaCell key="m" createdAt={offer.createdAt} updatedAt={offer.updatedAt} />, <OpenLink href={`/commercial-offers/${offer.id}`} key="a">Apri</OpenLink>])} />}</Card></div>;
}
