import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson, canonicalSha256 } from './canonical-json';
import type { PrivilegedStepUpKey } from './privileged-step-up-token';
import { technicalUploadReviewAdmission, readTechnicalUploadReviewRecord } from './technical-upload-review-contract';
import { technicalDocumentPrivateVisibility } from './technical-document-visibility';
export { technicalDocumentPrivateVisibility } from './technical-document-visibility';

const uuid = z.string().uuid(), hash = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const instant = z.number().int().positive().safe();

/** Preparation only: no route or writer consumes this contract yet. PRIVATE
 * must be enforced on every canonical reader before it can create a Document. */
export const technicalDocumentAcquisitionCommand = z.object({
  commandId: uuid, submissionCommandId: uuid, reviewCommandId: uuid,
  sourceSha256: hash, reviewSha256: hash,
  classification: z.enum(['TECHNICAL_DOCUMENT', 'CONTRACT', 'PAYMENT', 'OTHER_CONFIDENTIAL']),
  title: z.string().trim().min(3).max(180).regex(/^[^\u0000-\u001f\u007f]+$/),
  expiresAt: z.string().datetime().nullable(),
  visibility: z.literal('ADMIN_PRIVATE'),
}).strict();

export const technicalDocumentAcquisitionAdmission = technicalUploadReviewAdmission.extend({
  reviewCommandId: uuid, reviewSha256: hash,
  existingAcquisitionId: uuid.nullable(),
  clientId: id, projectId: id.nullable(), clientServiceId: id.nullable(),
  fileSha256: hash, sizeBytes: z.number().int().positive().max(25 * 1024 * 1024),
}).strict();
export type TechnicalDocumentAcquisitionAdmission = z.infer<typeof technicalDocumentAcquisitionAdmission>;

const previewPayload = z.object({
  protocol: z.literal('TECHNICAL_DOCUMENT_ACQUISITION_PREVIEW_V1'),
  command: technicalDocumentAcquisitionCommand, current: technicalDocumentAcquisitionAdmission,
  issuedAt: instant, expiresAt: instant,
}).strict();

