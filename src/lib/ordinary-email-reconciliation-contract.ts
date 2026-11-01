import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from './canonical-json';
import type { PrivilegedStepUpKey } from './privileged-step-up-token';

const uuid = z.string().uuid(), hash = z.string().regex(/^[a-f0-9]{64}$/);
export const ordinaryRecoveryReference = z.object({ messageId: uuid, attemptId: uuid }).strict();
export const ordinaryRecoveryConfirmation = ordinaryRecoveryReference.extend({
  token: z.string().min(1).max(4096), reason: z.string().trim().min(3).max(500), confirmed: z.literal(true),
}).strict();
export const ordinaryRecoveryPreviewSchema = ordinaryRecoveryReference.extend({
  protocol: z.literal('FAI_ORDINARY_EMAIL_RECOVERY_PREVIEW_V1'), commandId: uuid,
  actorId: z.string().min(1).max(128), sessionId: uuid, keyVersion: z.number().int().positive(),
  sourceHash: hash, stateHash: hash, outcome: z.enum(['ACCEPTED','NOT_SENT']),
  issuedAt: z.string().datetime(), expiresAt: z.string().datetime(),
}).strict();
export type OrdinaryRecoveryPreview = z.infer<typeof ordinaryRecoveryPreviewSchema>;
function signature(payload: OrdinaryRecoveryPreview, key: PrivilegedStepUpKey) {
  if (key.secret.length < 32 || payload.keyVersion !== key.version) throw new Error('ORDINARY_RECOVERY_PREVIEW_DENIED');
  return createHmac('sha256', key.secret).update('fai.ordinary-email.recovery.v1\n' + canonicalJson(payload)).digest('hex');
}
export function signOrdinaryRecoveryPreview(raw: OrdinaryRecoveryPreview, key: PrivilegedStepUpKey) {
  const payload = ordinaryRecoveryPreviewSchema.parse(raw);
  return 'oer1.' + Buffer.from(canonicalJson(payload)).toString('base64url') + '.' + signature(payload, key);
}
export function verifyOrdinaryRecoveryPreview(token: string, key: PrivilegedStepUpKey, now: Date) {
  const match = /^oer1\.([A-Za-z0-9_-]{1,3500})\.([a-f0-9]{64})$/.exec(token);
  if (!match) throw new Error('ORDINARY_RECOVERY_PREVIEW_DENIED');
  const raw = Buffer.from(match[1], 'base64url'), value = ordinaryRecoveryPreviewSchema.parse(JSON.parse(raw.toString('utf8')));
  const issued = Date.parse(value.issuedAt), expires = Date.parse(value.expiresAt);
  if (raw.toString('base64url') !== match[1] || canonicalJson(value) !== raw.toString('utf8')
    || !timingSafeEqual(Buffer.from(match[2], 'hex'), Buffer.from(signature(value,key), 'hex'))
    || !Number.isFinite(now.getTime()) || issued > now.getTime() || expires <= now.getTime()
    || expires <= issued || expires-issued > 300_000) throw new Error('ORDINARY_RECOVERY_PREVIEW_DENIED');
  return value;
}
export type OrdinaryRecoveryResult =
  | { status: 'UNAVAILABLE' }
  | { status: 'WAITING'; reason: 'IN_PROGRESS' | 'NO_AUTHORITATIVE_OBSERVATION' | 'RESERVED_WITHOUT_CLAIM' | 'ALREADY_FINAL' }
  | { status: 'READY'; token: string; commandId: string; outcome: 'ACCEPTED' | 'NOT_SENT'; sourceHash: string; observedAt: string; expiresAt: string }
  | { status: 'RECORDED'; commandId: string; outcome: 'ACCEPTED' | 'NOT_SENT'; sourceHash: string; recordedAt: string }
  | { status: 'STEP_UP_REQUIRED' | 'CHECK_CURRENT' };
