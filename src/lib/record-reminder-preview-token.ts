import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PrivilegedStepUpKey } from './privileged-step-up-token';
import { canonicalJson } from './canonical-json';
import { RecordUpdateError } from './record-update-contract';
import type { PreparedRecordReminder } from './record-reminder-contract';
import { assertRecordReminderPreview } from './record-reminder-contract';

const previewLifetime = 5 * 60_000;
type Preview = { protocol: 'FAI_RECORD_REMINDER_PREVIEW_V1'; digest: string; actorId: string; sessionId: string;
  commandId: string; keyVersion: number; issuedAt: string; expiresAt: string };
function proof(key: PrivilegedStepUpKey, preview: Preview) {
  if (!Number.isSafeInteger(key.version) || key.version < 1 || key.secret.length < 32) throw new RecordUpdateError('DENIED');
  return createHmac('sha256', key.secret).update('FAI_RECORD_REMINDER_PREVIEW_V1:').update(canonicalJson(preview)).digest('hex');
}
export function signRecordReminderPreview(key: PrivilegedStepUpKey, prepared: PreparedRecordReminder, now: Date, accessUntil: number) {
  assertRecordReminderPreview(prepared.digest, prepared);
  const expiresAt = Math.min(now.getTime() + previewLifetime, accessUntil, Date.parse(prepared.input.remindAt));
  if (!Number.isFinite(now.getTime()) || !Number.isFinite(expiresAt) || expiresAt <= now.getTime()) throw new RecordUpdateError('DENIED');
  const preview: Preview = { protocol: 'FAI_RECORD_REMINDER_PREVIEW_V1', digest: prepared.digest,
    actorId: prepared.authorId, sessionId: prepared.sessionId, commandId: prepared.input.commandId,
    keyVersion: key.version, issuedAt: now.toISOString(), expiresAt: new Date(expiresAt).toISOString() };
  return { preview, proof: proof(key, preview) };
}
export function assertRecordReminderSignedPreview(key: PrivilegedStepUpKey, token: ReturnType<typeof signRecordReminderPreview>,
  prepared: PreparedRecordReminder, now: Date) {
  assertRecordReminderPreview(prepared.digest, prepared);
  const p = token?.preview;
  if (!p || p.protocol !== 'FAI_RECORD_REMINDER_PREVIEW_V1' || p.keyVersion !== key.version
    || p.actorId !== prepared.authorId || p.sessionId !== prepared.sessionId || p.commandId !== prepared.input.commandId
    || p.digest !== prepared.digest || !Number.isFinite(now.getTime()) || !Number.isFinite(Date.parse(p.issuedAt))
    || !Number.isFinite(Date.parse(p.expiresAt)) || Date.parse(p.issuedAt) > now.getTime() || Date.parse(p.expiresAt) <= now.getTime()
    || Date.parse(p.expiresAt) - Date.parse(p.issuedAt) > previewLifetime
    || typeof token.proof !== 'string' || !/^[a-f0-9]{64}$/.test(token.proof)
    || !timingSafeEqual(Buffer.from(token.proof, 'hex'), Buffer.from(proof(key, p), 'hex'))) throw new RecordUpdateError('STALE');
}
