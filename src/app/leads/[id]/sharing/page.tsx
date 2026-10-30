export const dynamic = 'force-dynamic';
import { randomUUID } from 'node:crypto';
import { notFound } from 'next/navigation';
import { SecondaryLink } from '@/components/actions';
import { Card, PageHeader } from '@/components/ui';
import { SelectiveLeadSharing } from '@/components/selective-lead-sharing';
import { requirePermission } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { leadSharingManagement, mayManageLeadSharing, readLeadSharingReceipt } from '@/lib/selective-lead-access';
import { mayManageLeadEditing } from '@/lib/selective-lead-edit-management';

export default async function Page({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<{ commandId?: string }>;
}) {
  const session = await requirePermission('lead.read'), { id } = await params;
  if (!await mayManageLeadSharing(prisma, session)) notFound();
  const data = await leadSharingManagement(prisma, session, id).catch(() => null);
  if (!data) notFound();
  const editManager = await mayManageLeadEditing(prisma, session);
  const commandId = (await searchParams).commandId;
  const receipt = commandId ? await readLeadSharingReceipt(prisma, session, commandId).catch(() => null) : null;
  return <div className="min-w-0 space-y-6"><PageHeader title="Accesso selettivo al lead" description={data.title} />
    <SecondaryLink href={`/leads/${id}`}>Torna al lead</SecondaryLink>
    {editManager && <SecondaryLink href={`/leads/${id}/sharing/editing`}>Gestisci i permessi di modifica</SecondaryLink>}
    {commandId && <p role="status" className="rounded-xl border bg-slate-50 p-4">{receipt
      ? `Operazione registrata: ${receipt.operation === 'GRANT' ? 'selezione' : 'revoca'}, revisione ${receipt.revision}. Lo stato corrente è riportato sotto.`
      : 'Ricevuta non disponibile. Verifica lo stato corrente prima di una nuova operazione.'}</p>}
    <Card title="Scegli cosa condividere"><SelectiveLeadSharing key={id} leadId={id} recipients={data.recipients}
      grants={data.grants.map(grant => ({ ...grant, commandId: randomUUID() }))} initialCommandId={randomUUID()} /></Card>
  </div>;
}
