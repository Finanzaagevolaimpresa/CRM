export const dynamic = 'force-dynamic';

import { SecondaryLink } from '@/components/actions';
import { Card, EmptyState, PageHeader, StatusBadge } from '@/components/ui';
import { requireAuth } from '@/lib/auth';

export default async function Page() {
  await requireAuth(["admin", "direzione", "consulente", "revisore", "backoffice"]);

  return <div className="space-y-6"><PageHeader title="Enti / Portali" description="Area in preparazione per riferimenti operativi a enti, portali e canali di deposito manuale."/><Card title="Stato lavorazione"><div className="space-y-4"><StatusBadge status="in preparazione" /><EmptyState title="Vista in preparazione">Questa pagina non contiene credenziali, integrazioni attive o invii automatici.</EmptyState><SecondaryLink href="/technical-office">Vai a Ufficio Tecnico</SecondaryLink></div></Card></div>;
}
