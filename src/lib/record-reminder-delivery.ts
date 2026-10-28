import { Prisma, type PrismaClient } from '@prisma/client';
import type { AuthSession } from './auth';
import { canonicalJson } from './canonical-json';
import { lockRegisteredPrivilegedStepUpKey } from './application-key-registry';
import { lockCommunicationDirectory } from './communication-directory-lock';
import { confirmedReadRetry } from './confirmed-read-retry';
import type { PrivilegedStepUpKey } from './privileged-step-up-token';
import { RecordUpdateError } from './record-update-contract';
import { recordReminderAvailability } from './record-reminder-contract';
import { readRecordReminderJournal, type RecordReminderJournal } from './record-reminder-journal';
import { lockReminderPrincipals, reminderAuthorAdmission, ordinaryReminderAdmission, technicalReminderAdmission } from './record-reminder-principal';
import { lockRecordReminderSource } from './record-reminder-source';
import { recordUpdateWorkInclude, type RecordUpdateWork } from './record-update-admission';
import { updateActor, updateDirectory } from './record-updates';
import { TechnicalAssignmentError } from './technical-assignment-errors';
import { mapSerializableConflict } from './serializable';

type Tx = Prisma.TransactionClient;
type JournalRow = { journal: unknown; proof: string; eventId: string; taskId: string;
  availableAt: Date; confirmedAt: Date; keyVersion: number };
export async function readRecordReminderWorkJournal(tx: Tx, key: PrivilegedStepUpKey, work: RecordUpdateWork) {
  const rows = await tx.$queryRaw<JournalRow[]>`SELECT journal,proof,"eventId","taskId","availableAt","confirmedAt","keyVersion"
    FROM "RecordUpdateReminder" WHERE "commandId"=${work.commandId}::uuid`;
  if (rows.length !== 1) return null;
  const row = rows[0], journal = readRecordReminderJournal(key, row.journal, row.proof);
  const command = work.command;
  if (!journal || !command || work.mode !== 'CRM' || work.ruleId !== null || work.ruleVersion !== null) return null;
  const p = journal.prepared, recipient = p.recipients.find(person => person.id === work.recipientId);
  if (!recipient || recipient.epoch !== work.recipientEpoch || journal.commandId !== work.commandId
    || journal.eventId !== work.eventId || row.eventId !== journal.eventId || row.taskId !== p.input.taskId
    || row.keyVersion !== journal.keyVersion || row.availableAt.toISOString() !== p.input.remindAt
    || row.confirmedAt.toISOString() !== journal.confirmedAt || command.operation !== 'REMINDER'
    || command.actorId !== p.authorId || command.actorEpoch !== p.authorEpoch || command.digest !== journal.commandDigest
    || command.transactionId.toString() !== journal.transactionId || command.createdAt.toISOString() !== journal.confirmedAt
    || command.kind !== p.input.kind || command.recordId !== p.input.recordId || command.mode !== 'CRM'
    || command.emailAuthorityRevision !== null || command.directoryBinding !== p.directoryBinding
    || canonicalJson(command.scope) !== canonicalJson(p.source) || canonicalJson(command.selection) !== canonicalJson(p.input.selection)
    || canonicalJson(command.recipients) !== canonicalJson(p.recipients.map(({ id, epoch }) => ({ id, epoch })))
    || work.event.kind !== p.input.kind || work.event.recordId !== p.input.recordId || work.event.event !== 'DEADLINE'
    || work.event.sourceKey !== p.eventKey || canonicalJson(work.event.scope) !== canonicalJson(p.source)
    || canonicalJson(work.event.changed) !== canonicalJson(p.summary.changed)
    || work.event.occurredAt.toISOString() !== journal.confirmedAt) return null;
  return journal;
}

/** Current-availability adapter for the existing RecordUpdateDelivery
 * queue. Reads do not mutate receipts; marking read is a
 * separate explicit command and is never retried after an ambiguous response. */
