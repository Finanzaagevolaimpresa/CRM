import { notFound } from 'next/navigation';
import { PageHeader, Card } from '@/components/ui';
import { SecondaryLink } from '@/components/actions';
import { RecordProfileForm } from '@/components/record-profile-form';
import { requirePermission } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { canEditClient } from '@/lib/access-control';
import { clientProfileFields } from '@/lib/record-profile-fields';
import { recordProfileValues } from '@/lib/record-profile-view';
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission('client.write'), { id } = await params;
  const client = await prisma.client.findFirst({ where: { id, deletedAt: null } });
  if (!client || !canEditClient(session, client)) notFound();
  return <div className="space-y-6"><PageHeader title="Modifica anagrafica cliente" description="Denominazione, tipo e note del fascicolo. I dati fiscali e le sedi si compilano nella scheda azienda." />
    <SecondaryLink href={`/clients/${id}`}>Annulla e torna al cliente</SecondaryLink>
    <Card title={client.displayName}><RecordProfileForm fields={clientProfileFields} values={recordProfileValues(client, clientProfileFields)} clientType={client.type}
      hidden={{ kind: 'client', id, expectedVersion: client.updatedAt.toISOString() }} /></Card></div>;
}
