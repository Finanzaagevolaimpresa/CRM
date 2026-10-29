import type { Prisma } from '@prisma/client';
import type { TechnicalTargetReference } from './technical-assignment-display';
import { TechnicalAssignmentError } from './technical-assignment-transaction';
import { canonicalSha256 } from './canonical-json';

/** Used after the canonical target lock. Owner names are explicit catalogue
 * values; IDs, emails and parent records never enter the field projection. */
export async function technicalAssignmentTargetFields(tx: Prisma.TransactionClient, target: TechnicalTargetReference) {
  const row = target.kind === 'Project'
    ? await tx.project.findUnique({ where: { id: target.targetId }, select: { title: true, description: true, status: true, priority: true, consultantId: true, clientId: true, updatedAt: true } })
    : await tx.technicalPractice.findUnique({ where: { id: target.targetId }, select: { title: true, practiceType: true,
      status: true, priority: true, dueDate: true, targetEntity: true, targetPortal: true, protocolNumber: true,
      submittedAt: true, nextClientUpdateAt: true, clientVisibleStatus: true, integrationRequestNote: true,
      technicalOwnerId: true, commercialOwnerId: true, updatedAt: true } });
  if (!row) throw new TechnicalAssignmentError('DENIED');
  const technicalId = 'consultantId' in row ? row.consultantId : row.technicalOwnerId;
  const commercialId = 'clientId' in row
    ? (await tx.client.findUnique({ where: { id: row.clientId }, select: { salesOwnerId: true } }))?.salesOwnerId
    : row.commercialOwnerId;
  const people = await tx.user.findMany({ where: { id: { in: [technicalId, commercialId].filter((id): id is string => Boolean(id)) } },
    select: { id: true, name: true } });
  return { ...row, technicalOwnerName: people.find(person => person.id === technicalId)?.name ?? null,
    commercialOwnerName: people.find(person => person.id === commercialId)?.name ?? null };
}

export function technicalWorkTargetDigest(target: TechnicalTargetReference, updatedAt: Date) {
  return canonicalSha256({ protocol: 'TECHNICAL_WORK_VERSION_V1', target, updatedAt: updatedAt.toISOString() });
}
