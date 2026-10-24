import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from './canonical-json';
import { documentUploadMaxBytes } from './document-upload-contract';
import { isFinancialDocument } from './financial-privacy-policy';
import type { PrivilegedStepUpKey } from './privileged-step-up-token';
import { readRetainedTechnicalAssignmentJournal } from './technical-assignment-journal';
import { technicalTargetReference } from './technical-assignment-display';
import { describeTechnicalUpload, technicalUploadAdmission, technicalUploadCommand, technicalUploadReceipt,
  readTechnicalUploadReceipt, signTechnicalUploadReceipt, technicalUploadRequestDigest,
  type TechnicalUploadAdmission } from './technical-upload-contract';
import { technicalUploadStorageKey, type TechnicalUploadWriteIntent } from './technical-upload-plan';

const uuid = z.string().uuid();
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.number().int().positive().max(2_147_483_647);
/** Immutable proposal, deliberately outside Document/DocumentVersion. A valid
 * historical record never grants permission to read its metadata or bytes. */
export const technicalUploadRecord = z.object({
  id: uuid, commandId: uuid, assignmentId: uuid, assignmentRevision: revision,
  actorId: id, sessionId: uuid, target: technicalTargetReference,
  requestDigest: hash, command: technicalUploadCommand,
  storageKey: z.string().regex(/^technical-submissions\/v1\/[a-f0-9]{64}\/[a-f0-9]{64}$/),
  contentSha256: hash, sizeBytes: z.number().int().min(1).max(documentUploadMaxBytes),
  receipt: technicalUploadReceipt, proof: hash, createdAt: z.string().datetime(),
}).strict();
export type TechnicalUploadRecord = z.infer<typeof technicalUploadRecord>;
const auditSchema = z.object({ id: uuid, actorId: id, event: z.literal('technical_upload_deposited'),
  entityType: z.literal('TechnicalUploadSubmission'), entityId: uuid,
  before: z.object({}).strict(),
  after: z.object({ action: z.literal('deposit_private_document'), fileCount: z.literal(1) }).strict(),
}).strict();
type StoredFile = Pick<TechnicalUploadWriteIntent['privateFile'], 'storageKey' | 'sha256' | 'sizeBytes'>;

/** Proposed DB row and minimized audit after an exact private write. The caller
 * must still persist both atomically and await COMMIT before returning success.
 * No existing routes or database services invoke this preparation yet. */
export function prepareTechnicalUploadRecord(key: PrivilegedStepUpKey, intent: TechnicalUploadWriteIntent,
  rawCurrent: TechnicalUploadAdmission, stored: StoredFile, submissionId: string, now: Date) {
  const current = technicalUploadAdmission.parse(rawCurrent), command = technicalUploadCommand.parse(intent.command);
  const expectedKey = technicalUploadStorageKey(current, command.commandId);
  const digest = technicalUploadRequestDigest(current.target, command);
  const quota = { assignmentId: current.assignmentId, revision: current.assignmentRevision,
    filesBefore: current.consumedFiles, bytesBefore: current.consumedBytes,
    filesAfter: current.consumedFiles + 1, bytesAfter: current.consumedBytes + command.file.sizeBytes };
  if (!Number.isFinite(now.getTime()) || current.validUntil <= now.getTime() || key.version !== current.keyVersion
    || command.assignmentId !== current.assignmentId || command.assignmentRevision !== current.assignmentRevision
    || isFinancialDocument({ title: command.title, fileName: command.file.fileName })
    || command.expectedContextSha256 !== current.contextSha256 || intent.requestDigest !== digest
    || !current.profile.formats.includes(command.file.extension) || command.file.sizeBytes > current.profile.maxFileBytes
    || quota.filesAfter > current.profile.maxFilesPerRevision || quota.bytesAfter > current.profile.maxBytesPerRevision
    || canonicalJson(intent.quota) !== canonicalJson(quota)
    || canonicalJson(intent.privateFile.storageBudget) !== canonicalJson({ maxFileBytes: current.profile.maxFileBytes,
      maxFilesPerRevision: current.profile.maxFilesPerRevision, maxBytesPerRevision: current.profile.maxBytesPerRevision })
    || stored.storageKey !== expectedKey || intent.privateFile.storageKey !== expectedKey
    || stored.sizeBytes !== command.file.sizeBytes || intent.privateFile.sizeBytes !== command.file.sizeBytes
    || stored.sha256 !== command.file.contentSha256 || intent.privateFile.sha256 !== command.file.contentSha256
    || !(intent.privateFile.bytes instanceof Uint8Array) || intent.privateFile.bytes.length !== command.file.sizeBytes
    || createHash('sha256').update(intent.privateFile.bytes).digest('hex') !== command.file.contentSha256) {
    throw new Error('TECHNICAL_UPLOAD_RECORD_CONFLICT');
  }
  if (canonicalJson(describeTechnicalUpload(command.file.fileName, intent.privateFile.bytes, current.profile))
    !== canonicalJson(command.file)) throw new Error('TECHNICAL_UPLOAD_RECORD_CONFLICT');
  const receipt = technicalUploadReceipt.parse({ protocol: 'TECHNICAL_UPLOAD_RECEIPT_V1',
    commandId: command.commandId, submissionId, actorId: current.actorId, sessionId: current.sessionId,
    target: current.target, assignmentId: current.assignmentId, assignmentRevision: current.assignmentRevision,
    requestDigest: digest, contentSha256: command.file.contentSha256, sizeBytes: command.file.sizeBytes,
    status: 'PRIVATE_STORED', recordedAt: now.toISOString(), keyVersion: key.version });
  const record = technicalUploadRecord.parse({ id: submissionId, commandId: command.commandId,
    assignmentId: current.assignmentId, assignmentRevision: current.assignmentRevision,
    actorId: current.actorId, sessionId: current.sessionId, target: current.target,
    requestDigest: digest, command, storageKey: expectedKey, contentSha256: stored.sha256,
    sizeBytes: stored.sizeBytes, receipt, proof: signTechnicalUploadReceipt(key, receipt), createdAt: now.toISOString() });
  const audit = auditSchema.parse({ id: command.commandId, actorId: current.actorId,
    event: 'technical_upload_deposited', entityType: 'TechnicalUploadSubmission', entityId: submissionId,
    before: {}, after: { action: 'deposit_private_document', fileCount: 1 } });
  return { record, audit };
}

