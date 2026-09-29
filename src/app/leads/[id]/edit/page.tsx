import { notFound } from 'next/navigation';
import { PageHeader, Card } from '@/components/ui';
import { SecondaryLink } from '@/components/actions';
import { RecordProfileForm } from '@/components/record-profile-form';
import { requirePermission } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { canEditLead } from '@/lib/access-control';
import { leadProfileFields } from '@/lib/record-profile-fields';
import { recordProfileValues } from '@/lib/record-profile-view';
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission('lead.write'), { id } = await params;
  const lead = await prisma.lead.findFirst({ where: { id, deletedAt: null } });
  if (!lead || !canEditLead(session, lead)) notFound();
  return <div className="space-y-6"><PageHeader title="Modifica anagrafica lead" description="Contatti e azienda dichiarata. Stato commerciale e assegnazioni restano nelle rispettive sezioni." />
    <SecondaryLink href={`/leads/${id}`}>Annulla e torna al lead</SecondaryLink>
    <Card title={`${lead.firstName} ${lead.lastName}`}><RecordProfileForm fields={leadProfileFields} values={recordProfileValues(lead, leadProfileFields)}
      hidden={{ kind: 'lead', id, expectedVersion: lead.updatedAt.toISOString() }} /></Card></div>;
}
