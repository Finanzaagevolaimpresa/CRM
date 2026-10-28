import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson, canonicalSha256 } from './canonical-json';
import type { PrivilegedStepUpKey } from './privileged-step-up-token';
import { assertRecordReminderPreview, parseRecordReminder, type PreparedRecordReminder } from './record-reminder-contract';
import { RecordUpdateError } from './record-update-contract';

const hex = z.string().regex(/^[a-f0-9]{64}$/);
const instant = z.string().datetime({ precision: 3, offset: false });
const envelope = z.object({ protocol: z.literal('FAI_RECORD_REMINDER_JOURNAL_V1'),
  commandId: z.string().uuid(), eventId: z.string().uuid(), auditId: z.string().uuid(),
  keyVersion: z.number().int().positive(), transactionId: z.string().regex(/^[1-9][0-9]*$/),
  confirmedAt: instant, commandDigest: hex, prepared: z.unknown() }).strict();
export type RecordReminderJournal = Omit<z.infer<typeof envelope>, 'prepared'> & { prepared: PreparedRecordReminder };
export function reminderCommandDigest(prepared: PreparedRecordReminder) {
  assertRecordReminderPreview(prepared.digest, prepared);
  return canonicalSha256({ protocol: 'FAI_RECORD_REMINDER_COMMAND_V1', input: prepared.input, previewDigest: prepared.digest });
}
function signature(key: PrivilegedStepUpKey, value: RecordReminderJournal) {
  if (!Number.isSafeInteger(key.version) || key.version < 1 || key.secret.length < 32) throw new RecordUpdateError('DENIED');
  return createHmac('sha256', key.secret).update('FAI_RECORD_REMINDER_JOURNAL_V1:').update(canonicalJson(value)).digest('hex');
}
export function sealRecordReminderJournal(key: PrivilegedStepUpKey, prepared: PreparedRecordReminder,
  metadata: { eventId: string; auditId: string; confirmedAt: Date; transactionId: bigint }) {
  const commandDigest = reminderCommandDigest(prepared);
  const value = envelope.parse({ protocol: 'FAI_RECORD_REMINDER_JOURNAL_V1', commandId: prepared.input.commandId,
    eventId: metadata.eventId, auditId: metadata.auditId, keyVersion: key.version,
    transactionId: metadata.transactionId.toString(), confirmedAt: metadata.confirmedAt.toISOString(), commandDigest, prepared }) as RecordReminderJournal;
  if (Date.parse(value.confirmedAt) >= Date.parse(prepared.input.remindAt)) throw new RecordUpdateError('STALE');
  return { value, proof: signature(key, value) };
}
/** A retained schedule is admitted only from the original authenticated journal.
 * The digest alone is not authenticity and cannot replace this HMAC. */
export function readRecordReminderJournal(key: PrivilegedStepUpKey, raw: unknown, proof: unknown): RecordReminderJournal | null {
  try {
    const parsed = envelope.safeParse(raw);
    if (!parsed.success || !hex.safeParse(proof).success || parsed.data.keyVersion !== key.version) return null;
    const value = parsed.data as RecordReminderJournal;
    if (!timingSafeEqual(Buffer.from(String(proof), 'hex'), Buffer.from(signature(key, value), 'hex'))) return null;
    const prepared = value.prepared;
    assertRecordReminderPreview(prepared.digest, prepared);
    if (canonicalJson(parseRecordReminder(prepared.input)) !== canonicalJson(prepared.input)
      || value.commandId !== prepared.input.commandId || value.commandDigest !== reminderCommandDigest(prepared)
      || Date.parse(value.confirmedAt) >= Date.parse(prepared.input.remindAt)) return null;
    return value;
  } catch { return null; }
}
