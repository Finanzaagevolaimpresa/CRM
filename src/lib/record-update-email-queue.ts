import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { AuthSession } from './auth';
import { RecordUpdateError } from './record-update-contract';
import { updateActor } from './record-updates';
import { admitCommunicationNotice } from './approved-communications';
import { admitRecordUpdateEmail } from './record-update-email-admission';
import { recordUpdateEmailAuthority } from './record-update-email-authority';
import { recordUpdateEventLabels } from './record-update-labels';

type Admission = NonNullable<Awaited<ReturnType<typeof admitRecordUpdateEmail>>>;
function projection(admitted: Admission) {
  return { deliveryId: admitted.work.id, sourceHash: admitted.proposal.sourceHash,
    recipientId: admitted.recipient.id, recipientName: admitted.recipient.name,
    recipientAddress: admitted.proposal.source.recipientAddress, stale: false };
}
async function emailActor(tx: Prisma.TransactionClient, claimed: AuthSession) {
  const auth = await updateActor(tx, claimed);
  const authority = await recordUpdateEmailAuthority(tx, auth.actor);
  if (!authority) throw new RecordUpdateError('DENIED');
  return { ...auth, authority };
}
/** GET consultation is pure: the actual draft is saved only by the existing
 * explicit message mutation, with a fresh provenance check in that transaction. */
export async function readRecordUpdateEmailQueue(db: PrismaClient, claimed: AuthSession) {
  return db.$transaction(async tx => {
    const auth = await emailActor(tx, claimed);
    const result = [];
    let cursor: string | undefined;
    while (result.length < 100) {
      const rows = await tx.recordUpdateDelivery.findMany({ where: {
        mode: { in: ['EMAIL_DRAFT', 'CRM_AND_EMAIL_DRAFT'] },
        OR: [{ rule: { authorId: auth.actor.id } }, { command: { actorId: auth.actor.id } }],
      }, include: { emailDraft: { select: { id: true, state: true } } },
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      orderBy: [{ event: { occurredAt: 'desc' } }, { id: 'desc' }], take: 100 });
      for (const row of rows) {
        const admitted = await admitRecordUpdateEmail(tx, row.id, admitCommunicationNotice);
        if (!admitted || admitted.author.id !== auth.actor.id) continue;
        result.push({ ...projection(admitted), context: admitted.context, label: admitted.proposal.source.recordLabel,
          eventLabel: recordUpdateEventLabels[admitted.summary.event], occurredAt: admitted.work.event.occurredAt,
          saved: Boolean(row.emailDraft), state: row.emailDraft?.state ?? null, accessUntil: admitted.accessUntil });
        if (result.length >= 100) break;
      }
      if (rows.length < 100) break;
      cursor = rows.at(-1)!.id;
    }
    const now = await auth.finish();
    return result.filter(row => row.accessUntil > now.getTime()).map(({ accessUntil, ...row }) => { void accessUntil; return row; });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 });
}
export async function readRecordUpdateEmailPrefill(db: PrismaClient, claimed: AuthSession, deliveryId: string) {
  if (!z.string().uuid().safeParse(deliveryId).success) throw new RecordUpdateError('DENIED');
  return db.$transaction(async tx => {
    const auth = await emailActor(tx, claimed);
    const admitted = await admitRecordUpdateEmail(tx, deliveryId, admitCommunicationNotice);
    if (!admitted || admitted.author.id !== auth.actor.id) throw new RecordUpdateError('DENIED');
    const saved = await tx.approvedCommunication.findUnique({ where: { updateDeliveryId: deliveryId }, select: { id: true } });
    const now = await auth.finish();
    if (admitted.accessUntil <= now.getTime()) throw new RecordUpdateError('DENIED');
    return { ...projection(admitted), context: admitted.context, subject: admitted.proposal.subject, body: admitted.proposal.body,
      mailboxId: auth.authority.mailboxId, saved: Boolean(saved) };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 });
}
