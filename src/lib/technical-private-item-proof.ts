import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from './canonical-json';
import type { PrivilegedStepUpKey } from './privileged-step-up-token';
import { technicalTargetReference } from './technical-assignment-display';
import { admitsTechnicalPrivateItemCreation, technicalPrivateItemAdmission, technicalPrivateItemCommand,
  technicalPrivateItemOrigin, technicalPrivateItemRequestDigest, type TechnicalPrivateItemAdmission,
  type TechnicalPrivateItemCommand, type TechnicalPrivateItemOrigin } from './technical-private-item-contract';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const epoch = z.number().int().positive().max(2_147_483_647);
const instant = z.number().int().nonnegative().max(8_640_000_000_000_000);
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const lifetime = 300_000, maxBytes = 48_000;
const preview = z.object({ protocol: z.literal('TECHNICAL_PRIVATE_ITEM_PREVIEW_V1'),
  command: technicalPrivateItemCommand, admission: technicalPrivateItemAdmission,
  issuedAt: instant, expiresAt: instant }).strict();
const envelope = z.object({ payload: preview, proof: digest }).strict();

function sign(key: PrivilegedStepUpKey, purpose: 'preview' | 'receipt' | 'origin', value: unknown) {
  if (!epoch.safeParse(key.version).success || typeof key.secret !== 'string' || key.secret.length < 32) {
    throw new Error('TECHNICAL_PRIVATE_ITEM_KEY_INVALID');
  }
  return createHmac('sha256', key.secret)
    .update('FAI_TECHNICAL_PRIVATE_ITEM_V1:' + purpose + ':' + key.version + ':')
    .update(canonicalJson(value)).digest('hex');
}
function equal(a: string, b: string) {
  return digest.safeParse(a).success && digest.safeParse(b).success
    && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
function expiresAt(admission: TechnicalPrivateItemAdmission, issuedAt: number) {
  return Math.min(issuedAt + lifetime, admission.sessionExpiresAt, admission.personalProofExpiresAt);
}

export function previewTechnicalPrivateItemCreation(key: PrivilegedStepUpKey, raw: TechnicalPrivateItemCommand,
  current: TechnicalPrivateItemAdmission, now: number) {
  const command = technicalPrivateItemCommand.parse(raw), admission = technicalPrivateItemAdmission.parse(current);
  if (!admitsTechnicalPrivateItemCreation(command, admission, now) || key.version !== admission.keyVersion) {
    throw new Error('TECHNICAL_PRIVATE_ITEM_DENIED');
  }
  const payload = preview.parse({ protocol: 'TECHNICAL_PRIVATE_ITEM_PREVIEW_V1', command, admission,
    issuedAt: now, expiresAt: expiresAt(admission, now) });
  const token = Buffer.from(canonicalJson({ payload, proof: sign(key, 'preview', payload) })).toString('base64url');
  if (token.length > maxBytes) throw new Error('TECHNICAL_PRIVATE_ITEM_TOO_LARGE');
  return { command, token };
}

/** Only a plan, not a recorded result. The service must freshly admit all facts
 * and atomically retain origin/command/audit; no automatic grant is represented. */
export function confirmTechnicalPrivateItemCreation(key: PrivilegedStepUpKey, raw: unknown,
  current: TechnicalPrivateItemAdmission, token: string, confirmed: boolean, now: number) {
  try {
    const admission = technicalPrivateItemAdmission.parse(current), command = technicalPrivateItemCommand.parse(raw);
    if (confirmed !== true || !admitsTechnicalPrivateItemCreation(command, admission, now)
      || canonicalJson(command) !== canonicalJson(raw) || key.version !== admission.keyVersion
      || typeof token !== 'string' || token.length > maxBytes || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
    const decoded = Buffer.from(token, 'base64url').toString('utf8');
    const value = envelope.parse(JSON.parse(decoded)), payload = value.payload;
    if (Buffer.from(decoded).toString('base64url') !== token || canonicalJson(value) !== decoded
      || canonicalJson(payload.command) !== canonicalJson(command)
      || canonicalJson(payload.admission) !== canonicalJson(admission)
      || payload.issuedAt > now || payload.expiresAt <= now
      || payload.expiresAt !== expiresAt(admission, payload.issuedAt)
      || !equal(value.proof, sign(key, 'preview', payload))) return null;
    return { command, requestDigest: technicalPrivateItemRequestDigest(command) };
  } catch { return null; }
}

export const technicalPrivateItemReceipt = z.object({
  protocol: z.literal('TECHNICAL_PRIVATE_ITEM_RECEIPT_V1'), commandId: z.string().uuid(),
  itemId: z.string().uuid(), kind: z.enum(['Task', 'ChecklistItem']), target: technicalTargetReference,
  actorId: id, sessionId: z.string().uuid(), authorityRevision: epoch, keyVersion: epoch,
  requestDigest: digest, admissionSha256: digest, recordedAt: z.string().datetime(),
  grantCreated: z.literal(false), notificationCreated: z.literal(false),
}).strict();
export type TechnicalPrivateItemReceipt = z.infer<typeof technicalPrivateItemReceipt>;
export function signTechnicalPrivateItemReceipt(key: PrivilegedStepUpKey, raw: TechnicalPrivateItemReceipt) {
  const receipt = technicalPrivateItemReceipt.parse(raw);
  if (key.version !== receipt.keyVersion) throw new Error('TECHNICAL_PRIVATE_ITEM_KEY_INVALID');
  return sign(key, 'receipt', receipt);
}
export function readTechnicalPrivateItemReceipt(key: PrivilegedStepUpKey, raw: unknown, proof: string,
  expected: Pick<TechnicalPrivateItemReceipt, 'commandId' | 'itemId' | 'kind' | 'target' | 'actorId' | 'sessionId' | 'requestDigest'>, now: number) {
  try {
    const receipt = technicalPrivateItemReceipt.parse(raw);
    if (!instant.safeParse(now).success || Date.parse(receipt.recordedAt) > now || key.version !== receipt.keyVersion
      || !equal(proof, sign(key, 'receipt', receipt))) return null;
    for (const field of ['commandId', 'itemId', 'kind', 'target', 'actorId', 'sessionId', 'requestDigest'] as const) {
      if (canonicalJson(receipt[field]) !== canonicalJson(expected[field])) return null;
    }
    return receipt;
  } catch { return null; }
}

/** The origin is a retained target constraint, not an authorization. A separate
 * current personal assignment is still necessary before any recipient read. */
export function signTechnicalPrivateItemOrigin(key: PrivilegedStepUpKey, raw: TechnicalPrivateItemOrigin) {
  return sign(key, 'origin', technicalPrivateItemOrigin.parse(raw));
}

export function readTechnicalPrivateItemOriginProof(key: PrivilegedStepUpKey, raw: unknown, proof: string,
  expected: Pick<TechnicalPrivateItemOrigin, 'kind' | 'itemId'>) {
  try {
    const origin = technicalPrivateItemOrigin.parse(raw);
    if (canonicalJson(origin) !== canonicalJson(raw) || origin.kind !== expected.kind || origin.itemId !== expected.itemId
      || !equal(proof, sign(key, 'origin', origin))) return null;
    return origin;
  } catch { return null; }
}
