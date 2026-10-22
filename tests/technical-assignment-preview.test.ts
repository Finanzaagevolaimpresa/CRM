import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalJson } from '../src/lib/canonical-json';
import { createTechnicalAssignmentPreview, readTechnicalAssignmentPreview, type TechnicalAssignmentPreviewAdmission } from '../src/lib/technical-assignment-preview';
import { technicalAssignmentProof } from '../src/lib/technical-assignment-proof';

const key = { version: 1, secret: 'synthetic-technical-preview-key-0001' };
const now = Date.parse('2026-10-22T12:00:00Z');
const current: TechnicalAssignmentPreviewAdmission = {
  actorId: 'personal_admin', sessionId: '46d8efbb-a8e7-46d6-8339-750c01658c69',
  authorityRevision: 1, actorEpoch: 2, recipientEpoch: 3,
  kind: 'TechnicalPractice', targetId: 'practice_a', recipientId: 'tech_a',
  assignmentId: null, assignmentRevision: 0, assignmentStateSha256: null,
  contextSha256: 'a'.repeat(64), validUntil: now + 600_000,
};
const command = {
  commandId: '3615d038-a221-44b5-b3f0-0b90496f7c3f', targetId: 'practice_a',
  expectedRevision: 0, expectedContextSha256: current.contextSha256, expectedRecipientEpoch: 3,
  selection: { kind: 'TechnicalPractice', userId: 'tech_a', responsibility: 'co_responsabile',
    actions: ['update_fields', 'request_admin'], readableFields: ['title', 'status'], editableFields: ['title'],
    expiresAt: '2026-10-23T12:00:00Z', documents: [{ documentId: 'document_a', fileId: 'file_a', version: 1,
      contentSha256: 'b'.repeat(64), contextSha256: 'c'.repeat(64), allowDownload: false }] },
  reason: 'Incarico tecnico sintetico',
};
const token = createTechnicalAssignmentPreview('ASSIGN', key, command, current, now);
const decode = (value: string) => JSON.parse(Buffer.from(value, 'base64url').toString('utf-8'));
const encode = (value: unknown) => Buffer.from(canonicalJson(value)).toString('base64url');

test('exact technical selection returns the approved input, including selected file version and no download', () => {
  assert.deepEqual(readTechnicalAssignmentPreview('ASSIGN', key, token, current, now + 1), command);
  assert.equal(readTechnicalAssignmentPreview('REVOKE', key, token, current, now + 1), null);
});

test('changing the person, session, authority, epochs or target invalidates the retained preview', () => {
  for (const delta of [{ actorId: 'other_admin' }, { sessionId: 'dd7938e6-c973-4e8b-9cfa-083947a67638' },
    { authorityRevision: 2 }, { actorEpoch: 3 }, { recipientEpoch: 4 }, { recipientId: 'tech_b' },
    { targetId: 'practice_b' }, { kind: 'Project' as const }, { contextSha256: 'd'.repeat(64) },
    { validUntil: now + 500_000 }]) {
    assert.equal(readTechnicalAssignmentPreview('ASSIGN', key, token, { ...current, ...delta }, now + 1), null);
  }
});

test('assignment changes and an A-to-B-to-A epoch prevent stale confirmation', () => {
  const existing = { ...current, assignmentId: 'c5850130-c385-46ef-8c6e-162c26e788d7',
    assignmentRevision: 1, assignmentStateSha256: 'd'.repeat(64) };
  assert.equal(readTechnicalAssignmentPreview('ASSIGN', key, token, existing, now + 1), null);
  const update = { ...command, expectedRevision: 1 };
  const preview = createTechnicalAssignmentPreview('ASSIGN', key, update, existing, now);
  for (const delta of [{ assignmentRevision: 2 }, { assignmentStateSha256: 'e'.repeat(64) },
    { assignmentId: '56d6f58d-90ab-4017-8631-15fc9adee10a' }, { recipientEpoch: 5 }]) {
    assert.equal(readTechnicalAssignmentPreview('ASSIGN', key, preview, { ...existing, ...delta }, now + 1), null);
  }
});

test('tampered fields, actions, reason, expiry and document versions cannot reuse the signature', () => {
  const changed = [{ ...command, reason: 'Un altro motivo' }, { ...command, commandId: 'cd0f0d38-d9d9-4bb6-a58d-c5e52c83e567' },
    ...[{ responsibility: 'responsabile' }, { actions: ['update_fields', 'request_admin', 'update_status'] },
      { readableFields: ['title', 'status', 'dueDate'] }, { expiresAt: '2026-10-24T12:00:00Z' },
      { documents: [{ ...command.selection.documents[0], version: 2 }] },
      { documents: [{ ...command.selection.documents[0], allowDownload: true }] },
      { documents: [] }].map(delta => ({ ...command, selection: { ...command.selection, ...delta } }))];
  for (const input of changed) {
    const row = decode(token); row.payload.input = input;
    assert.equal(readTechnicalAssignmentPreview('ASSIGN', key, encode(row), current, now + 1), null);
  }
});

