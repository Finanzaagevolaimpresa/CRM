export const dynamic = 'force-dynamic';

import { SecondaryLink } from '@/components/actions';
import { Card, EmptyState, PageHeader, StatusBadge } from '@/components/ui';
import { requirePermission } from '@/lib/auth';

export default async function Page() {
  await requirePermission('contract.read');

  return <div className="space-y-6"><PageHeader title="PEC / Contestazioni" description="Area in preparazione per tracciare contestazioni, PEC e verifiche legali interne."/><Card title="Stato lavorazione"><div className="space-y-4"><StatusBadge status="in preparazione" /><EmptyState title="Vista in preparazione">Non sono presenti invii PEC automatici o comunicazioni verso il cliente.</EmptyState><SecondaryLink href="/legal-compliance">Vai a Legale / Compliance</SecondaryLink></div></Card></div>;
}