async function readNotice(db: PrismaClient, claimed: AuthSession, key: PrivilegedStepUpKey,
  id: string, markRead = false) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(id)) throw new RecordUpdateError('INVALID');
  const read = () => db.$transaction(async tx => {
    if (!await lockRegisteredPrivilegedStepUpKey(tx, key)) throw new RecordUpdateError('DENIED');
    await lockCommunicationDirectory(tx);
    // The immutable queue/journal identify the lock set, without exposing their
    // contents. Authenticate the actual recipient after sorted principal locks.
    const work = await tx.recordUpdateDelivery.findFirst({ where: { id, recipientId: claimed.userId }, include: recordUpdateWorkInclude });
    const journal = work?.command?.operation === 'REMINDER' ? await readRecordReminderWorkJournal(tx, key, work) : null;
    if (!work || !journal) { const auth = await updateActor(tx, claimed); await auth.finish(); return null; }
    const p = journal.prepared;
    const principals = await lockReminderPrincipals(tx, p.authorId, p.recipients.map(person => person.id));
    const auth = await updateActor(tx, claimed), author = principals.principals.get(p.authorId);
    const person = principals.principals.get(auth.actor.id);
    if (!author || !person || auth.actor.recordUpdateEpoch !== work.recipientEpoch) return null;
    const cancellations = await tx.$queryRaw<Array<{ commandId: string }>>`SELECT "commandId"
      FROM "RecordUpdateReminderCancellation" WHERE "reminderCommandId"=${journal.commandId}::uuid`;
    if (cancellations.length) { await auth.finish(); return null; }
    try {
      const source = await lockRecordReminderSource(tx, { key, recipient: author.raw }, p.input);
      const authorAccess = reminderAuthorAdmission(principals, source);
      if (!authorAccess) return null;
      const now = await auth.finish();
      const ordinary = (person.raw.id === author.raw.id ? authorAccess : null) ?? ordinaryReminderAdmission(source, person.ordinary);
      const admission = ordinary ?? await technicalReminderAdmission(tx, key, principals, source, person.raw.id, now);
      if (!admission) return null;
      const directory = await updateDirectory(tx);
      const availability = (at: Date, readAt: Date | null) => recordReminderAvailability(p, {
        now: at.toISOString(), source: source.source, authorId: author.raw.id, authorEpoch: author.raw.recordUpdateEpoch,
        authorAuthorized: true, authorAccessBinding: authorAccess.accessBinding, policyRevoked: false,
        directory, recipient: admission, readAt: readAt?.toISOString() ?? null });
      let current = availability(now, work.readAt);
      if (current.state !== 'AVAILABLE' && current.state !== 'READ') return null;
      let readAt = work.readAt;
      if (markRead && !readAt) {
        const saved = await tx.recordUpdateDelivery.updateMany({ where: { id: work.id, recipientId: auth.actor.id, readAt: null }, data: { readAt: now } });
        if (saved.count !== 1) throw new RecordUpdateError('STALE');
        readAt = now;
      }
      const finishedAt = await auth.finish();
      current = availability(finishedAt, readAt);
      if (current.state !== 'AVAILABLE' && current.state !== 'READ') {
        if (markRead) throw new RecordUpdateError('DENIED');
        return null;
      }
      // Only the explicitly selected dueAt is projected. A task title or client
      // name can contain private information even when the deadline is allowed.
      const recordHref = ordinary ? ordinaryPath(journal) : `/technical-work/${p.input.kind === 'PROJECT' ? 'projects' : 'practices'}/${p.input.recordId}/items/Task/${p.input.taskId}`;
      return { id: work.id, title: 'Promemoria di una scadenza', category: 'Promemoria scelto dall’Admin',
        related: 'Attività nel tuo perimetro', href: `/notifications/updates/${work.id}`, recordHref,
        date: new Date(p.input.remindAt), dueAt: new Date(p.source.dueAt), readAt,
        changed: ['dueDate'] as ['dueDate'], event: 'DEADLINE' as const, priority: 'bassa' as const,
        accessUntil: Math.min(claimed.expiresAt * 1000, auth.registry.expiresAt.getTime(),
          ...[p.policyExpiresAt, admission.accessUntil, p.recipients.find(row => row.id === person.raw.id)?.accessUntil]
            .filter((value): value is string => typeof value === 'string').map(value => Date.parse(value))),
        state: current.state, availableAt: p.input.remindAt, emailSent: false as const };
    } catch (error) {
      // A write that failed the final check must roll back, not become a null
      // response committing an earlier read receipt.
      if (markRead) throw error;
      if ((error instanceof RecordUpdateError || error instanceof TechnicalAssignmentError)
        && ['DENIED', 'STALE'].includes(error.code)) return null;
      throw error;
    }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 });
  try { return markRead ? await read() : await confirmedReadRetry(read); }
  catch (error) { throw mapSerializableConflict(error); }
}

