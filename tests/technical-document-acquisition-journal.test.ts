import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { canonicalSha256 } from '../src/lib/canonical-json';
import { prepareTechnicalUploadReview, type TechnicalUploadReviewAdmission } from '../src/lib/technical-upload-review-contract';
import { createTechnicalDocumentAcquisitionPreview, type TechnicalDocumentAcquisitionAdmission } from '../src/lib/technical-document-acquisition-contract';
import { prepareTechnicalDocumentAcquisitionRecord, readTechnicalDocumentAcquisitionRecord } from '../src/lib/technical-document-acquisition-journal';

const key = { version: 1, secret: 'synthetic-acquisition-journal-key-000000000' };
const now = Date.parse('2026-10-24T15:00:00Z');
function fixture() {
  const reviewCommand = { commandId: randomUUID(), submissionCommandId: randomUUID(), sourceSha256: 'a'.repeat(64),
    verdict: 'APPROVE_PRIVATE' as const, reason: 'Motivo riservato sintetico' };
  const prior: TechnicalUploadReviewAdmission = {
    reference: { kind: 'Project', targetId: 'project_a', recipientId: 'tech_a' },
    sourceSha256: reviewCommand.sourceSha256, submissionCommandId: reviewCommand.submissionCommandId,
    assignmentId: randomUUID(), assignmentRevision: 1, assignmentStateSha256: 'b'.repeat(64),
    contextSha256: 'c'.repeat(64), actorId: 'personal_admin', sessionId: randomUUID(),
    authorityRevision: 1, actorEpoch: 1, recipientEpoch: 1, keyVersion: 1, validUntil: now + 60_000,
  };
  const review = prepareTechnicalUploadReview(key, reviewCommand, prior, new Date(now - 1));
  const admission: TechnicalDocumentAcquisitionAdmission = { ...prior,
    sessionId: randomUUID(), reviewCommandId: reviewCommand.commandId, reviewSha256: canonicalSha256(review),
    existingAcquisitionId: null, clientId: 'client_a', projectId: 'project_a', clientServiceId: null,
    fileSha256: 'd'.repeat(64), sizeBytes: 42 };
  const command = { commandId: randomUUID(), submissionCommandId: reviewCommand.submissionCommandId,
    reviewCommandId: reviewCommand.commandId, sourceSha256: reviewCommand.sourceSha256,
    reviewSha256: admission.reviewSha256, classification: 'TECHNICAL_DOCUMENT' as const,
    title: 'Titolo privato sintetico', expiresAt: new Date(now + 30_000).toISOString(), visibility: 'ADMIN_PRIVATE' as const };
  const token = createTechnicalDocumentAcquisitionPreview(key, command, admission, review, now);
  const ids = { documentId: randomUUID(), versionId: randomUUID() };
  const record = prepareTechnicalDocumentAcquisitionRecord(key, token, command, admission, review, ids, new Date(now + 1));
  return { command, admission, review, token, ids, record };
}

test('private acquisition history binds the exact source, personal session and canonical version without an access grant', () => {
  const f = fixture();
  assert.deepEqual(readTechnicalDocumentAcquisitionRecord(key, f.record, new Date(now + 2)), f.record);
  assert.equal(f.record.receipt.documentId, f.ids.documentId);
  assert.equal(f.record.receipt.versionId, f.ids.versionId);
  assert.equal(f.record.receipt.sessionId, f.admission.sessionId);
  assert.notEqual(f.record.receipt.sessionId, f.review.receipt.sessionId);
  assert(!JSON.stringify(f.record.receipt).includes(f.command.title));
  assert(!JSON.stringify(f.record).includes(f.review.command.reason));
  assert(!('grants' in f.record)); assert(!('accessAllowed' in f.record));
});

test('source, classification, title, bytes, recipients and version tampering invalidate retained provenance', () => {
  const { record } = fixture();
  const altered = [
    { ...record, command: { ...record.command, title: 'Titolo sostituito' } },
    { ...record, command: { ...record.command, classification: 'CONTRACT' } },
    { ...record, command: { ...record.command, recipients: ['unselected'] } },
    { ...record, admission: { ...record.admission, fileSha256: 'e'.repeat(64) } },
    { ...record, admission: { ...record.admission, contextSha256: 'e'.repeat(64) } },
    { ...record, receipt: { ...record.receipt, documentId: randomUUID() } },
    { ...record, receipt: { ...record.receipt, versionId: randomUUID() } },
    { ...record, receipt: { ...record.receipt, version: 2 } },
    { ...record, receipt: { ...record.receipt, visibilityLevel: 'interno' } },
    { ...record, receipt: { ...record.receipt, actorId: 'other_admin' } },
    { ...record, receipt: { ...record.receipt, sessionId: randomUUID() } },
    { ...record, proof: '0'.repeat(64) },
  ];
  for (const value of altered) assert.equal(readTechnicalDocumentAcquisitionRecord(key, value, new Date(now + 2)), null);
});

test('retained evidence survives expiry but cannot be reused to prepare a new acquisition', () => {
  const f = fixture(), later = new Date(now + 600_000);
  assert.deepEqual(readTechnicalDocumentAcquisitionRecord(key, f.record, later), f.record);
  assert.throws(() => prepareTechnicalDocumentAcquisitionRecord(key, f.token, f.command, f.admission, f.review, f.ids, later));
  assert.throws(() => prepareTechnicalDocumentAcquisitionRecord(key, f.token, f.command,
    { ...f.admission, existingAcquisitionId: f.record.command.commandId }, f.review, f.ids, new Date(now + 2)));
});

test('other protocol, signing key, generation, future timestamp and invalid identities are rejected', () => {
  const f = fixture();
  assert.equal(readTechnicalDocumentAcquisitionRecord(key, f.review, new Date(now + 2)), null);
  assert.equal(readTechnicalDocumentAcquisitionRecord({ ...key, secret: 'different-synthetic-signing-key-000000' }, f.record, new Date(now + 2)), null);
  assert.equal(readTechnicalDocumentAcquisitionRecord({ ...key, version: 2 }, f.record, new Date(now + 2)), null);
  assert.equal(readTechnicalDocumentAcquisitionRecord(key, f.record, new Date(now)), null);
  for (const ids of [{ ...f.ids, documentId: f.ids.versionId }, { ...f.ids, versionId: '../invalid' }, { ...f.ids, publish: true }])
    assert.throws(() => prepareTechnicalDocumentAcquisitionRecord(key, f.token, f.command, f.admission, f.review, ids, new Date(now + 2)));
});
