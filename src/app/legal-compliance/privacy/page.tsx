export const dynamic = 'force-dynamic';

import { SecondaryLink } from '@/components/actions';
import { Card, EmptyState, PageHeader, StatusBadge } from '@/components/ui';
import { requirePermission } from '@/lib/auth';

export default async function Page() {
  await requirePermission('contract.read');

  return <div className="space-y-6"><PageHeader title="Privacy e consensi" description="Area in preparazione per controlli privacy, consensi e note compliance."/><Card title="Stato lavorazione"><div className="space-y-4"><StatusBadge status="in preparazione" /><EmptyState title="Vista in preparazione">Questa skeleton non modifica consensi, anagrafiche o policy operative.</EmptyState><SecondaryLink href="/legal-compliance">Vai a Legale / Compliance</SecondaryLink></div></Card></div>;
}
