import { randomUUID } from 'node:crypto';
import { notFound } from 'next/navigation';
import { PageHeader, Card } from '@/components/ui';
import { SecondaryLink } from '@/components/actions';
import { RecordProfileForm } from '@/components/record-profile-form';
import { requirePermission } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { canEditClient } from '@/lib/access-control';
import { companyProfileFields } from '@/lib/record-profile-fields';
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission('company.write'), { id } = await params;
  const client = await prisma.client.findFirst({ where: { id, deletedAt: null } });
  if (!client || !canEditClient(session, client)) notFound();
  return <div className="space-y-6"><PageHeader title="Aggiungi azienda" description={`Collega i dati aziendali al fascicolo ${client.displayName}.`} />
    <SecondaryLink href={`/clients/${id}#azienda-visura-ateco`}>Annulla e torna al cliente</SecondaryLink>
    <Card title="Dati fiscali, sedi e attività"><RecordProfileForm fields={companyProfileFields} values={{}}
      hidden={{ kind: 'new-company', id: randomUUID(), clientId: id }} submitLabel="Crea azienda" /></Card></div>;
}
