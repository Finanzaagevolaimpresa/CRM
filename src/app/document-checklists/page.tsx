export const dynamic = 'force-dynamic';

import { SecondaryLink } from '@/components/actions';
import { Card, EmptyState, PageHeader, StatusBadge } from '@/components/ui';
import { requirePermission } from '@/lib/auth';

export default async function Page() {
  await requirePermission('document.download');

  return <div className="space-y-6"><PageHeader title="Checklist documentale" description="Vista globale in preparazione per controllare checklist e documenti mancanti sulle pratiche."/><Card title="Stato lavorazione"><div className="space-y-4"><StatusBadge status="in preparazione" /><EmptyState title="Vista in preparazione">La raccolta documentale resta nelle schede cliente, servizi e archivio documenti esistenti.</EmptyState><SecondaryLink href="/documents">Vai ai documenti</SecondaryLink></div></Card></div>;
}
