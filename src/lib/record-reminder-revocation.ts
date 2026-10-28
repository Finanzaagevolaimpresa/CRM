import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { AuthSession } from './auth';
import { canonicalJson, canonicalSha256 } from './canonical-json';
import { lockRegisteredPrivilegedStepUpKey } from './application-key-registry';
import { lockCommunicationDirectory } from './communication-directory-lock';
import { confirmedReadRetry } from './confirmed-read-retry';
import { RecordUpdateError } from './record-update-contract';
import { readRecordReminderJournal } from './record-reminder-journal';
import { lockReminderPrincipals } from './record-reminder-principal';
import { updateActor, type UpdateCredentials } from './record-updates';
import { mapSerializableConflict } from './serializable';

type Tx = Prisma.TransactionClient;
const request = z.object({ commandId: z.string().uuid(), reminderCommandId: z.string().uuid() }).strict();
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const cancellation = z.object({ protocol: z.literal('FAI_RECORD_REMINDER_CANCEL_V1'),
  commandId: z.string().uuid(), reminderCommandId: z.string().uuid(), reminderDigest: hex,
  actorId: z.string().min(1).max(100), actorEpoch: z.number().int().positive(), sessionId: z.string().uuid(),
  keyVersion: z.number().int().positive(), auditId: z.string().uuid(),
  transactionId: z.string().regex(/^[1-9][0-9]*$/), canceledAt: z.string().datetime({ precision: 3, offset: false }) }).strict();
type Cancellation = z.infer<typeof cancellation>;
function signature(key: UpdateCredentials['key'], value: Cancellation) {
  if (key.version !== value.keyVersion || key.secret.length < 32) throw new RecordUpdateError('DENIED');
  return createHmac('sha256', key.secret).update('FAI_RECORD_REMINDER_CANCEL_V1:').update(canonicalJson(value)).digest('hex');
}
function commandDigest(value: Cancellation) {
  return canonicalSha256({ protocol: value.protocol, commandId: value.commandId,
    reminderCommandId: value.reminderCommandId, reminderDigest: value.reminderDigest,
    actorId: value.actorId, actorEpoch: value.actorEpoch, sessionId: value.sessionId });
}

async function owned(tx: Tx, claimed: AuthSession, credentials: UpdateCredentials, reminderCommandId: string) {
  if (!await lockRegisteredPrivilegedStepUpKey(tx, credentials.key)) throw new RecordUpdateError('DENIED');
  await lockCommunicationDirectory(tx);
  const rows = await tx.$queryRaw<Array<{ journal: unknown; proof: string }>>`SELECT journal,proof
    FROM "RecordUpdateReminder" WHERE "commandId"=${reminderCommandId}::uuid`;
  const journal = rows.length === 1 ? readRecordReminderJournal(credentials.key, rows[0].journal, rows[0].proof) : null;
  await lockReminderPrincipals(tx, claimed.userId, journal?.prepared.recipients.map(person => person.id) ?? []);
  const auth = await updateActor(tx, claimed, credentials);
  if (auth.actor.role !== 'admin') throw new RecordUpdateError('DENIED');
  if (!journal || journal.commandId !== reminderCommandId || journal.prepared.authorId !== auth.actor.id) {
    await auth.finish(); return null;
  }
  const original = await tx.recordUpdateCommand.findUnique({ where: { id: reminderCommandId } });
  if (!original || original.operation !== 'REMINDER' || original.actorId !== auth.actor.id
    || original.digest !== journal.commandDigest) throw new RecordUpdateError('DENIED');
  // Canceling one's own retained reminder requires current personal Admin
  // authority, but must remain possible after the source itself is trashed.
  // No old title, document, recipient name or source content is projected.
  return { auth, journal, original };
}

export async function readRetainedReminderCancellation(tx: Tx, key: UpdateCredentials['key'], reminderCommandId: string) {
  const rows = await tx.$queryRaw<Array<{ commandId: string; auditId: string; journal: unknown; proof: string; canceledAt: Date }>>`
    SELECT "commandId","auditId",journal,proof,"canceledAt" FROM "RecordUpdateReminderCancellation"
    WHERE "reminderCommandId"=${reminderCommandId}::uuid`;
  if (!rows.length) return null;
  if (rows.length !== 1) throw new RecordUpdateError('DENIED');
  const row = rows[0], parsed = cancellation.safeParse(row.journal);
  if (!parsed.success || !hex.safeParse(row.proof).success) throw new RecordUpdateError('DENIED');
  const value = parsed.data;
  if (!timingSafeEqual(Buffer.from(row.proof, 'hex'), Buffer.from(signature(key, value), 'hex'))
    || canonicalJson(value) !== canonicalJson(row.journal) || value.reminderCommandId !== reminderCommandId
    || row.commandId !== value.commandId || row.auditId !== value.auditId
    || row.canceledAt.toISOString() !== value.canceledAt) throw new RecordUpdateError('DENIED');
  const command = await tx.recordUpdateCommand.findUnique({ where: { id: value.commandId } });
  if (!command || command.operation !== 'REMINDER_REVOKE' || command.digest !== commandDigest(value)
    || command.actorId !== value.actorId || command.actorEpoch !== value.actorEpoch
    || command.transactionId.toString() !== value.transactionId
    || command.createdAt.toISOString() !== value.canceledAt) throw new RecordUpdateError('DENIED');
  return value;
}

