import assert from 'node:assert/strict';
import test from 'node:test';
import { technicalAssignmentProof, type TechnicalAssignmentPayload } from '../src/lib/technical-assignment-proof';
import { previewTechnicalUploadDeposit, confirmTechnicalUploadDeposit } from '../src/lib/technical-upload-plan';
import { readTechnicalUploadReceipt, type TechnicalUploadAdmission } from '../src/lib/technical-upload-contract';
import { prepareTechnicalUploadRecord, readTechnicalUploadRecord } from '../src/lib/technical-upload-record';

const now = new Date('2026-10-24T12:00:00.000Z');
const key = { version: 1, secret: 'synthetic-upload-record-key-only-0001' };
const p: TechnicalAssignmentPayload = { protocol: 'TECHNICAL_ASSIGNMENT_V1',
  id: '8be93d89-01c4-4efe-8876-d4adb2758dd1', commandId: '785267a5-d7ae-4841-9dda-dd8b1cc4b2c6', revision: 1,
  targetId: 'practice_a', selection: { kind: 'TechnicalPractice', userId: 'tech_a', responsibility: 'supporto',
    actions: ['upload_document'], readableFields: ['title'], editableFields: [], documents: [],
    expiresAt: '2026-10-25T12:00:00Z', uploadProfile: { purpose: 'Elaborati da esaminare', formats: ['.txt'],
      maxFileBytes: 1024, maxFilesPerRevision: 3, maxBytesPerRevision: 2048, visibility: 'PRIVATE_PENDING_ADMIN_REVIEW' } },
  approvedById: 'personal_admin', approvedAt: '2026-10-24T11:00:00Z', authorityRevision: 1,
  actorEpoch: 2, recipientEpoch: 3, contextSha256: 'a'.repeat(64), keyVersion: 1 };
function assignment() {
  const revisionId = 'a4b9afec-2f1c-4e5b-875b-f502bb598e67', sessionId = '82bb4a48-3608-45a1-9a3e-fb9893863b06';
  const receipt = { protocol: 'TECHNICAL_ASSIGNMENT_RECEIPT_V1', commandId: p.commandId, assignmentId: p.id,
    revisionId, revision: 1, operation: 'ASSIGN', fieldCount: 1, actionCount: 1, documentCount: 0,
    keyVersion: 1, actorId: p.approvedById, sessionId, requestDigest: 'b'.repeat(64) };
  const proof = technicalAssignmentProof(key, 'assignment', p);
  return { assignment: { payload: p, proof, revokedAt: null },
    decision: { id: p.commandId, actorId: p.approvedById, sessionId, kind: p.selection.kind,
      targetId: p.targetId, recipientId: p.selection.userId, expectedRevision: 0, operation: 'ASSIGN',
      requestDigest: receipt.requestDigest, receipt, receiptProof: technicalAssignmentProof(key, 'receipt', receipt), transactionId: 42n },
    revision: { id: revisionId, assignmentId: p.id, revision: 1, commandId: p.commandId, payload: p, proof,
      revokedAt: null, transactionId: 42n },
    audit: { id: revisionId, actorId: p.approvedById, event: 'technical_assignment_changed',
      entityType: 'TechnicalAssignmentRevision', entityId: revisionId, before: { version: 0 },
      after: { version: 1, action: 'ASSIGN', fieldCount: 1, actionCount: 1, documentCount: 0 } } };
}
const current: TechnicalUploadAdmission = { target: { kind: 'TechnicalPractice', targetId: p.targetId },
  actorId: p.selection.userId, sessionId: '5921aaad-1b08-4d4d-9135-9d9e5880e9e6',
  assignmentId: p.id, assignmentRevision: 1, assignmentStateSha256: 'b'.repeat(64), authorityRevision: 1,
  actorEpoch: 3, authorEpoch: 2, keyVersion: 1, contextSha256: p.contextSha256, scopeGeneration: 7,
  profile: p.selection.uploadProfile!, consumedFiles: 0, consumedBytes: 0, validUntil: now.getTime() + 300_000 };
const input = { commandId: '03055a30-7f2b-41c1-8428-bb8d2159b8d8', assignmentId: p.id, assignmentRevision: 1,
  expectedContextSha256: p.contextSha256, title: 'Elaborato tecnico', action: 'deposit_private_document' };
const bytes = Buffer.from('Elaborato sintetico per prova privata.');
const submissionId = '3f67080f-a0b1-4657-9d5b-c01fef7fb028';
function fixture() {
  const preview = previewTechnicalUploadDeposit(key, input, 'Relazione.txt', bytes, current, now.getTime());
  const plan = confirmTechnicalUploadDeposit(key, preview.command, preview.token, bytes, true, current, now.getTime());
  assert.ok(plan);
  const stored = { storageKey: plan.privateFile.storageKey, sha256: plan.privateFile.sha256, sizeBytes: plan.privateFile.sizeBytes };
  return { plan, stored, journal: prepareTechnicalUploadRecord(key, plan, current, stored, submissionId, now) };
}

test('proposed immutable row binds actual private storage and retained personal decision', () => {
  const { journal } = fixture();
  assert.deepEqual(readTechnicalUploadRecord(key, journal, assignment(), now), journal);
  assert.equal(journal.record.receipt.status, 'PRIVATE_STORED');
  assert.equal(journal.record.command.title, input.title);
  assert.deepEqual(journal.audit.after, { action: 'deposit_private_document', fileCount: 1 });
  for (const text of [input.title, 'Relazione.txt', bytes.toString(), journal.record.storageKey]) {
    assert.equal(JSON.stringify(journal.audit).includes(text), false);
    assert.equal(JSON.stringify(journal.record.receipt).includes(text), false);
  }
  for (const field of ['documentId','versionId','recipients','publicUrl','published','send'])
    assert.equal(Object.hasOwn(journal.record, field), false);
});

