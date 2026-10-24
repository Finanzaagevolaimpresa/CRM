import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson, canonicalSha256 } from './canonical-json';
import type { PrivilegedStepUpKey } from './privileged-step-up-token';
import { technicalAssignmentReference } from './technical-assignment-decision';

const uuid = z.string().uuid(), hash = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const generation = z.number().int().positive().max(2_147_483_647);
export const technicalUploadReviewCommand = z.object({ commandId: uuid, submissionCommandId: uuid,
  sourceSha256: hash, verdict: z.enum(['APPROVE_PRIVATE', 'REJECT_PRIVATE']),
  reason: z.string().trim().min(3).max(500) }).strict();
export const technicalUploadReviewAdmission = z.object({ reference: technicalAssignmentReference,
  sourceSha256: hash, submissionCommandId: uuid, assignmentId: uuid, assignmentRevision: generation,
  assignmentStateSha256: hash, contextSha256: hash, actorId: id, sessionId: uuid,
  authorityRevision: generation, actorEpoch: generation, recipientEpoch: generation, keyVersion: generation,
  validUntil: z.number().int().positive().safe() }).strict();
export type TechnicalUploadReviewAdmission = z.infer<typeof technicalUploadReviewAdmission>;
export const technicalUploadReviewReceipt = z.object({ protocol: z.literal('TECHNICAL_UPLOAD_REVIEW_RECEIPT_V1'),
  commandId: uuid, submissionCommandId: uuid, actorId: id, sessionId: uuid,
  reference: technicalAssignmentReference, requestDigest: hash,
  verdict: technicalUploadReviewCommand.shape.verdict, recordedAt: z.string().datetime(), keyVersion: generation }).strict();
export const technicalUploadReviewRecord = z.object({ command: technicalUploadReviewCommand,
  receipt: technicalUploadReviewReceipt, proof: hash }).strict();
export type TechnicalUploadReviewRecord = z.infer<typeof technicalUploadReviewRecord>;
function sign(key: PrivilegedStepUpKey, purpose: 'preview' | 'receipt', value: unknown) {
  if (key.secret.length < 32 || !generation.safeParse(key.version).success) throw new Error('TECHNICAL_UPLOAD_REVIEW_KEY');
  return createHmac('sha256', key.secret).update(`FAI_TECHNICAL_UPLOAD_REVIEW_V1:${purpose}:${key.version}:`)
    .update(canonicalJson(value)).digest('hex');
}
function equal(left: string, right: string) { return hash.safeParse(left).success && hash.safeParse(right).success
  && timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex')); }
export function technicalUploadReviewDigest(reference: z.infer<typeof technicalAssignmentReference>, command: unknown) {
  return canonicalSha256({ protocol: 'TECHNICAL_UPLOAD_REVIEW_REQUEST_V1', reference: technicalAssignmentReference.parse(reference),
    command: technicalUploadReviewCommand.parse(command) });
}
function matches(command: z.infer<typeof technicalUploadReviewCommand>, current: TechnicalUploadReviewAdmission, key: PrivilegedStepUpKey, now: number) {
  if (!Number.isSafeInteger(now) || current.validUntil <= now || current.keyVersion !== key.version
    || command.sourceSha256 !== current.sourceSha256 || command.submissionCommandId !== current.submissionCommandId)
    throw new Error('TECHNICAL_UPLOAD_REVIEW_STALE');
}
const preview = z.object({ protocol: z.literal('TECHNICAL_UPLOAD_REVIEW_PREVIEW_V1'),
  command: technicalUploadReviewCommand, current: technicalUploadReviewAdmission,
  issuedAt: z.number().int().positive().safe(), expiresAt: z.number().int().positive().safe() }).strict();
export function createTechnicalUploadReviewPreview(key: PrivilegedStepUpKey, raw: unknown, admission: TechnicalUploadReviewAdmission, now: number) {
  const command = technicalUploadReviewCommand.parse(raw), current = technicalUploadReviewAdmission.parse(admission);
  matches(command, current, key, now);
  const payload = preview.parse({ protocol: 'TECHNICAL_UPLOAD_REVIEW_PREVIEW_V1', command, current,
    issuedAt: now, expiresAt: Math.min(current.validUntil, now + 300_000) });
  return Buffer.from(JSON.stringify({ payload, proof: sign(key, 'preview', payload) })).toString('base64url');
}
export function readTechnicalUploadReviewPreview(key: PrivilegedStepUpKey, token: string, raw: unknown, admission: TechnicalUploadReviewAdmission, now: number) {
  try {
    if (typeof token !== 'string' || token.length > 24_000) return null;
    const value = z.object({ payload: preview, proof: hash }).strict().parse(JSON.parse(Buffer.from(token, 'base64url').toString('utf8')));
    const command = technicalUploadReviewCommand.parse(raw), current = technicalUploadReviewAdmission.parse(admission), p = value.payload;
    matches(command, current, key, now);
    if (p.issuedAt > now || p.expiresAt <= now || p.expiresAt > p.issuedAt + 300_000
      || canonicalJson(p.current) !== canonicalJson(current) || canonicalJson(p.command) !== canonicalJson(command)
      || !equal(value.proof, sign(key, 'preview', p))) return null;
    return command;
  } catch { return null; }
}
export function prepareTechnicalUploadReview(key: PrivilegedStepUpKey, raw: unknown, current: TechnicalUploadReviewAdmission, now: Date) {
  const command = technicalUploadReviewCommand.parse(raw);
  technicalUploadReviewAdmission.parse(current); matches(command, current, key, now.getTime());
  const receipt = technicalUploadReviewReceipt.parse({ protocol: 'TECHNICAL_UPLOAD_REVIEW_RECEIPT_V1',
    commandId: command.commandId, submissionCommandId: command.submissionCommandId,
    actorId: current.actorId, sessionId: current.sessionId, reference: current.reference,
    requestDigest: technicalUploadReviewDigest(current.reference, command), verdict: command.verdict,
    recordedAt: now.toISOString(), keyVersion: key.version });
  return { command, receipt, proof: sign(key, 'receipt', receipt) };
}
/** Provenance only. Current file/list access and original-session outcome
 * admission are deliberately performed by separate callers. */
export function readTechnicalUploadReviewRecord(key: PrivilegedStepUpKey, raw: unknown, now: Date) {
  try {
    const record = technicalUploadReviewRecord.parse(raw), { command, receipt } = record;
    if (!Number.isFinite(now.getTime()) || Date.parse(receipt.recordedAt) > now.getTime()
      || receipt.keyVersion !== key.version || receipt.commandId !== command.commandId
      || receipt.submissionCommandId !== command.submissionCommandId || receipt.verdict !== command.verdict
      || receipt.requestDigest !== technicalUploadReviewDigest(receipt.reference, command)
      || !equal(record.proof, sign(key, 'receipt', receipt))) return null;
    return record;
  } catch { return null; }
}
