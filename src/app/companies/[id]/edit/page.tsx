import { notFound } from 'next/navigation';
import { PageHeader, Card } from '@/components/ui';
import { SecondaryLink } from '@/components/actions';
import { RecordProfileForm } from '@/components/record-profile-form';
import { requirePermission } from '@/lib/auth';
import { getCompanyReadAccess } from '@/lib/read-access';
import { canEditClient } from '@/lib/access-control';
import { companyProfileFields } from '@/lib/record-profile-fields';
import { recordProfileValues } from '@/lib/record-profile-view';
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission('company.write'), { id } = await params;
  const context = await getCompanyReadAccess(session, id);
  if (!context || !canEditClient(session, context.client)) notFound();
  return <div className="space-y-6"><PageHeader title="Modifica azienda" description="Dati fiscali, sedi, attività e informazioni aziendali." />
    <SecondaryLink href={`/companies/${id}`}>Annulla e torna all’azienda</SecondaryLink>
    <Card title={context.company.name}><RecordProfileForm fields={companyProfileFields} values={recordProfileValues(context.company, companyProfileFields)}
      hidden={{ kind: 'company', id, expectedVersion: context.company.updatedAt.toISOString() }} /></Card></div>;
}
