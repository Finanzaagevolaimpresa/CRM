export const dynamic = 'force-dynamic';

import { SecondaryLink } from '@/components/actions';
import { Card, EmptyState, PageHeader, StatusBadge } from '@/components/ui';
import { requirePermission } from '@/lib/auth';

export default async function Page() {
  await requirePermission('service.read');

  return <div className="space-y-6"><PageHeader title="Scadenze" description="Vista operativa in preparazione per concentrare follow-up, task e date critiche già presenti nel CRM."/><Card title="Stato lavorazione"><div className="space-y-4"><StatusBadge status="in preparazione" /><EmptyState title="Vista in preparazione">Le scadenze continueranno a essere gestite da task e pratiche finché la vista dedicata non sarà attivata.</EmptyState><SecondaryLink href="/tasks">Vai ai task</SecondaryLink></div></Card></div>;
}
