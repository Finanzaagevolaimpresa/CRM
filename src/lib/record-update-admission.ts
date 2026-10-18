import { Prisma } from '@prisma/client';
import { canonicalSha256 } from './canonical-json';
import { RecordUpdateError, parseRecordUpdateSummary, resolveUpdateSelection } from './record-update-contract';
import { currentRecordUpdateUser, recordUpdateContext, recordUpdatePermission } from './record-update-context';
import type { updateDirectory } from './record-updates';
import type { CommunicationContext } from './approved-communication-contract';
import type { CommunicationPrincipal } from './communication-principal';
import { recordUpdateEmailAuthority } from './record-update-email-authority';

type Tx = Prisma.TransactionClient;
export const recordUpdateWorkInclude = { event: true, rule: true, command: true } as const;
export type RecordUpdateWork = Prisma.RecordUpdateDeliveryGetPayload<{ include: typeof recordUpdateWorkInclude }>;
export type RecordUpdatePerson = NonNullable<Awaited<ReturnType<typeof currentRecordUpdateUser>>>;
export type CommunicationNoticeAdmission = (tx: Tx, current: CommunicationPrincipal, context: CommunicationContext,
  messageId: string, replyId?: string) => Promise<{ accessUntil: number } | null>;

export async function admitRecordUpdateCommunication(tx: Tx, current: CommunicationPrincipal, work: RecordUpdateWork,
  admitMessage: CommunicationNoticeAdmission) {
  const key = work.event.sourceKey;
  if (!key) return null;
  const [source, id, messageId] = key.split(':');
  if (source === 'practice-communication') {
    await tx.$queryRaw`SELECT "id" FROM "PracticeCommunication" WHERE "id"=${id} FOR SHARE`;
    const row = await tx.practiceCommunication.findUnique({ where: { id }, select: {
      technicalPracticeId: true, clientId: true, projectId: true, clientServiceId: true, deletedAt: true, status: true,
    } });
    const context = await tx.technicalPractice.findUnique({ where: { id: work.event.recordId }, select: { clientId: true, projectId: true, clientServiceId: true } });
    return row && context && !row.deletedAt && row.status === 'usata_inviata'
      && work.event.kind === 'PRACTICE' && row.technicalPracticeId === work.event.recordId && row.clientId === context.clientId
      && row.projectId === context.projectId && row.clientServiceId === context.clientServiceId ? { accessUntil: Infinity } : null;
  }
  if (source !== 'message' && source !== 'reply') return null;
  const kind = work.event.kind === 'PRACTICE' ? 'TECHNICAL' : work.event.kind;
  if (kind !== 'LEAD' && kind !== 'CLIENT' && kind !== 'TECHNICAL') return null;
  return admitMessage(tx, current, { kind, id: work.event.recordId }, source === 'message' ? id : messageId, source === 'reply' ? id : undefined);
}

/** Current recipient/policy/context admission shared by CRM notices and draft
 * preparation. This returns no content and never grants access or sends mail. */
export async function admitRecordUpdateWork(tx: Tx, recipient: RecordUpdatePerson, work: RecordUpdateWork,
  directory: Awaited<ReturnType<typeof updateDirectory>>, now: Date, admitMessage: CommunicationNoticeAdmission) {
  if (work.recipientId !== recipient.id || work.recipientEpoch !== recipient.recordUpdateEpoch) return null;
  try {
    const context = await recordUpdateContext(tx, work.event.kind as 'LEAD' | 'CLIENT' | 'PRACTICE' | 'PROJECT', work.event.recordId);
    // Native policy writers hold the context first. Re-read the locked rule:
    // an open page cannot retain an earlier version after a completed revocation.
    if (work.ruleId) await tx.$queryRaw`SELECT "id" FROM "RecordUpdateRule" WHERE "id"=${work.ruleId}::uuid FOR SHARE`;
    const rule = work.ruleId ? await tx.recordUpdateRule.findUnique({ where: { id: work.ruleId } }) : null;
    const command = work.command;
    const policy = rule ?? command;
    if (!policy || (rule && (!rule.active || rule.version !== work.ruleVersion
      || (rule.expiresAt && rule.expiresAt <= now)))) return null;
    if (rule && (rule.kind !== work.event.kind || rule.recordId !== work.event.recordId || !rule.events.includes(work.event.event))) return null;
    if (command && (command.operation !== 'UPDATE' || command.kind !== work.event.kind || command.recordId !== work.event.recordId)) return null;
    if (policy.mode !== work.mode) return null;
    const authorId = rule?.authorId ?? command!.actorId;
    const authorEpoch = rule?.authorEpoch ?? command!.actorEpoch;
    const author = await currentRecordUpdateUser(tx, authorId);
    if (!author || author.role !== 'admin' || author.recordUpdateEpoch !== authorEpoch) return null;
    if (work.mode !== 'CRM') {
      const authority = await recordUpdateEmailAuthority(tx, author);
      if (!authority || authority.revision !== policy.emailAuthorityRevision) return null;
    }
    if (resolveUpdateSelection(policy.selection, directory).directoryBinding !== policy.directoryBinding) return null;
    if (context.scopeDigest !== canonicalSha256(work.event.scope) || context.scopeDigest !== canonicalSha256(policy.scope)
      || !context.canRead(recipient) || !context.canRead(author)) return null;
    let accessUntil = rule?.expiresAt?.getTime() ?? Infinity;
    if (work.event.event === 'COMMUNICATION') {
      if (!recordUpdatePermission(recipient, 'practice_communications.read')) return null;
      const source = await admitRecordUpdateCommunication(tx, recipient, work, admitMessage);
      if (!source) return null;
      accessUntil = Math.min(accessUntil, source.accessUntil);
    }
    const summary = parseRecordUpdateSummary({ event: work.event.event, changed: work.event.changed });
    return { context, author, recipient, policy, rule, command, summary, accessUntil };
  } catch (error) {
    if (error instanceof RecordUpdateError) return null;
    throw error;
  }
}
