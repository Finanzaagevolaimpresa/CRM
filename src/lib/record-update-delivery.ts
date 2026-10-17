import { Prisma, type PrismaClient } from '@prisma/client';
import type { AuthSession } from './auth';
import { canonicalSha256 } from './canonical-json';
import { RecordUpdateError, parseRecordUpdateSummary, resolveUpdateSelection, recordUpdateEventLabels } from './record-update-contract';
import { currentRecordUpdateUser, recordUpdateContext, recordUpdatePermission } from './record-update-context';
import { updateActor, updateDirectory } from './record-updates';

type Tx = Prisma.TransactionClient;
const include = { event: true, rule: true, command: true } as const;
type Work = Prisma.RecordUpdateDeliveryGetPayload<{ include: typeof include }>;
async function sourceStillBound(tx: Tx, work: Work) {
  const key = work.event.sourceKey;
  if (!key) return work.event.event !== 'COMMUNICATION';
  const [source, id, messageId] = key.split(':');
  if (source === 'practice-communication') {
    const row = await tx.practiceCommunication.findUnique({ where: { id }, select: {
      technicalPracticeId: true, clientId: true, projectId: true, clientServiceId: true, deletedAt: true, status: true,
    } });
    const context = await tx.technicalPractice.findUnique({ where: { id: work.event.recordId }, select: { clientId: true, projectId: true, clientServiceId: true } });
    return Boolean(row && context && !row.deletedAt && row.status === 'usata_inviata'
      && work.event.kind === 'PRACTICE' && row.technicalPracticeId === work.event.recordId && row.clientId === context.clientId
      && row.projectId === context.projectId && row.clientServiceId === context.clientServiceId);
  }
  if (source !== 'message' && source !== 'reply') return false;
  if (source === 'reply') {
    const reply = await tx.communicationReply.findUnique({ where: { id }, select: { messageId: true, linkedById: true } });
    if (!reply?.linkedById || reply.messageId !== messageId) return false;
  }
  const message = await tx.approvedCommunication.findUnique({ where: { id: source === 'message' ? id : messageId }, select: {
    state: true, contextKind: true, leadId: true, clientId: true, technicalPracticeId: true, readinessId: true,
  } });
  if (!message || (source === 'message' && message.state !== 'SENT')) return false;
  return (work.event.kind === 'LEAD' && message.contextKind === 'LEAD' && message.leadId === work.event.recordId)
    || (work.event.kind === 'CLIENT' && message.contextKind === 'CLIENT' && message.clientId === work.event.recordId)
    || (work.event.kind === 'PRACTICE' && message.contextKind === 'LEGACY' && !message.readinessId && message.technicalPracticeId === work.event.recordId);
}
async function visible(tx: Tx, actor: NonNullable<Awaited<ReturnType<typeof currentRecordUpdateUser>>>, work: Work,
  directory: Awaited<ReturnType<typeof updateDirectory>>, now: Date) {
  if (work.recipientId !== actor.id || work.recipientEpoch !== actor.recordUpdateEpoch) return null;
  const policy = work.rule ?? work.command;
  if (!policy || (work.rule && (!work.rule.active || work.rule.version !== work.ruleVersion
    || (work.rule.expiresAt && work.rule.expiresAt <= now)))) return null;
  if (work.rule && (work.rule.kind !== work.event.kind || work.rule.recordId !== work.event.recordId || !work.rule.events.includes(work.event.event))) return null;
  if (work.command && (work.command.operation !== 'UPDATE' || work.command.kind !== work.event.kind || work.command.recordId !== work.event.recordId)) return null;
  const authorId = work.rule?.authorId ?? work.command!.actorId;
  const authorEpoch = work.rule?.authorEpoch ?? work.command!.actorEpoch;
  const author = await currentRecordUpdateUser(tx, authorId);
  if (!author || author.role !== 'admin' || author.recordUpdateEpoch !== authorEpoch) return null;
  try {
    if (resolveUpdateSelection(policy.selection, directory).directoryBinding !== policy.directoryBinding) return null;
    const context = await recordUpdateContext(tx, work.event.kind as 'LEAD' | 'CLIENT' | 'PRACTICE' | 'PROJECT', work.event.recordId);
    if (context.scopeDigest !== canonicalSha256(work.event.scope) || context.scopeDigest !== canonicalSha256(policy.scope)
      || !context.canRead(actor) || !context.canRead(author)) return null;
    if (work.event.event === 'COMMUNICATION' && (!recordUpdatePermission(actor, 'practice_communications.read') || !await sourceStillBound(tx, work))) return null;
    const summary = parseRecordUpdateSummary({ event: work.event.event, changed: work.event.changed });
    return { id: work.id, title: recordUpdateEventLabels[summary.event], category: 'Aggiornamento scelto dall’Admin',
      related: context.label, href: `/notifications/updates/${work.id}`, recordHref: context.href,
      date: work.event.occurredAt, readAt: work.readAt, changed: summary.changed, event: summary.event,
      priority: 'bassa' as const };
  } catch (error) {
    if (error instanceof RecordUpdateError) return null;
    throw error;
  }
}
export async function listRecordUpdates(db: PrismaClient, claimed: AuthSession, limit = 100, unreadOnly = true) {
  return db.$transaction(async tx => {
    const auth = await updateActor(tx, claimed), directory = await updateDirectory(tx);
    const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    const result: (NonNullable<Awaited<ReturnType<typeof visible>>> & { expiresAt: Date | null })[] = [];
    // Filter before the result limit. No inaccessible titles, IDs or counts are
    // returned; stable batches prevent old revoked work starving valid work.
    let cursor: string | undefined;
    while (result.length < Math.min(500, Math.max(1, limit))) {
      const rows = await tx.recordUpdateDelivery.findMany({ where: { recipientId: auth.actor.id,
        ...(unreadOnly ? { readAt: null } : {}) }, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        include, orderBy: [{ event: { occurredAt: 'desc' } }, { id: 'desc' }], take: 100 });
      for (const row of rows) {
        const admitted = await visible(tx, auth.actor, row, directory, clock.now);
        if (admitted) result.push({ ...admitted, expiresAt: row.rule?.expiresAt ?? null });
        if (result.length >= limit) break;
      }
      if (rows.length < 100) break;
      cursor = rows.at(-1)!.id;
    }
    const finishedAt = await auth.finish();
    return result.filter(item => !item.expiresAt || item.expiresAt > finishedAt)
      .sort((a, b) => b.date.getTime() - a.date.getTime()).slice(0, limit)
      .map(({ expiresAt, ...item }) => { void expiresAt; return item; });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 });
}
export async function readRecordUpdate(db: PrismaClient, claimed: AuthSession, id: string, markRead = false) {
  return db.$transaction(async tx => {
    const auth = await updateActor(tx, claimed);
    const work = await tx.recordUpdateDelivery.findFirst({ where: { id, recipientId: auth.actor.id }, include });
    if (!work) return null;
    const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    const result = await visible(tx, auth.actor, work, await updateDirectory(tx), clock.now);
    if (!result) return null;
    if (markRead && !work.readAt) await tx.recordUpdateDelivery.update({ where: { id, recipientId: auth.actor.id }, data: { readAt: clock.now } });
    const finishedAt = await auth.finish();
    if (work.rule?.expiresAt && work.rule.expiresAt <= finishedAt) throw new RecordUpdateError('DENIED');
    return { ...result, readAt: markRead ? work.readAt ?? clock.now : work.readAt };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 });
}
