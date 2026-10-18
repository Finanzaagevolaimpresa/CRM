import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { currentRecordUpdateUser } from './record-update-context';
import { recordUpdatePermission } from './record-update-context';
import { admitRecordUpdateWork, admitRecordUpdateCommunication, recordUpdateWorkInclude, type CommunicationNoticeAdmission } from './record-update-admission';
import { prepareRecordUpdateEmailProposal } from './record-update-email-contract';
import { updateDirectory } from './record-updates';

/** Locked projection of existing work. The caller authenticates the real user;
 * neither this function nor its principal creates a session for the recipient. */
export async function admitRecordUpdateEmail(tx: Prisma.TransactionClient, deliveryId: string,
  admitMessage: CommunicationNoticeAdmission) {
  const work = await tx.recordUpdateDelivery.findUnique({ where: { id: deliveryId }, include: recordUpdateWorkInclude });
  if (!work || !['EMAIL_DRAFT', 'CRM_AND_EMAIL_DRAFT'].includes(work.mode) || work.event.kind === 'PROJECT') return null;
  const recipient = await currentRecordUpdateUser(tx, work.recipientId);
  if (!recipient || !recordUpdatePermission(recipient, 'practice_communications.read')) return null;
  const [time] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
  const admitted = await admitRecordUpdateWork(tx, recipient, work, await updateDirectory(tx), time.now, admitMessage);
  if (!admitted || !admitted.policy.emailAuthorityRevision) return null;
  const { context, author, policy, rule, command } = admitted;
  // The author must still be entitled to the communication that generated the
  // event as well as the selected recipient. No source content is copied.
  if (work.event.event === 'COMMUNICATION') {
    const source = await admitRecordUpdateCommunication(tx, author, work, admitMessage);
    if (!source) return null;
    admitted.accessUntil = Math.min(admitted.accessUntil, source.accessUntil);
  }
  let proposal: ReturnType<typeof prepareRecordUpdateEmailProposal>;
  try { proposal = prepareRecordUpdateEmailProposal({
    source: { deliveryId: work.id, eventId: work.eventId, kind: work.event.kind, recordId: work.event.recordId,
      recipientId: recipient.id, recipientEpoch: recipient.recordUpdateEpoch,
      authorId: author.id, authorEpoch: author.recordUpdateEpoch,
      ruleId: rule?.id ?? null, ruleVersion: rule?.version ?? null, commandId: command?.id ?? null,
      scopeHash: context.scopeDigest, directoryHash: policy.directoryBinding,
      occurredAt: work.event.occurredAt.toISOString(), recordVersion: context.version.toISOString(),
      authorityRevision: policy.emailAuthorityRevision },
    mode: work.mode, label: context.label, recipient: { id: recipient.id, email: recipient.email }, summary: admitted.summary,
  }); } catch (error) {
    if (error instanceof z.ZodError) return null;
    throw error;
  }
  return { ...admitted, proposal, context: { kind: work.event.kind === 'PRACTICE' ? 'TECHNICAL' as const : work.event.kind as 'LEAD' | 'CLIENT', id: work.event.recordId },
    work };
}
