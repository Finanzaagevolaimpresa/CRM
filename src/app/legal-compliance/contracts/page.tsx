export const dynamic = 'force-dynamic';

import { SecondaryLink } from '@/components/actions';
import { Card, EmptyState, PageHeader, StatusBadge } from '@/components/ui';
import { requirePermission } from '@/lib/auth';

export default async function Page() {
  await requirePermission('legal.read');

  return <div className="space-y-6"><PageHeader title="Contratti da revisionare" description="Vista in preparazione per concentrare i contratti che richiedono controllo legale o compliance."/><Card title="Stato lavorazione"><div className="space-y-4"><StatusBadge status="in preparazione" /><EmptyState title="Vista in preparazione">La gestione operativa dei contratti resta nella sezione contratti esistente.</EmptyState><SecondaryLink href="/contracts">Vai ai contratti</SecondaryLink></div></Card></div>;
}
