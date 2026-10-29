import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { AuthSession } from './auth';
import { canonicalJson } from './canonical-json';
import { lockRegisteredPrivilegedStepUpKey } from './application-key-registry';
import { confirmedReadRetry } from './confirmed-read-retry';
import { RecordUpdateError } from './record-update-contract';
import { parseRecordReminder } from './record-reminder-contract';
import { lockedRecordReminderProposal } from './record-reminder-preview';
import { assertRecordReminderSignedPreview, type signRecordReminderPreview } from './record-reminder-preview-token';
import { readRecordReminderJournal, reminderCommandDigest, sealRecordReminderJournal } from './record-reminder-journal';
import { updateActor, type UpdateCredentials } from './record-updates';
import { mapSerializableConflict } from './serializable';

type Tx = Prisma.TransactionClient;
type Token = ReturnType<typeof signRecordReminderPreview>;
async function retained(tx: Tx, key: UpdateCredentials['key'], commandId: string) {
  const rows = await tx.$queryRaw<Array<{ journal: unknown; proof: string }>>`SELECT journal,proof
    FROM "RecordUpdateReminder" WHERE "commandId"=${commandId}::uuid FOR SHARE`;
  if (rows.length > 1) throw new RecordUpdateError('DENIED');
  if (!rows.length) return null;
  const value = readRecordReminderJournal(key, rows[0].journal, rows[0].proof);
  if (!value || value.commandId !== commandId) throw new RecordUpdateError('DENIED');
  return value;
}

/** Prepared adapter, not connected to an action or route. Requires the isolated
 * proposed SQL extension: no production migration is implied. Writes the one
 * existing RecordUpdate queue atomically with its immutable scheduling journal. */
export async function confirmRecordReminder(db: PrismaClient, claimed: AuthSession, credentials: UpdateCredentials,
  raw: unknown, token: Token, confirmed: boolean) {
  const input = parseRecordReminder(raw);
  if (confirmed !== true) throw new RecordUpdateError('DENIED');
  try { return await db.$transaction(async tx => {
    const p = await lockedRecordReminderProposal(tx, claimed, credentials, input);
    assertRecordReminderSignedPreview(credentials.key, token, p.prepared, p.now);
    const digest = reminderCommandDigest(p.prepared);
    const old = await tx.recordUpdateCommand.findUnique({ where: { id: input.commandId } });
    if (old) {
      const journal = await retained(tx, credentials.key, input.commandId);
      if (!journal || old.operation !== 'REMINDER' || old.actorId !== p.auth.actor.id || old.digest !== digest
        || journal.commandDigest !== digest || journal.prepared.sessionId !== p.auth.registry.id) throw new RecordUpdateError('STALE');
      await p.auth.finish();
      return { commandId: old.id, confirmed: true, replayed: true, eventId: journal.eventId };
    }
    const eventId = randomUUID(), auditId = randomUUID();
    const [transaction] = await tx.$queryRaw<Array<{ id: bigint }>>`SELECT txid_current() AS id`;
    const sealed = sealRecordReminderJournal(credentials.key, p.prepared,
      { eventId, auditId, confirmedAt: p.now, transactionId: transaction.id });
    await tx.recordUpdateCommand.create({ data: { id: input.commandId, actorId: p.auth.actor.id,
      actorEpoch: p.auth.actor.recordUpdateEpoch, kind: input.kind, recordId: input.recordId, digest,
      operation: 'REMINDER', mode: 'CRM', emailAuthorityRevision: null,
      scope: p.prepared.source, selection: input.selection, directoryBinding: p.prepared.directoryBinding,
      recipients: p.prepared.recipients.map(row => ({ id: row.id, epoch: row.epoch })), transactionId: transaction.id, createdAt: p.now } });
    await tx.recordUpdateEvent.create({ data: { id: eventId, kind: input.kind, recordId: input.recordId,
      event: 'DEADLINE', changed: ['dueDate'], scope: p.prepared.source, sourceKey: p.prepared.eventKey, occurredAt: p.now } });
    for (const person of p.prepared.recipients) await tx.recordUpdateDelivery.create({ data: { eventId,
      commandId: input.commandId, recipientId: person.id, recipientEpoch: person.epoch, mode: 'CRM' } });
    await tx.auditLog.create({ data: { id: auditId, actorId: p.auth.actor.id, event: 'record_reminder_scheduled',
      entityType: 'RecordUpdateCommand', entityId: input.commandId, createdAt: p.now,
      after: { type: 'RECORD_REMINDER_V1', recordId: input.commandId, count: p.prepared.recipients.length } } });
    await tx.$executeRaw`INSERT INTO "RecordUpdateReminder"("commandId","eventId","auditId","taskId","availableAt","confirmedAt","keyVersion",journal,proof)
      VALUES(${input.commandId}::uuid,${eventId}::uuid,${auditId},${input.taskId},${new Date(input.remindAt)},${p.now},${credentials.key.version},
        ${canonicalJson(sealed.value)}::jsonb,${sealed.proof})`;
    // Surface deferred journal failures inside the callback. In the qualified
    // driver path a PostgreSQL COMMIT rejection can otherwise resolve without
    // its error reaching the caller, falsely reporting a saved reminder.
    await tx.$executeRaw`SET CONSTRAINTS record_reminder_command_deferred,
      record_reminder_event_deferred, record_reminder_delivery_deferred,
      record_reminder_journal_deferred IMMEDIATE`;
    const finishedAt = await p.auth.finish();
    assertRecordReminderSignedPreview(credentials.key, token, p.prepared, finishedAt);
    return { commandId: input.commandId, confirmed: true, replayed: false, eventId };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 }); }
  catch (error) { throw mapSerializableConflict(error); }
}

/** Reconciliation does not retry confirmation or disclose source data. It only
 * reports the immutable command owned by the currently authenticated Admin. */
export async function readRecordReminderReceipt(db: PrismaClient, claimed: AuthSession, credentials: UpdateCredentials,
  commandId: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(commandId)) throw new RecordUpdateError('INVALID');
  return confirmedReadRetry(() => db.$transaction(async tx => {
    if (!await lockRegisteredPrivilegedStepUpKey(tx, credentials.key)) throw new RecordUpdateError('DENIED');
    const auth = await updateActor(tx, claimed, credentials);
    if (auth.actor.role !== 'admin') throw new RecordUpdateError('DENIED');
    const command = await tx.recordUpdateCommand.findFirst({ where: { id: commandId, actorId: auth.actor.id } });
    if (!command) { await auth.finish(); return { commandId, confirmed: false }; }
    const journal = await retained(tx, credentials.key, commandId);
    if (command.operation !== 'REMINDER' || !journal || command.digest !== journal.commandDigest
      || journal.prepared.authorId !== auth.actor.id) throw new RecordUpdateError('DENIED');
    await auth.finish();
    return { commandId, confirmed: true, eventId: journal.eventId, registeredAt: journal.confirmedAt };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 }));
}
