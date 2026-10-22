export const dynamic = 'force-dynamic';

import { randomUUID } from 'node:crypto';
import { notFound } from 'next/navigation';
import { SecondaryLink } from '@/components/actions';
import { Card, PageHeader } from '@/components/ui';
import { SelectiveLeadEditor } from '@/components/selective-lead-editor';
import { requirePermission } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { readLeadEditing } from '@/lib/selective-lead-edit-access';
import { prepareSelectedLeadEdit, confirmSelectedLeadEdit, checkSelectedLeadEdit } from '@/lib/selective-lead-edit-actions';

export default async function Page({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<{ editCommandId?: string }>;
}) {
  const session = await requirePermission('lead.read'), { id } = await params;
  const view = await readLeadEditing(prisma, session, id).catch(() => null);
  if (!view) notFound();
  const { editCommandId } = await searchParams;
  return <div className="min-w-0 space-y-6"><PageHeader title="Modifica i campi abilitati" description="Controlla i valori prima di salvarli." />
    <SecondaryLink href={`/shared-leads/${id}`}>Torna al lead condiviso</SecondaryLink>
    <Card title="Modifica selettiva del lead"><SelectiveLeadEditor key={randomUUID()} view={view} initialCommandId={randomUUID()}
      recoverCommandId={editCommandId} previewAction={prepareSelectedLeadEdit} confirmAction={confirmSelectedLeadEdit} outcomeAction={checkSelectedLeadEdit} /></Card>
  </div>;
}
