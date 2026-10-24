import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createTechnicalUploadReviewPreview, readTechnicalUploadReviewPreview, prepareTechnicalUploadReview, readTechnicalUploadReviewRecord,
  technicalUploadReviewCommand, type TechnicalUploadReviewAdmission } from '../src/lib/technical-upload-review-contract';
import { technicalUploadFileResponse } from '../src/lib/technical-upload-response';

const now = Date.parse('2026-10-24T12:00:00Z'), key = { version: 1, secret: 'synthetic-review-proof-only-00000000' };
const command = { commandId: randomUUID(), submissionCommandId: randomUUID(), sourceSha256: 'a'.repeat(64), verdict: 'APPROVE_PRIVATE' as const, reason: 'Verificato elaborato sintetico' };
const current: TechnicalUploadReviewAdmission = { reference: { kind: 'TechnicalPractice', targetId: 'practice_a', recipientId: 'tech_a' },
  sourceSha256: command.sourceSha256, submissionCommandId: command.submissionCommandId, assignmentId: randomUUID(), assignmentRevision: 1,
  assignmentStateSha256: 'b'.repeat(64), contextSha256: 'c'.repeat(64), actorId: 'admin_a', sessionId: randomUUID(),
  authorityRevision: 1, actorEpoch: 1, recipientEpoch: 1, keyVersion: 1, validUntil: now + 600_000 };
test('review preview binds exact file, reason, verdict, personal session and current assignment', () => {
  const token = createTechnicalUploadReviewPreview(key, command, current, now);
  assert.deepEqual(readTechnicalUploadReviewPreview(key, token, command, current, now + 1), command);
  for (const delta of [{ verdict: 'REJECT_PRIVATE' }, { reason: 'Altro motivo' }, { commandId: randomUUID() }, { submissionCommandId: randomUUID() }, { sourceSha256: 'd'.repeat(64) }])
    assert.equal(readTechnicalUploadReviewPreview(key, token, { ...command, ...delta }, current, now + 1), null);
  for (const delta of [{ actorId: 'admin_b' }, { sessionId: randomUUID() }, { actorEpoch: 2 }, { recipientEpoch: 2 }, { authorityRevision: 2 },
    { assignmentRevision: 2 }, { contextSha256: 'd'.repeat(64) }, { assignmentStateSha256: 'd'.repeat(64) },
    { reference: { ...current.reference, targetId: 'practice_b' } }, { validUntil: now + 1 }])
    assert.equal(readTechnicalUploadReviewPreview(key, token, command, { ...current, ...delta }, now + 2), null);
  assert.equal(readTechnicalUploadReviewPreview(key, token, command, current, now + 300_000), null);
  assert.equal(readTechnicalUploadReviewPreview({ ...key, secret: 'other-synthetic-proof-only-000000000' }, token, command, current, now), null);
});
test('signed review provenance detects tampering and never includes the reason in the receipt', () => {
  const record = prepareTechnicalUploadReview(key, command, current, new Date(now));
  assert.deepEqual(readTechnicalUploadReviewRecord(key, record, new Date(now + 1)), record);
  assert(!JSON.stringify(record.receipt).includes(command.reason));
  assert.equal(readTechnicalUploadReviewRecord(key, { ...record, command: { ...command, reason: 'Nuovo motivo' } }, new Date(now + 1)), null);
  assert.equal(readTechnicalUploadReviewRecord(key, { ...record, receipt: { ...record.receipt, actorId: 'admin_b' } }, new Date(now + 1)), null);
  assert.equal(readTechnicalUploadReviewRecord(key, record, new Date(now - 1)), null);
  for (const delta of [{ publish: true }, { verdict: 'SEND' }, { verdict: 'APPROVE_AND_SHARE' }, { reason: '' }])
    assert.equal(technicalUploadReviewCommand.safeParse({ ...command, ...delta }).success, false);
});
test('private response is uncached, sandboxed and never renders a file without a passive MIME', async () => {
  const bytes = Buffer.from('Synthetic bytes');
  const passive = technicalUploadFileResponse({ bytes, fileName: 'Relazione.txt', previewMime: 'text/plain; charset=utf-8' }, false);
  assert.match(passive.headers.get('content-disposition')!, /^inline;/); assert.match(passive.headers.get('cache-control')!, /private, no-store/);
  assert.match(passive.headers.get('content-security-policy')!, /^sandbox;/); assert.equal(passive.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await passive.arrayBuffer()), bytes);
  const active = technicalUploadFileResponse({ bytes, fileName: 'File.xlsx', previewMime: null }, false);
  assert.match(active.headers.get('content-disposition')!, /^attachment;/); assert.equal(active.headers.get('content-type'), 'application/octet-stream');
});
