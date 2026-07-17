export const dynamic = 'force-dynamic';

import { SecondaryLink } from '@/components/actions';
import { Card, EmptyState, PageHeader, StatusBadge } from '@/components/ui';
import { requirePermission } from '@/lib/auth';

export default async function Page() {
  await requirePermission('technical.read');

  return <div className="space-y-6"><PageHeader title="Integrazioni tecniche" description="Area in preparazione per monitorare richieste di integrazione documentale o tecnica."/><Card title="Stato lavorazione"><div className="space-y-4"><StatusBadge status="in preparazione" /><EmptyState title="Vista in preparazione">Le integrazioni restano lavorazioni interne e manuali, senza modifica del database in questo step.</EmptyState><SecondaryLink href="/technical-office">Vai a Ufficio Tecnico</SecondaryLink></div></Card></div>;
}