test('five-minute deadline, current session deadline and assignment expiry are all effective', () => {
  assert.equal(readTechnicalAssignmentPreview('ASSIGN', key, token, current, now - 1), null);
  assert.equal(readTechnicalAssignmentPreview('ASSIGN', key, token, current, now + 300_000), null);
  const shorter = { ...current, validUntil: now + 20_000 };
  const shortToken = createTechnicalAssignmentPreview('ASSIGN', key, command, shorter, now);
  assert.ok(readTechnicalAssignmentPreview('ASSIGN', key, shortToken, shorter, now + 19_999));
  assert.equal(readTechnicalAssignmentPreview('ASSIGN', key, shortToken, shorter, now + 20_000), null);
  const expiring = { ...command, selection: { ...command.selection, expiresAt: new Date(now + 10_000).toISOString() } };
  const expiringToken = createTechnicalAssignmentPreview('ASSIGN', key, expiring, current, now);
  assert.ok(readTechnicalAssignmentPreview('ASSIGN', key, expiringToken, current, now + 9_999));
  assert.equal(readTechnicalAssignmentPreview('ASSIGN', key, expiringToken, current, now + 10_000), null);
  for (const invalid of [NaN, Infinity, -1, now + 0.5]) {
    assert.throws(() => createTechnicalAssignmentPreview('ASSIGN', key, command, current, invalid));
    assert.equal(readTechnicalAssignmentPreview('ASSIGN', key, token, current, invalid), null);
  }
});

test('no self-assignment, zero-history inconsistency or substituted target can create a preview', () => {
  for (const delta of [{ actorId: current.recipientId }, { assignmentRevision: 1 },
    { assignmentId: 'c5850130-c385-46ef-8c6e-162c26e788d7' }, { assignmentStateSha256: 'e'.repeat(64) },
    { validUntil: now }, { recipientId: 'tech_b' }, { targetId: 'practice_b' }, { kind: 'Project' as const }]) {
    assert.throws(() => createTechnicalAssignmentPreview('ASSIGN', key, command, { ...current, ...delta }, now));
  }
  for (const input of [{ ...command, expectedRevision: 1 }, { ...command, expectedRecipientEpoch: 4 },
    { ...command, expectedContextSha256: 'e'.repeat(64) },
    { ...command, selection: { ...command.selection, expiresAt: new Date(now).toISOString() } },
    { ...command, selection: { ...command.selection, expiresAt: new Date(now + 91 * 86_400_000).toISOString() } }]) {
    assert.throws(() => createTechnicalAssignmentPreview('ASSIGN', key, input, current, now));
  }
});

test('revocation binds the exact existing assignment and cannot become an assign command', () => {
  const existing = { ...current, assignmentId: 'c5850130-c385-46ef-8c6e-162c26e788d7',
    assignmentRevision: 2, assignmentStateSha256: 'd'.repeat(64) };
  const revoke = { commandId: command.commandId, assignmentId: existing.assignmentId, expectedRevision: 2,
    expectedContextSha256: current.contextSha256, reason: 'Revoca sintetica esplicita' };
  const preview = createTechnicalAssignmentPreview('REVOKE', key, revoke, existing, now);
  assert.deepEqual(readTechnicalAssignmentPreview('REVOKE', key, preview, existing, now + 1), revoke);
  assert.equal(readTechnicalAssignmentPreview('ASSIGN', key, preview, existing, now + 1), null);
  assert.throws(() => createTechnicalAssignmentPreview('REVOKE', key, revoke, current, now));
  assert.throws(() => createTechnicalAssignmentPreview('REVOKE', key,
    { ...revoke, assignmentId: '56d6f58d-90ab-4017-8631-15fc9adee10a' }, existing, now));
});

test('another signing purpose, key or noncanonical encoding is rejected', () => {
  const row = decode(token);
  for (const purpose of ['assignment', 'receipt'] as const) {
    assert.equal(readTechnicalAssignmentPreview('ASSIGN', key,
      encode({ ...row, proof: technicalAssignmentProof(key, purpose, row.payload) }), current, now), null);
  }
  assert.equal(readTechnicalAssignmentPreview('ASSIGN', { ...key, version: 2 }, token, current, now), null);
  assert.equal(readTechnicalAssignmentPreview('ASSIGN', { ...key, secret: key.secret + 'changed' }, token, current, now), null);
  for (const invalid of [token + '=', 'a'.repeat(32_001),
    Buffer.from(JSON.stringify(row, null, 2)).toString('base64url'), encode({ ...row, extra: true }),
    encode({ ...row, payload: { ...row.payload, expiresAt: row.payload.expiresAt + 1 } }),
    encode({ ...row, proof: 'a' })]) {
    assert.equal(readTechnicalAssignmentPreview('ASSIGN', key, invalid, current, now), null);
  }
});
