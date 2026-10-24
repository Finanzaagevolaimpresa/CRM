import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { canonicalSha256 } from '../src/lib/canonical-json';
import { prepareTechnicalUploadReview, type TechnicalUploadReviewAdmission } from '../src/lib/technical-upload-review-contract';
import { createTechnicalDocumentAcquisitionPreview, readTechnicalDocumentAcquisitionPreview,
  prepareTechnicalDocumentAcquisition, technicalDocumentAcquisitionCommand,
  type TechnicalDocumentAcquisitionAdmission } from '../src/lib/technical-document-acquisition-contract';

const now = Date.parse('2026-10-24T15:00:00Z');
const key = { version: 1, secret: 'synthetic-acquisition-proof-only-00000000' };
const reviewCommand = { commandId: randomUUID(), submissionCommandId: randomUUID(), sourceSha256: 'a'.repeat(64),
  verdict: 'APPROVE_PRIVATE' as const, reason: 'Verifica sintetica del documento' };
const reviewAdmission: TechnicalUploadReviewAdmission = {
  reference: { kind: 'Project', targetId: 'project_a', recipientId: 'tech_a' },
  sourceSha256: reviewCommand.sourceSha256, submissionCommandId: reviewCommand.submissionCommandId,
  assignmentId: randomUUID(), assignmentRevision: 1, assignmentStateSha256: 'b'.repeat(64),
  contextSha256: 'c'.repeat(64), actorId: 'admin_a', sessionId: randomUUID(),
  authorityRevision: 1, actorEpoch: 1, recipientEpoch: 1, keyVersion: 1, validUntil: now + 600_000,
};
const review = prepareTechnicalUploadReview(key, reviewCommand, reviewAdmission, new Date(now - 1));
const current: TechnicalDocumentAcquisitionAdmission = { ...reviewAdmission,
  sessionId: randomUUID(), reviewCommandId: reviewCommand.commandId, reviewSha256: canonicalSha256(review),
  existingAcquisitionId: null, clientId: 'client_a', projectId: 'project_a', clientServiceId: null,
  fileSha256: 'd'.repeat(64), sizeBytes: 42,
};
const command = { commandId: randomUUID(), submissionCommandId: reviewCommand.submissionCommandId,
  reviewCommandId: reviewCommand.commandId, sourceSha256: reviewCommand.sourceSha256,
  reviewSha256: current.reviewSha256, classification: 'TECHNICAL_DOCUMENT' as const,
  title: 'Elaborato tecnico sintetico', expiresAt: null, visibility: 'ADMIN_PRIVATE' as const };

test('acquisition requires a separately confirmed command and creates only a private proposal', () => {
  const token = createTechnicalDocumentAcquisitionPreview(key, command, current, review, now);
  const result = prepareTechnicalDocumentAcquisition(key, token, command, current, review, now + 1);
  assert.equal(result.documentSelection.visibilityLevel, 'technical_admin_private_v1');
  assert.equal(result.documentSelection.financialOnly, false);
  assert.equal(result.sessionId, current.sessionId);
  assert.notEqual(result.sessionId, review.receipt.sessionId);
  assert(!('receipt' in result)); assert(!('grants' in result)); assert(!('recipients' in result));
  assert(!JSON.stringify(result.audit).includes(command.title));
  assert(!JSON.stringify(result.audit).includes(reviewCommand.reason));
});

test('classification/title/expiry/visibility and each source are bound to the exact preview', () => {
  const token = createTechnicalDocumentAcquisitionPreview(key, command, current, review, now);
  for (const delta of [{ title: 'Titolo modificato' }, { classification: 'CONTRACT' }, { expiresAt: new Date(now + 60_000).toISOString() },
    { visibility: 'ALL_PROJECT_MEMBERS' }, { commandId: randomUUID() }, { submissionCommandId: randomUUID() },
    { reviewCommandId: randomUUID() }, { sourceSha256: 'e'.repeat(64) }, { reviewSha256: 'e'.repeat(64) }])
    assert.equal(readTechnicalDocumentAcquisitionPreview(key, token, { ...command, ...delta }, current, review, now + 1), null);
});

test('a rejected or tampered review cannot authorize acquisition', () => {
  const rejected = prepareTechnicalUploadReview(key, { ...reviewCommand, verdict: 'REJECT_PRIVATE' }, reviewAdmission, new Date(now - 1));
  const changed = { ...review, command: { ...review.command, verdict: 'APPROVE_AND_PUBLISH' } };
  for (const candidate of [rejected, changed]) {
    const admission = { ...current, reviewSha256: canonicalSha256(candidate) };
    assert.throws(() => createTechnicalDocumentAcquisitionPreview(key, { ...command, reviewSha256: admission.reviewSha256 }, admission, candidate, now));
  }
});

