export const dynamic = 'force-dynamic';
import { randomUUID } from 'node:crypto';
import { notFound } from 'next/navigation';
import { SecondaryLink } from '@/components/actions';
import { Card, PageHeader } from '@/components/ui';
import { SelectiveClientSharing } from '@/components/selective-client-sharing';
import { requirePermission } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { clientSharingManagement, mayManageClientSharing, readClientSharingReceipt } from '@/lib/selective-client-access';

export default async function Page({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<{ commandId?: string }>;
}) {
  const session = await requirePermission('client.read'), { id } = await params;
  if (!await mayManageClientSharing(prisma, session)) notFound();
  const data = await clientSharingManagement(prisma, session, id).catch(() => null);
  if (!data) notFound();
  const commandId = (await searchParams).commandId;
  const receipt = commandId ? await readClientSharingReceipt(prisma, session, commandId, id).catch(() => null) : null;
  return <div className="min-w-0 space-y-6"><PageHeader title="Accesso selettivo al cliente" description={data.title} />
    <SecondaryLink href={`/clients/${id}`}>Torna al cliente</SecondaryLink>
    {commandId && <p role="status" className="rounded-xl border bg-slate-50 p-4">{receipt
      ? `Operazione registrata: ${receipt.operation === 'GRANT' ? 'selezione' : 'revoca'}, revisione ${receipt.revision}. Lo stato corrente è riportato sotto.`
      : 'Ricevuta non disponibile. Verifica lo stato corrente prima di una nuova operazione.'}</p>}
    <Card title="Scegli cosa condividere"><SelectiveClientSharing key={randomUUID()} clientId={id} recipients={data.recipients}
      grants={data.grants.map(grant => ({ ...grant, commandId: randomUUID() }))} initialCommandId={randomUUID()} /></Card>
  </div>;
}
