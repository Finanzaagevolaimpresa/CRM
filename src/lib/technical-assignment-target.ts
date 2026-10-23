import type { Prisma } from '@prisma/client';
import type { TechnicalTargetReference } from './technical-assignment-display';
import { TechnicalAssignmentError } from './technical-assignment-transaction';
import { canonicalSha256 } from './canonical-json';

/** Used after the canonical target lock. No client, owner, commercial or
 * financial field enters the management/recipient projection from this loader. */
export async function technicalAssignmentTargetFields(tx: Prisma.TransactionClient, target: TechnicalTargetReference) {
  const row = target.kind === 'Project'
    ? await tx.project.findUnique({ where: { id: target.targetId }, select: { title: true, description: true, status: true, updatedAt: true } })
    : await tx.technicalPractice.findUnique({ where: { id: target.targetId }, select: { title: true, practiceType: true,
      status: true, priority: true, dueDate: true, targetEntity: true, targetPortal: true, protocolNumber: true,
      submittedAt: true, nextClientUpdateAt: true, clientVisibleStatus: true, integrationRequestNote: true, updatedAt: true } });
  if (!row) throw new TechnicalAssignmentError('DENIED');
  return row;
}

export function technicalWorkTargetDigest(target: TechnicalTargetReference, updatedAt: Date) {
  return canonicalSha256({ protocol: 'TECHNICAL_WORK_VERSION_V1', target, updatedAt: updatedAt.toISOString() });
}
