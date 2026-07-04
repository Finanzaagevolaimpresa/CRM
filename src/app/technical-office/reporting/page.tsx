export const dynamic = 'force-dynamic';

import { SecondaryLink } from '@/components/actions';
import { Card, EmptyState, PageHeader, StatusBadge } from '@/components/ui';
import { requireAuth } from '@/lib/auth';

export default async function Page() {
  await requireAuth(["admin", "direzione", "consulente", "revisore", "backoffice"]);

  return <div className="space-y-6"><PageHeader title="Rendicontazioni" description="Area in preparazione per rendicontazioni e controlli tecnici collegati alle pratiche."/><Card title="Stato lavorazione"><div className="space-y-4"><StatusBadge status="in preparazione" /><EmptyState title="Vista in preparazione">La rendicontazione resta una fase interna, senza generazione o invio automatico al cliente.</EmptyState><SecondaryLink href="/technical-office">Vai a Ufficio Tecnico</SecondaryLink></div></Card></div>;
}