/** Prepared cancellation of the existing queue entry, never a second queue or
 * deletion. No route calls this yet. An uncertain response is reconciled by
 * the separate read function; this mutation is never automatically retried. */
export async function cancelRecordReminder(db: PrismaClient, claimed: AuthSession, credentials: UpdateCredentials,
  raw: unknown, confirmed: boolean) {
  const input = request.parse(raw);
  if (confirmed !== true || input.commandId === input.reminderCommandId) throw new RecordUpdateError('INVALID');
  try { return await db.$transaction(async tx => {
    const target = await owned(tx, claimed, credentials, input.reminderCommandId);
    if (!target) throw new RecordUpdateError('DENIED');
    const { auth, original } = target, old = await readRetainedReminderCancellation(tx, credentials.key, input.reminderCommandId);
    if (old) {
      if (old.commandId !== input.commandId || old.actorId !== auth.actor.id
        || old.reminderDigest !== original.digest) throw new RecordUpdateError('STALE');
      await auth.finish();
      return { commandId: old.commandId, reminderCommandId: input.reminderCommandId, canceled: true, replayed: true, canceledAt: old.canceledAt };
    }
    if (await tx.recordUpdateCommand.findUnique({ where: { id: input.commandId } })) throw new RecordUpdateError('STALE');
    const now = await auth.finish(), auditId = randomUUID();
    const [transaction] = await tx.$queryRaw<Array<{ id: bigint }>>`SELECT txid_current() AS id`;
    const value = cancellation.parse({ protocol: 'FAI_RECORD_REMINDER_CANCEL_V1', ...input,
      reminderDigest: original.digest, actorId: auth.actor.id, actorEpoch: auth.actor.recordUpdateEpoch,
      sessionId: auth.registry.id, keyVersion: credentials.key.version, auditId,
      transactionId: transaction.id.toString(), canceledAt: now.toISOString() });
    await tx.recordUpdateCommand.create({ data: { id: input.commandId, actorId: auth.actor.id,
      actorEpoch: auth.actor.recordUpdateEpoch, kind: original.kind, recordId: original.recordId,
      digest: commandDigest(value), operation: 'REMINDER_REVOKE', mode: 'CRM', emailAuthorityRevision: null,
      scope: { reminderCommandId: original.id, reminderDigest: original.digest }, selection: { people: [], groups: [] },
      directoryBinding: original.directoryBinding, recipients: [], transactionId: transaction.id, createdAt: now } });
    await tx.auditLog.create({ data: { id: auditId, actorId: auth.actor.id, event: 'record_reminder_canceled',
      entityType: 'RecordUpdateCommand', entityId: input.commandId, createdAt: now,
      after: { type: 'RECORD_REMINDER_CANCEL_V1', recordId: input.reminderCommandId } } });
    await tx.$executeRaw`INSERT INTO "RecordUpdateReminderCancellation"("commandId","reminderCommandId","auditId","canceledAt",journal,proof)
      VALUES(${input.commandId}::uuid,${input.reminderCommandId}::uuid,${auditId},${now},${canonicalJson(value)}::jsonb,${signature(credentials.key, value)})`;
    await tx.$executeRaw`SET CONSTRAINTS record_reminder_cancel_command_deferred,
      record_reminder_cancel_journal_deferred,record_reminder_cancel_delivery_deferred IMMEDIATE`;
    await auth.finish();
    return { commandId: input.commandId, reminderCommandId: input.reminderCommandId, canceled: true, replayed: false, canceledAt: now.toISOString() };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 }); }
  catch (error) { throw mapSerializableConflict(error); }
}

export async function readRecordReminderCancellation(db: PrismaClient, claimed: AuthSession,
  credentials: UpdateCredentials, raw: unknown) {
  const input = request.parse(raw);
  return confirmedReadRetry(() => db.$transaction(async tx => {
    const target = await owned(tx, claimed, credentials, input.reminderCommandId);
    if (!target) return { ...input, canceled: false };
    const value = await readRetainedReminderCancellation(tx, credentials.key, input.reminderCommandId);
    await target.auth.finish();
    return value && value.commandId === input.commandId && value.actorId === target.auth.actor.id
      && value.reminderDigest === target.original.digest
      ? { ...input, canceled: true, canceledAt: value.canceledAt } : { ...input, canceled: false };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 }));
}
