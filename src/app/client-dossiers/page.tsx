export const dynamic = 'force-dynamic';

import { OpenLink } from '@/components/actions';
import { Card, EmptyState, MetaCell, PageHeader, StatusBadge, Table } from '@/components/ui';
import { requirePermission } from '@/lib/auth';
import { canViewClient } from '@/lib/access-control';
import { prisma } from '@/lib/prisma';

export default async function Page() {
  const session = await requirePermission('dossier.read');
  const [dossiers, clients] = await Promise.all([
    prisma.clientDossier.findMany({ orderBy: { updatedAt: 'desc' } }),
    prisma.client.findMany({ where: { deletedAt: null } }),
  ]);
  const clientsById = new Map(clients.map((client) => [client.id, client]));
  const visibleDossiers = dossiers.filter((dossier) => {
    const client = clientsById.get(dossier.clientId);
    return client ? canViewClient(session, client) : false;
  });

  return <div className="space-y-6"><PageHeader title="Dossier AI / Bozze" description="Elenco interno delle bozze dossier e pre-analisi salvate nel CRM. Nessuna bozza viene inviata automaticamente al cliente."/><Card title="Bozze dossier">{visibleDossiers.length === 0 ? <EmptyState title="Nessuna bozza disponibile">Le bozze create da output AI o lavorazioni interne appariranno in questa coda protetta.</EmptyState> : <Table headers={['Titolo', 'Cliente', 'Tipo', 'Stato', 'Tracciabilità', 'Azione']} rows={visibleDossiers.map((dossier) => [<span className="font-semibold text-fai-navy" key="t">{dossier.title}</span>, clientsById.get(dossier.clientId)?.displayName ?? '—', dossier.type.replaceAll('_', ' '), <StatusBadge status={dossier.status} key="s" />, <MetaCell key="m" createdAt={dossier.createdAt} updatedAt={dossier.updatedAt} />, <OpenLink href={`/client-dossiers/${dossier.id}`} key="a">Apri</OpenLink>])} />}</Card></div>;
}