test('a valid neighbouring review is not interchangeable with the selected source or personal Admin', () => {
  for (const delta of [{ sourceSha256: 'e'.repeat(64) }, { submissionCommandId: randomUUID() }]) {
    const neighbour = prepareTechnicalUploadReview(key, { ...reviewCommand, ...delta }, { ...reviewAdmission, ...delta }, new Date(now - 1));
    const admission = { ...current, reviewSha256: canonicalSha256(neighbour) };
    assert.throws(() => createTechnicalDocumentAcquisitionPreview(key, { ...command, reviewSha256: admission.reviewSha256 }, admission, neighbour, now));
  }
  const otherAdmin = prepareTechnicalUploadReview(key, reviewCommand, { ...reviewAdmission, actorId: 'admin_b' }, new Date(now - 1));
  const admission = { ...current, reviewSha256: canonicalSha256(otherAdmin) };
  assert.throws(() => createTechnicalDocumentAcquisitionPreview(key, { ...command, reviewSha256: admission.reviewSha256 }, admission, otherAdmin, now));
});

test('current session, authority, assignment, context and physical bytes invalidate old previews', () => {
  const token = createTechnicalDocumentAcquisitionPreview(key, command, current, review, now);
  for (const delta of [{ actorId: 'admin_b' }, { sessionId: randomUUID() }, { actorEpoch: 2 }, { recipientEpoch: 2 },
    { authorityRevision: 2 }, { assignmentRevision: 2 }, { assignmentStateSha256: 'e'.repeat(64) },
    { contextSha256: 'e'.repeat(64) }, { clientId: 'client_b' }, { projectId: 'project_b' },
    { clientServiceId: 'service_b' }, { sizeBytes: 43 }, { fileSha256: 'e'.repeat(64) },
    { reference: { ...current.reference, recipientId: 'tech_b' } }, { validUntil: now + 1 }])
    assert.equal(readTechnicalDocumentAcquisitionPreview(key, token, command, { ...current, ...delta }, review, now + 2), null);
});

test('already acquired sources reject a second acquisition and demand receipt reconciliation', () => {
  const token = createTechnicalDocumentAcquisitionPreview(key, command, current, review, now);
  const acquired = { ...current, existingAcquisitionId: randomUUID() };
  assert.throws(() => createTechnicalDocumentAcquisitionPreview(key, { ...command, commandId: randomUUID() }, acquired, review, now + 1));
  assert.throws(() => prepareTechnicalDocumentAcquisition(key, token, command, acquired, review, now + 1));
});

test('contract/payment classification preserves a financial ceiling without publishing or granting', () => {
  for (const classification of ['CONTRACT', 'PAYMENT'] as const) {
    const financial = { ...command, classification };
    const token = createTechnicalDocumentAcquisitionPreview(key, financial, current, review, now);
    const result = prepareTechnicalDocumentAcquisition(key, token, financial, current, review, now + 1);
    assert.equal(result.documentSelection.financialOnly, true);
    assert.equal(result.documentSelection.visibilityLevel, 'technical_admin_private_v1');
  }
  for (const extra of [{ recipients: ['tech_a'] }, { publish: true }, { send: true }, { download: true }])
    assert.equal(technicalDocumentAcquisitionCommand.safeParse({ ...command, ...extra }).success, false);
});

test('expiry, future time, malformed token and a different signing purpose fail closed', () => {
  const expiring = { ...command, expiresAt: new Date(now + 30_000).toISOString() };
  const token = createTechnicalDocumentAcquisitionPreview(key, expiring, current, review, now);
  assert.equal(readTechnicalDocumentAcquisitionPreview(key, token, expiring, current, review, now + 30_000), null);
  assert.equal(readTechnicalDocumentAcquisitionPreview(key, token, expiring, current, review, now - 1), null);
  assert.equal(readTechnicalDocumentAcquisitionPreview({ ...key, version: 2 }, token, expiring, current, review, now + 1), null);
  for (const invalid of ['', 'bad token', 'a'.repeat(24_001), Buffer.from(JSON.stringify(review)).toString('base64url')])
    assert.equal(readTechnicalDocumentAcquisitionPreview(key, invalid, expiring, current, review, now + 1), null);
  assert.throws(() => createTechnicalDocumentAcquisitionPreview(key, { ...command, expiresAt: new Date(now).toISOString() }, current, review, now));
});