function publicNotice(row: NonNullable<Awaited<ReturnType<typeof readNotice>>>) {
  const { accessUntil, ...notice } = row; void accessUntil;
  return notice;
}

export async function readRecordReminderNotice(db: PrismaClient, claimed: AuthSession, key: PrivilegedStepUpKey,
  id: string, markRead = false) {
  const row = await readNotice(db, claimed, key, id, markRead);
  return row ? publicNotice(row) : null;
}

/** Scan only the existing recipient queue. Availability is checked before the
 * visible limit, so future, cancelled and revoked entries cannot hide a valid
 * notice. The keyset is internal: inaccessible IDs/counts never reach the UI.
 * Each notice has its own current source/permission transaction; opening it
 * repeats admission. The final session/clock check covers long scans. */
export async function listRecordReminderNotices(db: PrismaClient, claimed: AuthSession, key: PrivilegedStepUpKey,
  limit = 100, unreadOnly = true) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new RecordUpdateError('INVALID');
  type Cursor = { id: string; availableAt: Date };
  let cursor: Cursor | undefined;
  const result: NonNullable<Awaited<ReturnType<typeof readNotice>>>[] = [];
  while (result.length < limit) {
    const rows: Cursor[] = await confirmedReadRetry(() => db.$transaction(async tx => {
      if (!await lockRegisteredPrivilegedStepUpKey(tx, key)) throw new RecordUpdateError('DENIED');
      const auth = await updateActor(tx, claimed), now = await auth.finish();
      const batch = await tx.$queryRaw<Cursor[]>(Prisma.sql`
        SELECT d.id,r."availableAt" FROM "RecordUpdateDelivery" d
        JOIN "RecordUpdateReminder" r ON r."commandId"=d."commandId" AND r."eventId"=d."eventId"
        WHERE d."recipientId"=${auth.actor.id} AND d.mode='CRM' AND r."availableAt"<=${now}
          ${unreadOnly ? Prisma.sql`AND d."readAt" IS NULL` : Prisma.empty}
          AND NOT EXISTS (SELECT 1 FROM "RecordUpdateReminderCancellation" c WHERE c."reminderCommandId"=r."commandId")
          ${cursor ? Prisma.sql`AND (r."availableAt"<${cursor.availableAt} OR (r."availableAt"=${cursor.availableAt} AND d.id<${cursor.id}::uuid))` : Prisma.empty}
        ORDER BY r."availableAt" DESC,d.id DESC LIMIT 100`);
      await auth.finish(); return batch;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 }));
    for (const candidate of rows) {
      const row = await readNotice(db, claimed, key, candidate.id);
      if (row && (!unreadOnly || row.readAt === null)) result.push(row);
      if (result.length === limit) break;
    }
    if (rows.length < 100) break;
    cursor = rows.at(-1)!;
  }
  const finishedAt = await confirmedReadRetry(() => db.$transaction(async tx => {
    if (!await lockRegisteredPrivilegedStepUpKey(tx, key)) throw new RecordUpdateError('DENIED');
    const auth = await updateActor(tx, claimed); return auth.finish();
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 }));
  return result.filter(row => row.accessUntil > finishedAt.getTime()).map(publicNotice);
}

function ordinaryPath(journal: RecordReminderJournal) {
  const input = journal.prepared.input;
  const prefix = input.kind === 'CLIENT' ? '/clients' : input.kind === 'PROJECT' ? '/projects' : '/technical-office/practices';
  return `${prefix}/${input.recordId}`;
}
