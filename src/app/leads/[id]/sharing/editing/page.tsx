export const dynamic = 'force-dynamic';

import { randomUUID } from 'node:crypto';
import { notFound } from 'next/navigation';
import { SecondaryLink } from '@/components/actions';
import { Card, PageHeader } from '@/components/ui';
import { SelectiveLeadEditManagement } from '@/components/selective-lead-edit-management';
import { requirePermission } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { readLeadEditingManagement } from '@/lib/selective-lead-edit-management';
import { prepareLeadEditingAccess, confirmLeadEditingAccess, revokeLeadEditingAccess, checkLeadEditingDecision } from '@/lib/selective-lead-edit-actions';

export default async function Page({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<{ editDecisionId?: string }>;
}) {
  const session = await requirePermission('lead.read'), { id } = await params;
  const data = await readLeadEditingManagement(prisma, session, id).catch(() => null);
  if (!data) notFound();
  const { editDecisionId } = await searchParams;
  return <div className="min-w-0 space-y-6"><PageHeader title="Permessi di modifica del lead" description="Decidi personalmente chi può modificare i campi già condivisi." />
    <SecondaryLink href={`/leads/${id}/sharing`}>Torna alla selezione di lettura</SecondaryLink>
    <Card title="Scegli chi può modificare"><SelectiveLeadEditManagement key={randomUUID()} data={{ ...data, grants: data.grants.map(grant => ({ ...grant, commandId: randomUUID() })) }}
      initialCommandId={randomUUID()} recoverCommandId={editDecisionId} previewAction={prepareLeadEditingAccess}
      confirmAction={confirmLeadEditingAccess} revokeAction={revokeLeadEditingAccess} receiptAction={checkLeadEditingDecision} /></Card>
  </div>;
}
