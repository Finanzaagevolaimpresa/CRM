import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { canonicalSha256 } from '../src/lib/canonical-json';
import { previewTechnicalUploadDeposit, confirmTechnicalUploadDeposit } from '../src/lib/technical-upload-plan';
import { prepareTechnicalUploadRecord } from '../src/lib/technical-upload-record';
import type { TechnicalUploadAdmission } from '../src/lib/technical-upload-contract';
import { prepareTechnicalUploadReview, type TechnicalUploadReviewAdmission } from '../src/lib/technical-upload-review-contract';
import { createTechnicalDocumentAcquisitionPreview, type TechnicalDocumentAcquisitionAdmission,
  type technicalDocumentAcquisitionCommand } from '../src/lib/technical-document-acquisition-contract';
import { prepareTechnicalDocumentAcquisitionRecord } from '../src/lib/technical-document-acquisition-journal';
import { technicalDocumentCanonicalProjection } from '../src/lib/technical-document-acquisition-projection';
import { ordinaryDocumentVisibilityAllows } from '../src/lib/technical-document-visibility';
import { isFinancialDocument } from '../src/lib/financial-privacy-policy';
import type { z } from 'zod';

const key = { version: 1, secret: 'synthetic-private-acquisition-projection-key-0001' };
const now = Date.parse('2026-10-24T15:00:00Z'), bytes = Buffer.from('Documento tecnico sintetico.');
type Classification = z.infer<typeof technicalDocumentAcquisitionCommand>['classification'];
function fixture(classification: Classification = 'TECHNICAL_DOCUMENT') {
  const uploadAdmission: TechnicalUploadAdmission = {
    target: { kind: 'TechnicalPractice', targetId: 'practice_a' }, actorId: 'tech_a', sessionId: randomUUID(),
    assignmentId: randomUUID(), assignmentRevision: 1, assignmentStateSha256: 'b'.repeat(64),
    authorityRevision: 1, actorEpoch: 3, authorEpoch: 2, keyVersion: 1, contextSha256: 'c'.repeat(64), scopeGeneration: 1,
    profile: { purpose: 'Esamina la relazione', formats: ['.txt'], maxFileBytes: 1024,
      maxFilesPerRevision: 3, maxBytesPerRevision: 2048, visibility: 'PRIVATE_PENDING_ADMIN_REVIEW' },
    consumedFiles: 0, consumedBytes: 0, validUntil: now + 60_000,
  };
  const input = { commandId: randomUUID(), assignmentId: uploadAdmission.assignmentId, assignmentRevision: 1,
    expectedContextSha256: uploadAdmission.contextSha256, title: 'Relazione depositata', action: 'deposit_private_document' };
  const preview = previewTechnicalUploadDeposit(key, input, 'Relazione.txt', bytes, uploadAdmission, now);
  const plan = confirmTechnicalUploadDeposit(key, preview.command, preview.token, bytes, true, uploadAdmission, now)!;
  const source = prepareTechnicalUploadRecord(key, plan, uploadAdmission,
    { storageKey: plan.privateFile.storageKey, sha256: plan.privateFile.sha256, sizeBytes: bytes.length }, randomUUID(), new Date(now)).record;
  const prior: TechnicalUploadReviewAdmission = {
    reference: { kind: 'TechnicalPractice', targetId: 'practice_a', recipientId: 'tech_a' },
    sourceSha256: canonicalSha256(source), submissionCommandId: source.commandId,
    assignmentId: source.assignmentId, assignmentRevision: 1, assignmentStateSha256: 'b'.repeat(64),
    contextSha256: 'c'.repeat(64), actorId: 'personal_admin', sessionId: randomUUID(),
    authorityRevision: 1, actorEpoch: 2, recipientEpoch: 3, keyVersion: 1, validUntil: now + 60_000,
  };
  const review = prepareTechnicalUploadReview(key, { commandId: randomUUID(), submissionCommandId: source.commandId,
    sourceSha256: canonicalSha256(source), verdict: 'APPROVE_PRIVATE', reason: 'Motivo riservato sintetico' }, prior, new Date(now + 1));
  const admission: TechnicalDocumentAcquisitionAdmission = { ...prior, sessionId: randomUUID(),
    reviewCommandId: review.command.commandId, reviewSha256: canonicalSha256(review), existingAcquisitionId: null,
    clientId: 'client_a', projectId: 'project_a', clientServiceId: 'service_a',
    fileSha256: source.contentSha256, sizeBytes: bytes.length };
  const command = { commandId: randomUUID(), submissionCommandId: source.commandId,
    reviewCommandId: review.command.commandId, sourceSha256: canonicalSha256(source), reviewSha256: canonicalSha256(review),
    classification, title: 'Documento acquisito', expiresAt: new Date(now + 30_000).toISOString(), visibility: 'ADMIN_PRIVATE' as const };
  const token = createTechnicalDocumentAcquisitionPreview(key, command, admission, review, now + 2);
  const record = prepareTechnicalDocumentAcquisitionRecord(key, token, command, admission, review,
    { documentId: randomUUID(), versionId: randomUUID() }, new Date(now + 3));
  return { source, record, review };
}

