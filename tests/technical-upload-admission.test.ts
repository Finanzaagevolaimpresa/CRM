import assert from 'node:assert/strict';
import test from 'node:test';
import { admitTechnicalUploadSource, type LockedTechnicalUploadSource } from '../src/lib/technical-upload-admission';
import { technicalAssignmentProof, type TechnicalAssignmentPayload, type CurrentTechnicalAssignmentProof } from '../src/lib/technical-assignment-proof';
import { previewTechnicalUploadDeposit } from '../src/lib/technical-upload-plan';
import { readTechnicalUploadPreview } from '../src/lib/technical-upload-contract';

const key = { version: 1, secret: 'synthetic-upload-admission-key-0001' };
const now = new Date('2026-10-24T12:00:00Z');
const p: TechnicalAssignmentPayload = { protocol: 'TECHNICAL_ASSIGNMENT_V1',
  id: '8be93d89-01c4-4efe-8876-d4adb2758dd1', commandId: '785267a5-d7ae-4841-9dda-dd8b1cc4b2c6',
  revision: 1, targetId: 'practice_a', selection: { kind: 'TechnicalPractice', userId: 'tech_a',
    responsibility: 'co_responsabile', actions: ['upload_document'], readableFields: ['title'],
    editableFields: [], documents: [], expiresAt: '2026-10-25T12:00:00Z',
    uploadProfile: { purpose: 'Elaborati da esaminare', formats: ['.txt'], maxFileBytes: 1024,
      maxFilesPerRevision: 3, maxBytesPerRevision: 2048, visibility: 'PRIVATE_PENDING_ADMIN_REVIEW' } },
  approvedById: 'personal_admin', approvedAt: '2026-10-24T11:00:00Z',
  authorityRevision: 1, actorEpoch: 2, recipientEpoch: 3, contextSha256: 'a'.repeat(64), keyVersion: 1 };
const current: CurrentTechnicalAssignmentProof = { userId: 'tech_a', role: 'consulente', active: true, sessionLive: true,
  targetId: p.targetId, kind: 'TechnicalPractice', targetWorkable: true, parentContextValid: true, selectiveCeilingAllows: true,
  currentContextSha256: p.contextSha256, assignmentContextSha256: p.contextSha256,
  currentRecipientEpoch: 3, assignmentRecipientEpoch: 3, currentRevision: 1, assignmentRevision: 1,
  revoked: false, assignmentId: p.id, recordReadAllowed: true,
  authority: { purpose: 'technical-assignment', userId: 'personal_admin', enabled: true, revision: 1,
    actorEpoch: 2, actorActive: true, actorRole: 'admin', assignmentWriteAllowed: true } };