test('failed or inconsistent storage acknowledgement cannot become a prepared receipt', () => {
  const { plan, stored } = fixture();
  for (const delta of [{ storageKey: 'technical-submissions/v1/' + '0'.repeat(64) },
    { sha256: '0'.repeat(64) }, { sizeBytes: stored.sizeBytes + 1 }])
    assert.throws(() => prepareTechnicalUploadRecord(key, plan, current, { ...stored, ...delta }, submissionId, now));
  const changed = structuredClone(plan); changed.privateFile.bytes[0] ^= 1;
  assert.throws(() => prepareTechnicalUploadRecord(key, changed, current, stored, submissionId, now));
});

test('quota, current revision, session and time changes before commit deny prepared rows', () => {
  const { plan, stored } = fixture();
  for (const delta of [{ consumedFiles: 1, consumedBytes: bytes.length }, { assignmentRevision: 2 },
    { actorId: 'tech_b' }, { sessionId: '6373bf62-51ee-43ce-81d8-47c55a775094' },
    { target: { ...current.target, targetId: 'practice_b' } }, { contextSha256: 'c'.repeat(64) },
    { validUntil: now.getTime() }, { keyVersion: 2 }])
    assert.throws(() => prepareTechnicalUploadRecord(key, plan, { ...current, ...delta }, stored, submissionId, now));
  assert.throws(() => prepareTechnicalUploadRecord(key, plan, current, stored, submissionId, new Date(NaN)));
});

test('row substitution cannot preserve a valid signed receipt for different content or identities', () => {
  const { journal } = fixture();
  for (const delta of [{ id: input.commandId }, { actorId: 'tech_b' }, { assignmentRevision: 2 },
    { commandId: submissionId }, { sizeBytes: bytes.length + 1 }, { contentSha256: '0'.repeat(64) },
    { storageKey: 'technical-submissions/v1/' + '0'.repeat(64) }, { createdAt: '2026-10-24T12:00:01.000Z' },
    { target: { ...current.target, targetId: 'practice_b' } }, { proof: '0'.repeat(64) }]) {
    assert.equal(readTechnicalUploadRecord(key, { ...journal, record: { ...journal.record, ...delta } }, assignment(), now), null);
  }
});

test('metadata and exact file descriptor remain bound by the signed request digest', () => {
  const { journal } = fixture();
  for (const command of [{ ...journal.record.command, title: 'Substituted' },
    { ...journal.record.command, file: { ...journal.record.command.file, fileName: 'Other.txt' } },
    { ...journal.record.command, file: { ...journal.record.command.file, previewMime: null } }]) {
    assert.equal(readTechnicalUploadRecord(key, { ...journal, record: { ...journal.record, command } }, assignment(), now), null);
  }
});

test('missing, enriched, foreign or changed audit fails historical verification', () => {
  const { journal } = fixture();
  for (const audit of [null, { ...journal.audit, actorId: 'tech_b' }, { ...journal.audit, entityId: input.commandId },
    { ...journal.audit, after: { action: 'deposit_private_document', fileCount: 2 } },
    { ...journal.audit, after: { ...journal.audit.after, title: input.title } },
    { ...journal.audit, before: { fileName: 'Relazione.txt' } }])
    assert.equal(readTechnicalUploadRecord(key, { ...journal, audit }, assignment(), now), null);
});

test('an assignment signature without complete retained decision/revision/audit is insufficient', () => {
  const { journal } = fixture(), retained = assignment();
  for (const altered of [null, { assignment: retained.assignment }, { ...retained, audit: null },
    { ...retained, revision: { ...retained.revision, transactionId: 43n } }])
    assert.equal(readTechnicalUploadRecord(key, journal, altered, now), null);
});

test('future records and another signing key are denied without repairing the journal', () => {
  const { journal } = fixture(), original = structuredClone(journal);
  assert.equal(readTechnicalUploadRecord({ ...key, secret: 'other-synthetic-signing-material-0001' }, journal, assignment(), now), null);
  assert.equal(readTechnicalUploadRecord(key, journal, assignment(), new Date(now.getTime() - 1)), null);
  assert.deepEqual(journal, original);
});

test('historical outcome survives expiry but still requires the exact original actor and session', () => {
  const { journal } = fixture(), later = new Date('2026-10-26T12:00:00Z');
  assert.ok(readTechnicalUploadRecord(key, journal, assignment(), later));
  const r = journal.record;
  const expected = { commandId: r.commandId, actorId: r.actorId, sessionId: r.sessionId, target: r.target, requestDigest: r.requestDigest };
  assert.ok(readTechnicalUploadReceipt(key, r.receipt, r.proof, expected, later.getTime()));
  for (const delta of [{ actorId: 'tech_b' }, { sessionId: '6373bf62-51ee-43ce-81d8-47c55a775094' },
    { requestDigest: '0'.repeat(64) }, { target: { ...r.target, targetId: 'practice_b' } }])
    assert.equal(readTechnicalUploadReceipt(key, r.receipt, r.proof, { ...expected, ...delta }, later.getTime()), null);
});
