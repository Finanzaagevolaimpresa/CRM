import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson, canonicalSha256 } from './canonical-json';
import type { PrivilegedStepUpKey } from './privileged-step-up-token';
import { technicalAssignmentReference } from './technical-assignment-decision';
import { prepareTechnicalDocumentAcquisition, technicalDocumentAcquisitionAdmission,
  technicalDocumentAcquisitionCommand, technicalDocumentAcquisitionDigest,
  type TechnicalDocumentAcquisitionAdmission } from './technical-document-acquisition-contract';
import { technicalDocumentPrivateVisibility } from './technical-document-visibility';

const hash = z.string().regex(/^[a-f0-9]{64}$/), uuid = z.string().uuid();
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const generation = z.number().int().positive().max(2_147_483_647);
const identities = z.object({ documentId: id, versionId: id }).strict();

export const technicalDocumentAcquisitionReceipt = z.object({
  protocol: z.literal('TECHNICAL_DOCUMENT_ACQUISITION_RECEIPT_V1'),
  commandId: uuid, submissionCommandId: uuid, reviewCommandId: uuid,
  actorId: id, sessionId: uuid, reference: technicalAssignmentReference,
  documentId: id, versionId: id, version: z.literal(1),
  fileSha256: hash, sizeBytes: z.number().int().positive().max(25 * 1024 * 1024),
  classification: technicalDocumentAcquisitionCommand.shape.classification,
  visibilityLevel: z.literal(technicalDocumentPrivateVisibility),
  requestDigest: hash, admissionSha256: hash, recordedAt: z.string().datetime(), keyVersion: generation,
}).strict();
export const technicalDocumentAcquisitionRecord = z.object({
  command: technicalDocumentAcquisitionCommand, admission: technicalDocumentAcquisitionAdmission,
  receipt: technicalDocumentAcquisitionReceipt, proof: hash,
}).strict();
export type TechnicalDocumentAcquisitionRecord = z.infer<typeof technicalDocumentAcquisitionRecord>;

function sign(key: PrivilegedStepUpKey, receipt: unknown) {
  if (key.secret.length < 32 || !generation.safeParse(key.version).success)
    throw new Error('TECHNICAL_DOCUMENT_ACQUISITION_KEY');
  return createHmac('sha256', key.secret).update(`FAI_TECHNICAL_DOCUMENT_ACQUISITION_RECEIPT_V1:${key.version}:`)
    .update(canonicalJson(receipt)).digest('hex');
}
function equal(left: string, right: string) {
  return hash.safeParse(left).success && hash.safeParse(right).success
    && timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

/** This prepares a record, not a persisted outcome. Only a future locked service
 * may publish the receipt after provenance, exact document/version and audit
 * have committed atomically. No route or database writer calls this yet. */
export function prepareTechnicalDocumentAcquisitionRecord(key: PrivilegedStepUpKey, token: string, raw: unknown,
  current: TechnicalDocumentAcquisitionAdmission, review: unknown, rawIds: unknown, now: Date) {
  const proposal = prepareTechnicalDocumentAcquisition(key, token, raw, current, review, now.getTime());
  const admission = technicalDocumentAcquisitionAdmission.parse(current), ids = identities.parse(rawIds);
  if (ids.documentId === ids.versionId) throw new Error('TECHNICAL_DOCUMENT_ACQUISITION_IDENTITIES');
  const receipt = technicalDocumentAcquisitionReceipt.parse({
    protocol: 'TECHNICAL_DOCUMENT_ACQUISITION_RECEIPT_V1',
    commandId: proposal.command.commandId, submissionCommandId: proposal.command.submissionCommandId,
    reviewCommandId: proposal.command.reviewCommandId, actorId: admission.actorId, sessionId: admission.sessionId,
    reference: admission.reference, ...ids, version: 1,
    fileSha256: admission.fileSha256, sizeBytes: admission.sizeBytes,
    classification: proposal.command.classification, visibilityLevel: technicalDocumentPrivateVisibility,
    requestDigest: proposal.requestDigest, admissionSha256: canonicalSha256(admission),
    recordedAt: now.toISOString(), keyVersion: key.version,
  });
  return technicalDocumentAcquisitionRecord.parse({ command: proposal.command, admission, receipt, proof: sign(key, receipt) });
}

/** Historical integrity only. This never supplies read/download/management
 * authorization: callers must rebuild current personal or selected admission.
 * The future loader must also match the immutable DB document/version/audit. */
export function readTechnicalDocumentAcquisitionRecord(key: PrivilegedStepUpKey, raw: unknown, now: Date) {
  try {
    const record = technicalDocumentAcquisitionRecord.parse(raw), { command: c, admission: a, receipt: r } = record;
    const recordedAt = Date.parse(r.recordedAt);
    if (!Number.isFinite(now.getTime()) || recordedAt > now.getTime() || recordedAt >= a.validUntil
      || a.existingAcquisitionId !== null || a.keyVersion !== key.version || r.keyVersion !== key.version
      || r.commandId !== c.commandId || r.submissionCommandId !== c.submissionCommandId
      || r.reviewCommandId !== c.reviewCommandId || a.submissionCommandId !== c.submissionCommandId
      || a.reviewCommandId !== c.reviewCommandId || a.sourceSha256 !== c.sourceSha256 || a.reviewSha256 !== c.reviewSha256
      || r.actorId !== a.actorId || r.sessionId !== a.sessionId || r.documentId === r.versionId
      || canonicalJson(r.reference) !== canonicalJson(a.reference)
      || r.classification !== c.classification || r.fileSha256 !== a.fileSha256 || r.sizeBytes !== a.sizeBytes
      || r.requestDigest !== technicalDocumentAcquisitionDigest(c, a) || r.admissionSha256 !== canonicalSha256(a)
      || (c.expiresAt !== null && recordedAt >= Date.parse(c.expiresAt))
      || !equal(record.proof, sign(key, r))) return null;
    return record;
  } catch { return null; }
}
