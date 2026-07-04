export const dynamic = 'force-dynamic';

import { SecondaryLink } from '@/components/actions';
import { Card, EmptyState, PageHeader, StatusBadge } from '@/components/ui';
import { requireAuth } from '@/lib/auth';

export default async function Page() {
  await requireAuth(["admin", "direzione", "consulente", "revisore", "backoffice"]);

  return <div className="space-y-6"><PageHeader title="Pratiche tecniche" description="Area in preparazione per la coda delle pratiche tecniche collegate a clienti, progetti e servizi."/><Card title="Stato lavorazione"><div className="space-y-4"><StatusBadge status="in preparazione" /><EmptyState title="Vista in preparazione">Nessuna presentazione verso enti o portali viene eseguita automaticamente dal CRM.</EmptyState><SecondaryLink href="/technical-office">Vai a Ufficio Tecnico</SecondaryLink></div></Card></div>;
}
