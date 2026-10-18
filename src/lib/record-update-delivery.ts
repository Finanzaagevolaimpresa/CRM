import { Prisma, type PrismaClient } from '@prisma/client';
import type { AuthSession } from './auth';
import { RecordUpdateError, recordUpdateEventLabels } from './record-update-contract';
import { currentRecordUpdateUser } from './record-update-context';
import { updateActor, updateDirectory } from './record-updates';
import { admitCommunicationNotice } from './approved-communications';
import { admitRecordUpdateWork, recordUpdateWorkInclude, type RecordUpdateWork } from './record-update-admission';

type Tx = Prisma.TransactionClient;
const include = recordUpdateWorkInclude;
type Work = RecordUpdateWork;
async function visible(tx: Tx, actor: NonNullable<Awaited<ReturnType<typeof currentRecordUpdateUser>>> & AuthSession, work: Work,
  directory: Awaited<ReturnType<typeof updateDirectory>>, now: Date) {
  if (work.mode === 'EMAIL_DRAFT') return null;
  const admitted = await admitRecordUpdateWork(tx, actor, work, directory, now, admitCommunicationNotice);
  if (!admitted) return null;
  return { id: work.id, title: recordUpdateEventLabels[admitted.summary.event], category: 'Aggiornamento scelto dall’Admin',
    related: admitted.context.label, href: `/notifications/updates/${work.id}`, recordHref: admitted.context.href,
    date: work.event.occurredAt, readAt: work.readAt, changed: admitted.summary.changed, event: admitted.summary.event,
    priority: 'bassa' as const, accessUntil: admitted.accessUntil };
}
export async function listRecordUpdates(db: PrismaClient, claimed: AuthSession, limit = 100, unreadOnly = true) {
  return db.$transaction(async tx => {
    const auth = await updateActor(tx, claimed), directory = await updateDirectory(tx);
    const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    const result: NonNullable<Awaited<ReturnType<typeof visible>>>[] = [];
    // Filter before the result limit. No inaccessible titles, IDs or counts are
    // returned; stable batches prevent old revoked work starving valid work.
    let cursor: string | undefined;
    while (result.length < Math.min(500, Math.max(1, limit))) {
      const rows = await tx.recordUpdateDelivery.findMany({ where: { recipientId: auth.actor.id,
        ...(unreadOnly ? { readAt: null } : {}) }, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        include, orderBy: [{ event: { occurredAt: 'desc' } }, { id: 'desc' }], take: 100 });
      for (const row of rows) {
        const admitted = await visible(tx, { ...claimed, ...auth.actor, sessionId: auth.registry.id }, row, directory, clock.now);
        if (admitted) result.push(admitted);
        if (result.length >= limit) break;
      }
      if (rows.length < 100) break;
      cursor = rows.at(-1)!.id;
    }
    const finishedAt = await auth.finish();
    return result.filter(item => item.accessUntil > finishedAt.getTime())
      .sort((a, b) => b.date.getTime() - a.date.getTime()).slice(0, limit)
      .map(({ accessUntil, ...item }) => { void accessUntil; return item; });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 });
}
export async function readRecordUpdate(db: PrismaClient, claimed: AuthSession, id: string, markRead = false) {
  return db.$transaction(async tx => {
    const auth = await updateActor(tx, claimed);
    const work = await tx.recordUpdateDelivery.findFirst({ where: { id, recipientId: auth.actor.id }, include });
    if (!work) return null;
    const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    const result = await visible(tx, { ...claimed, ...auth.actor, sessionId: auth.registry.id }, work, await updateDirectory(tx), clock.now);
    if (!result) return null;
    if (markRead && !work.readAt) await tx.recordUpdateDelivery.update({ where: { id, recipientId: auth.actor.id }, data: { readAt: clock.now } });
    const finishedAt = await auth.finish();
    if (result.accessUntil <= finishedAt.getTime()) throw new RecordUpdateError('DENIED');
    const { accessUntil, ...item } = result; void accessUntil;
    return { ...item, readAt: markRead ? work.readAt ?? clock.now : work.readAt };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 });
}