function fixture() {
  const revisionId = 'a4b9afec-2f1c-4e5b-875b-f502bb598e67', sessionId = '82bb4a48-3608-45a1-9a3e-fb9893863b06';
  const receipt = { protocol: 'TECHNICAL_ASSIGNMENT_RECEIPT_V1', commandId: p.commandId, assignmentId: p.id, revisionId,
    revision: 1, operation: 'ASSIGN', fieldCount: 1, actionCount: 1, documentCount: 0, keyVersion: 1,
    actorId: p.approvedById, sessionId, requestDigest: 'b'.repeat(64) };
  const assignment = { payload: p, proof: technicalAssignmentProof(key, 'assignment', p), revokedAt: null };
  const journal = { assignment, decision: { id: p.commandId, actorId: p.approvedById, sessionId,
    kind: p.selection.kind, targetId: p.targetId, recipientId: p.selection.userId,
    expectedRevision: 0, operation: 'ASSIGN', requestDigest: receipt.requestDigest, receipt,
    receiptProof: technicalAssignmentProof(key, 'receipt', receipt), transactionId: 42n },
    revision: { id: revisionId, assignmentId: p.id, revision: 1, commandId: p.commandId,
      payload: p, proof: assignment.proof, revokedAt: null, transactionId: 42n },
    audit: { id: revisionId, actorId: p.approvedById, event: 'technical_assignment_changed',
      entityType: 'TechnicalAssignmentRevision', entityId: revisionId,
      before: { version: 0 }, after: { version: 1, action: 'ASSIGN', fieldCount: 1, actionCount: 1, documentCount: 0 } } };
  const record = { id: p.id, kind: 'TechnicalPractice', projectId: null, practiceId: p.targetId, recipientId: p.selection.userId,
    revision: 1, payload: p, proof: assignment.proof, revokedAt: null };
  const source: LockedTechnicalUploadSource = { record, journal, current: structuredClone(current),
    target: { kind: 'TechnicalPractice', targetId: p.targetId }, contextSha256: p.contextSha256, scopeGeneration: 7,
    session: { userId: 'tech_a', id: '5921aaad-1b08-4d4d-9135-9d9e5880e9e6',
      tokenExpiresAt: now.getTime() + 600_000, registryExpiresAt: now.getTime() + 300_000 },
    uploadActionAllowed: true, quota: { assignmentId: p.id, revision: 1, files: 0, bytes: 0 } };
  return { source, journal, record };
}
test('full retained journal and exact current record derive a bounded private admission', () => {
  const { source } = fixture(), admitted = admitTechnicalUploadSource(key, source, now);
  assert.ok(admitted);
  assert.equal(admitted.validUntil, source.session.registryExpiresAt);
  assert.equal(admitted.scopeGeneration, 7);
  assert.equal(admitted.profile.visibility, 'PRIVATE_PENDING_ADMIN_REVIEW');
  assert.deepEqual(admitted.profile, p.selection.uploadProfile);
  assert.equal(admitted.actorId, 'tech_a');
  assert.equal(admitted.authorEpoch, 2);
  assert.equal(admitted.actorEpoch, 3);
  assert.equal(admitted.assignmentStateSha256.length, 64);
});
test('a signature without decision/revision/audit does not admit a deposit', () => {
  const { source, journal } = fixture();
  for (const row of [{ assignment: journal.assignment }, { ...journal, audit: null },
    { ...journal, revision: { ...journal.revision, transactionId: 43n } }])
    assert.equal(admitTechnicalUploadSource(key, { ...source, journal: row }, now), null);
});
test('record/journal substitution, unsigned profile change and stale row are denied', () => {
  const { source, record } = fixture();
  const changed = [{ ...record, recipientId: 'tech_b' }, { ...record, proof: '0'.repeat(64) },
    { ...record, revision: 2 }, { ...record, practiceId: 'practice_b' },
    { ...record, payload: { ...p, selection: { ...p.selection, uploadProfile: { ...p.selection.uploadProfile, maxFilesPerRevision: 20 } } } }];
  for (const row of changed) assert.equal(admitTechnicalUploadSource(key, { ...source, record: row }, now), null);
});
test('current revocation, actor/authority change, role and lifecycle restrictions remain effective', () => {
  const { source } = fixture();
  for (const delta of [{ userId: 'tech_b' }, { role: 'commerciale' }, { role: 'admin' }, { active: false },
    { sessionLive: false }, { revoked: true }, { currentRevision: 2 }, { currentRecipientEpoch: 4 },
    { targetWorkable: false }, { parentContextValid: false }, { selectiveCeilingAllows: false }, { recordReadAllowed: false }])
    assert.equal(admitTechnicalUploadSource(key, { ...source, current: { ...current, ...delta } }, now), null);
  for (const delta of [{ userId: 'other_admin' }, { enabled: false }, { revision: 2 }, { actorEpoch: 4 },
    { actorActive: false }, { actorRole: 'commerciale' }, { assignmentWriteAllowed: false }])
    assert.equal(admitTechnicalUploadSource(key, { ...source, current: { ...current, authority: { ...current.authority, ...delta } } }, now), null);
});
test('the upload role permission and context identity are independently required', () => {
  const { source } = fixture();
  for (const delta of [{ uploadActionAllowed: false }, { contextSha256: 'c'.repeat(64) }, { scopeGeneration: 0 },
    { target: { kind: 'TechnicalPractice' as const, targetId: 'practice_b' } }])
    assert.equal(admitTechnicalUploadSource(key, { ...source, ...delta }, now), null);
});
test('session identities, expiry and current quota cannot be borrowed from another revision', () => {
  const { source } = fixture();
  for (const delta of [{ userId: 'tech_b' }, { id: 'not-a-session' }, { tokenExpiresAt: now.getTime() },
    { registryExpiresAt: now.getTime() }, { registryExpiresAt: Number.NaN }])
    assert.equal(admitTechnicalUploadSource(key, { ...source, session: { ...source.session, ...delta } }, now), null);
  for (const delta of [{ assignmentId: '84649875-6047-4a63-a702-6653533bb19d' }, { revision: 2 },
    { files: -1 }, { files: 4 }, { files: 0, bytes: 100 }, { files: 1, bytes: 2048 }])
    assert.equal(admitTechnicalUploadSource(key, { ...source, quota: { ...source.quota, ...delta } }, now), null);
});
test('a subsequent quota consumption invalidates an earlier preview without renewing it', () => {
  const { source } = fixture(), admitted = admitTechnicalUploadSource(key, source, now);
  assert.ok(admitted);
  const raw = { commandId: '6ad83cb3-e60f-4d2b-9b79-5ed5f8f68317', assignmentId: p.id, assignmentRevision: 1,
    expectedContextSha256: p.contextSha256, title: 'Elaborato', action: 'deposit_private_document' };
  const preview = previewTechnicalUploadDeposit(key, raw, 'elaborato.txt', Buffer.from('test isolato'), admitted, now.getTime());
  const after = admitTechnicalUploadSource(key, { ...source, quota: { ...source.quota, files: 1, bytes: 20 } }, now);
  assert.ok(after);
  assert.equal(readTechnicalUploadPreview(key, preview.token, after, now.getTime() + 1), null);
  assert.equal(readTechnicalUploadPreview(key, preview.token, admitted, admitted.validUntil), null);
});
test('retained decision expiry and key rotation remain fail-closed', () => {
  const { source } = fixture();
  assert.equal(admitTechnicalUploadSource({ ...key, version: 2 }, source, now), null);
  assert.equal(admitTechnicalUploadSource(key, source, new Date(p.selection.expiresAt)), null);
  assert.equal(admitTechnicalUploadSource(key, source, new Date(Number.NaN)), null);
});
