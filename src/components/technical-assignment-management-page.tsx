import { randomUUID } from 'node:crypto';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { PageHeader } from '@/components/ui';
import { SecondaryLink } from '@/components/actions';
import { TechnicalAssignmentManagement } from '@/components/technical-assignment-management';
import { requireSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { technicalTargetReference, type TechnicalTargetReference } from '@/lib/technical-assignment-display';
import { readTechnicalAssignmentManagement } from '@/lib/technical-assignment-management';
import { prepareTechnicalAssignment, saveTechnicalAssignment, checkTechnicalAssignment, searchTechnicalWorkItemCatalogue } from '@/lib/technical-assignment-actions';

export async function TechnicalAssignmentManagementPage({ target: raw, query }: { target: TechnicalTargetReference;
  query: { recipient?: string; assignmentDecision?: string } }) {
  const session = await requireSession(), target = technicalTargetReference.safeParse(raw);
  if (!target.success) notFound();
  const recipient = query.recipient ? z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/).safeParse(query.recipient) : null;
  const recover = query.assignmentDecision ? z.string().uuid().safeParse(query.assignmentDecision) : null;
  if ((recipient && !recipient.success) || (recover && !recover.success) || (recover && !recipient)) notFound();
  const data = await readTechnicalAssignmentManagement(prisma, session, target.data, recipient?.success ? recipient.data : null).catch(() => null);
  if (!data) notFound();
  return <div className="space-y-6"><PageHeader title="Incarichi tecnici e perimetri personali"
    description="Più persone possono lavorare sullo stesso record, ciascuna con responsabilità, operazioni, campi e documenti esplicitamente scelti." />
    <SecondaryLink href={target.data.kind === 'Project' ? `/projects/${target.data.targetId}` : `/technical-office/practices/${target.data.targetId}`}>Torna alla scheda</SecondaryLink>
    <TechnicalAssignmentManagement key={`${data.target.kind}:${data.target.targetId}:${data.recipient?.id}:${data.recipient?.epoch}:${data.contextSha256}`}
      data={data} initialCommandId={randomUUID()} revocationCommandId={randomUUID()} catalogueAction={searchTechnicalWorkItemCatalogue}
      recoverCommandId={recover?.success ? recover.data : undefined} previewAction={prepareTechnicalAssignment}
      confirmAction={saveTechnicalAssignment} receiptAction={checkTechnicalAssignment} />
  </div>;
}
