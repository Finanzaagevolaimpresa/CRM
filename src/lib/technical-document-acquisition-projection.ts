import { createHash } from 'node:crypto';
import { canonicalSha256 } from './canonical-json';
import { documentPreviewMime } from './document-preview';
import type { PrivilegedStepUpKey } from './privileged-step-up-token';
import { technicalUploadRecord } from './technical-upload-record';
import { readTechnicalDocumentAcquisitionRecord } from './technical-document-acquisition-journal';
import { technicalDocumentPrivateVisibility } from './technical-document-visibility';

const categories = {
  TECHNICAL_DOCUMENT: 'documento_tecnico', CONTRACT: 'contratto',
  PAYMENT: 'pagamento', OTHER_CONFIDENTIAL: 'riservato',
} as const;

/** Exact canonical rows derived from signed acquisition provenance and the
 * original private bytes. This is not a writer, a receipt or read authorization.
 * A future transaction must recheck current admission and commit provenance,
 * these rows and the audit together; ordinary access remains denied. */
export function technicalDocumentCanonicalRows(key: PrivilegedStepUpKey, rawRecord: unknown,
  rawSubmission: unknown, now: Date) {
  const saved = readTechnicalDocumentAcquisitionRecord(key, rawRecord, now);
  const source = technicalUploadRecord.parse(rawSubmission);
  if (!saved) throw new Error('TECHNICAL_DOCUMENT_ACQUISITION_PROVENANCE');
  const { command: c, admission: a, receipt: r } = saved, file = source.command.file;
  if (canonicalSha256(source) !== a.sourceSha256 || source.commandId !== c.submissionCommandId
    || source.assignmentId !== a.assignmentId || source.assignmentRevision !== a.assignmentRevision
    || source.actorId !== a.reference.recipientId || source.target.kind !== a.reference.kind
    || source.target.targetId !== a.reference.targetId || source.contentSha256 !== a.fileSha256
    || source.sizeBytes !== a.sizeBytes || file.contentSha256 !== a.fileSha256 || file.sizeBytes !== a.sizeBytes
    || Date.parse(source.createdAt) > Date.parse(r.recordedAt)) {
    throw new Error('TECHNICAL_DOCUMENT_ACQUISITION_SOURCE');
  }
  const createdAt = new Date(r.recordedAt), category = categories[c.classification];
  return {
    document: {
      id: r.documentId, selectiveEpoch: 1, clientId: a.clientId, companyId: null,
      projectId: a.projectId, clientServiceId: a.clientServiceId,
      serviceArea: 'altro' as const, documentCategory: category, type: category,
      title: c.title, fileName: file.fileName, mimeType: file.previewMime?.split(';')[0] ?? 'application/octet-stream',
      sizeBytes: a.sizeBytes, storagePath: source.storageKey, checksum: a.fileSha256,
      uploadedById: r.actorId, status: 'caricato' as const,
      visibilityLevel: technicalDocumentPrivateVisibility, containsSensitiveData: c.classification !== 'TECHNICAL_DOCUMENT',
      createdAt, updatedAt: createdAt, validUntil: c.expiresAt ? new Date(c.expiresAt) : null, deletedAt: null,
    },
    version: { id: r.versionId, documentId: r.documentId, version: 1,
      storagePath: source.storageKey, checksum: a.fileSha256, createdAt },
    audit: { id: r.commandId, actorId: r.actorId, event: 'technical_document_acquired_private',
      entityType: 'Document', entityId: r.documentId, before: {},
      after: { action: 'acquire_private_document', type: c.classification,
        visibilityMode: 'ADMIN_PRIVATE', requestHash: r.requestDigest }, createdAt },
  };
}

export function technicalDocumentCanonicalProjection(key: PrivilegedStepUpKey, rawRecord: unknown,
  rawSubmission: unknown, bytes: Uint8Array, now: Date) {
  const rows = technicalDocumentCanonicalRows(key, rawRecord, rawSubmission, now);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== rows.document.sizeBytes
    || createHash('sha256').update(bytes).digest('hex') !== rows.document.checksum
    || (documentPreviewMime(rows.document.fileName, bytes)?.split(';')[0] ?? 'application/octet-stream') !== rows.document.mimeType)
    throw new Error('TECHNICAL_DOCUMENT_ACQUISITION_SOURCE');
  return rows;
}