test('canonical rows retain exact private bytes, explicit classification and one selected version', () => {
  for (const classification of ['TECHNICAL_DOCUMENT', 'CONTRACT', 'PAYMENT', 'OTHER_CONFIDENTIAL'] as const) {
    const f = fixture(classification), rows = technicalDocumentCanonicalProjection(key, f.record, f.source, bytes, new Date(now + 4));
    assert.equal(rows.document.id, f.record.receipt.documentId);
    assert.equal(rows.version.id, f.record.receipt.versionId);
    assert.equal(rows.version.documentId, rows.document.id); assert.equal(rows.version.version, 1);
    assert.equal(rows.document.storagePath, f.source.storageKey); assert.equal(rows.version.storagePath, f.source.storageKey);
    assert.equal(rows.document.checksum, f.source.contentSha256);
    assert.equal(rows.document.mimeType, 'text/plain; charset=utf-8');
    assert.equal(rows.document.clientId, 'client_a'); assert.equal(rows.document.clientServiceId, 'service_a');
    assert.equal(rows.document.uploadedById, 'personal_admin'); assert.equal(rows.document.status, 'caricato');
    assert.equal(rows.document.validUntil!.toISOString(), f.record.command.expiresAt);
    assert.equal(ordinaryDocumentVisibilityAllows(rows.document.visibilityLevel), false);
    assert.equal(isFinancialDocument(rows.document), ['CONTRACT', 'PAYMENT'].includes(classification));
    assert.equal(rows.audit.id, f.record.command.commandId);
    for (const privateText of [f.record.command.title, f.source.command.file.fileName, bytes.toString(), f.review.command.reason, f.source.storageKey])
      assert(!JSON.stringify(rows.audit).includes(privateText));
    for (const unsupported of ['grants', 'participants', 'notification', 'email', 'publish', 'storageWrite'])
      assert(!(unsupported in rows));
  }
});

test('a different source, assignment, recipient, context, filename or storage key cannot become canonical', () => {
  const f = fixture();
  for (const delta of [
    { commandId: randomUUID() }, { assignmentId: randomUUID() }, { assignmentRevision: 2 }, { actorId: 'tech_b' },
    { target: { kind: 'TechnicalPractice', targetId: 'practice_b' } }, { storageKey: 'technical-submissions/v1/' + 'e'.repeat(64) + '/' + 'f'.repeat(64) },
    { command: { ...f.source.command, file: { ...f.source.command.file, fileName: 'Other.txt' } } },
  ]) assert.throws(() => technicalDocumentCanonicalProjection(key, f.record, { ...f.source, ...delta }, bytes, new Date(now + 4)));
});

test('physical bytes and receipt signature are verified before deriving the canonical rows', () => {
  const f = fixture(), replaced = Buffer.from(bytes); replaced[0] ^= 1;
  for (const content of [Buffer.alloc(0), replaced, Buffer.concat([bytes, Buffer.from('extra')])])
    assert.throws(() => technicalDocumentCanonicalProjection(key, f.record, f.source, content, new Date(now + 4)));
  assert.throws(() => technicalDocumentCanonicalProjection(key, { ...f.record, proof: '0'.repeat(64) }, f.source, bytes, new Date(now + 4)));
  assert.throws(() => technicalDocumentCanonicalProjection({ ...key, version: 2 }, f.record, f.source, bytes, new Date(now + 4)));
});

test('historical projection after expiry preserves evidence but never turns private visibility into access', () => {
  const f = fixture();
  const before = technicalDocumentCanonicalProjection(key, f.record, f.source, bytes, new Date(now + 4));
  const after = technicalDocumentCanonicalProjection(key, f.record, f.source, bytes, new Date(now + 600_000));
  assert.deepEqual(after, before);
  assert.equal(ordinaryDocumentVisibilityAllows(after.document.visibilityLevel), false);
  assert.equal(after.document.visibilityLevel, 'technical_admin_private_v1');
  assert.equal(after.document.containsSensitiveData, true);
});