function proof(key: PrivilegedStepUpKey, payload: unknown) {
  if (key.secret.length < 32 || !Number.isSafeInteger(key.version) || key.version < 1)
    throw new Error('TECHNICAL_DOCUMENT_ACQUISITION_KEY');
  return createHmac('sha256', key.secret)
    .update('FAI_TECHNICAL_DOCUMENT_ACQUISITION_PREVIEW_V1:').update(String(key.version)).update(':')
    .update(canonicalJson(payload)).digest('hex');
}
function equal(left: string, right: string) {
  return hash.safeParse(left).success && hash.safeParse(right).success
    && timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function eligible(key: PrivilegedStepUpKey, raw: unknown, rawCurrent: unknown, rawReview: unknown, now: number) {
  const command = technicalDocumentAcquisitionCommand.parse(raw);
  const current = technicalDocumentAcquisitionAdmission.parse(rawCurrent);
  const review = readTechnicalUploadReviewRecord(key, rawReview, new Date(now));
  if (!Number.isSafeInteger(now) || now <= 0 || current.validUntil <= now
    || current.keyVersion !== key.version || current.existingAcquisitionId !== null
    || command.sourceSha256 !== current.sourceSha256 || command.submissionCommandId !== current.submissionCommandId
    || command.reviewCommandId !== current.reviewCommandId || command.reviewSha256 !== current.reviewSha256
    || (command.expiresAt !== null && Date.parse(command.expiresAt) <= now)
    || !review || review.command.verdict !== 'APPROVE_PRIVATE'
    || review.command.commandId !== current.reviewCommandId
    || review.command.submissionCommandId !== current.submissionCommandId
    || review.command.sourceSha256 !== current.sourceSha256
    || review.receipt.actorId !== current.actorId
    || canonicalSha256(review) !== current.reviewSha256
    || canonicalJson(review.receipt.reference) !== canonicalJson(current.reference))
    throw new Error('TECHNICAL_DOCUMENT_ACQUISITION_STALE');
  if (current.reference.kind === 'Project' && current.projectId !== current.reference.targetId)
    throw new Error('TECHNICAL_DOCUMENT_ACQUISITION_CONTEXT');
  return { command, current };
}

export function technicalDocumentAcquisitionDigest(raw: unknown, admission: TechnicalDocumentAcquisitionAdmission) {
  const command = technicalDocumentAcquisitionCommand.parse(raw);
  const current = technicalDocumentAcquisitionAdmission.parse(admission);
  return canonicalSha256({ protocol: 'TECHNICAL_DOCUMENT_ACQUISITION_REQUEST_V1',
    command, reference: current.reference, clientId: current.clientId, projectId: current.projectId,
    clientServiceId: current.clientServiceId, fileSha256: current.fileSha256, sizeBytes: current.sizeBytes });
}

/** All admission values must originate from current locked rows and verified
 * physical bytes. The signed review proves history, never current authority. */
export function createTechnicalDocumentAcquisitionPreview(key: PrivilegedStepUpKey, raw: unknown,
  current: TechnicalDocumentAcquisitionAdmission, review: unknown, now: number) {
  const checked = eligible(key, raw, current, review, now);
  const payload = previewPayload.parse({ protocol: 'TECHNICAL_DOCUMENT_ACQUISITION_PREVIEW_V1',
    ...checked, issuedAt: now, expiresAt: Math.min(now + 300_000, current.validUntil,
      checked.command.expiresAt ? Date.parse(checked.command.expiresAt) : Number.MAX_SAFE_INTEGER) });
  return Buffer.from(JSON.stringify({ payload, proof: proof(key, payload) })).toString('base64url');
}

export function readTechnicalDocumentAcquisitionPreview(key: PrivilegedStepUpKey, token: string, raw: unknown,
  current: TechnicalDocumentAcquisitionAdmission, review: unknown, now: number) {
  try {
    if (typeof token !== 'string' || token.length === 0 || token.length > 24_000) return null;
    const checked = eligible(key, raw, current, review, now);
    const saved = z.object({ payload: previewPayload, proof: hash }).strict()
      .parse(JSON.parse(Buffer.from(token, 'base64url').toString('utf8')));
    const p = saved.payload;
    if (p.issuedAt > now || p.expiresAt <= now || p.expiresAt > p.issuedAt + 300_000
      || p.expiresAt > p.current.validUntil || canonicalJson(p.command) !== canonicalJson(checked.command)
      || canonicalJson(p.current) !== canonicalJson(checked.current) || !equal(saved.proof, proof(key, p))) return null;
    return checked.command;
  } catch { return null; }
}

/** Proposed change, not a commit receipt or access grant. A future serializable
 * service must consume personal step-up, recheck bytes/time/current authority,
 * enforce uniqueness and write provenance + Document + exact version + audit
 * together. It must not invoke the ordinary upload writer with a fabricated actor. */
export function prepareTechnicalDocumentAcquisition(key: PrivilegedStepUpKey, token: string, raw: unknown,
  current: TechnicalDocumentAcquisitionAdmission, review: unknown, now: number) {
  const command = readTechnicalDocumentAcquisitionPreview(key, token, raw, current, review, now);
  if (!command) throw new Error('TECHNICAL_DOCUMENT_ACQUISITION_STALE');
  return {
    command, requestDigest: technicalDocumentAcquisitionDigest(command, current),
    reference: current.reference, actorId: current.actorId, sessionId: current.sessionId,
    provenance: { submissionCommandId: command.submissionCommandId, reviewCommandId: command.reviewCommandId,
      sourceSha256: command.sourceSha256, reviewSha256: command.reviewSha256,
      fileSha256: current.fileSha256, sizeBytes: current.sizeBytes },
    documentSelection: { clientId: current.clientId, projectId: current.projectId,
      clientServiceId: current.clientServiceId, title: command.title, classification: command.classification,
      expiresAt: command.expiresAt, visibilityLevel: technicalDocumentPrivateVisibility,
      // Classification cannot grant anyone access, including the upload author.
      financialOnly: command.classification === 'CONTRACT' || command.classification === 'PAYMENT' },
    audit: { event: 'technical_document_acquired_private', actorId: current.actorId,
      after: { protocol: 'TECHNICAL_DOCUMENT_ACQUISITION_AUDIT_V1',
        classification: command.classification, visibility: 'ADMIN_PRIVATE',
        requestDigest: technicalDocumentAcquisitionDigest(command, current) } },
  };
}