/** Exact historical provenance. Admission is a separate current check; never
 * expose this whole result from an outcome endpoint. The outcome is only the
 * minimized receipt, bound again to its original actor/session/request. */
export function readTechnicalUploadRecord(key: PrivilegedStepUpKey, raw: unknown,
  retainedAssignment: unknown, now: Date) {
  try {
    const journal = z.object({ record: technicalUploadRecord, audit: auditSchema }).strict().parse(raw);
    const r = journal.record, command = r.command;
    const retained = readRetainedTechnicalAssignmentJournal(retainedAssignment, key, now);
    const assignment = retained?.assignment.payload, profile = assignment?.selection.uploadProfile;
    const receipt = readTechnicalUploadReceipt(key, r.receipt, r.proof, { commandId: r.commandId,
      actorId: r.actorId, sessionId: r.sessionId, target: r.target, requestDigest: r.requestDigest }, now.getTime());
    if (!retained || retained.decision.operation !== 'ASSIGN' || retained.assignment.revokedAt !== null
      || !assignment || !profile || !receipt || assignment.id !== r.assignmentId
      || assignment.revision !== r.assignmentRevision || assignment.selection.userId !== r.actorId
      || assignment.selection.kind !== r.target.kind || assignment.targetId !== r.target.targetId
      || !assignment.selection.actions.includes('upload_document')
      || Date.parse(assignment.approvedAt) > Date.parse(r.createdAt)
      || Date.parse(assignment.selection.expiresAt) <= Date.parse(r.createdAt)
      || assignment.keyVersion !== receipt.keyVersion || assignment.contextSha256 !== command.expectedContextSha256
      || !profile.formats.includes(command.file.extension) || command.file.sizeBytes > profile.maxFileBytes
      || command.file.sizeBytes > profile.maxBytesPerRevision
      || r.commandId !== command.commandId || r.assignmentId !== command.assignmentId
      || r.assignmentRevision !== command.assignmentRevision || receipt.submissionId !== r.id
      || receipt.assignmentId !== r.assignmentId || receipt.assignmentRevision !== r.assignmentRevision
      || receipt.contentSha256 !== r.contentSha256 || receipt.sizeBytes !== r.sizeBytes
      || receipt.recordedAt !== r.createdAt || command.file.contentSha256 !== r.contentSha256
      || command.file.sizeBytes !== r.sizeBytes || technicalUploadRequestDigest(r.target, command) !== r.requestDigest
      || technicalUploadStorageKey(r, r.commandId) !== r.storageKey
      || journal.audit.id !== r.commandId || journal.audit.entityId !== r.id || journal.audit.actorId !== r.actorId) return null;
    return journal;
  } catch { return null; }
}
