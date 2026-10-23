import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeTechnicalAssignmentRecord } from '../src/lib/technical-assignment-record';

const payload = { protocol: 'TECHNICAL_ASSIGNMENT_V1', id: '50e0a11c-b98b-4f38-a364-c64c9de1cf26',
  revision: 1, commandId: '527bfa1f-a7f2-4f50-8b76-088c43496b32', targetId: 'practice_a',
  selection: { kind: 'TechnicalPractice', userId: 'tech_a', responsibility: 'co_responsabile',
    actions: ['request_admin'], readableFields: ['title'], editableFields: [], documents: [],
    expiresAt: '2026-10-24T12:00:00Z' }, approvedById: 'personal_admin', approvedAt: '2026-10-23T12:00:00Z',
  authorityRevision: 1, actorEpoch: 2, recipientEpoch: 3, contextSha256: 'a'.repeat(64), keyVersion: 1 };
const row = { id: payload.id, kind: 'TechnicalPractice', projectId: null, practiceId: 'practice_a', recipientId: 'tech_a',
  revision: 1, payload, proof: 'b'.repeat(64), revokedAt: null };

test('actual practice and project row shapes bind their single canonical target', () => {
  const decoded = decodeTechnicalAssignmentRecord(row);
  assert.equal(decoded?.targetId, 'practice_a');
  assert.equal(decoded?.recipientId, 'tech_a');
  assert.match(decoded!.stateSha256, /^[a-f0-9]{64}$/);
  const project = { ...row, kind: 'Project', projectId: 'project_a', practiceId: null,
    payload: { ...payload, targetId: 'project_a', selection: { ...payload.selection, kind: 'Project' } } };
  assert.equal(decodeTechnicalAssignmentRecord(project)?.targetId, 'project_a');
});

test('relational recipient, target, identity and revision cannot disagree with the signed payload', () => {
  for (const delta of [{ id: 'd0a65f51-4945-4ec4-b2fc-a78bd34ab394' }, { recipientId: 'tech_b' },
    { revision: 2 }, { practiceId: 'practice_b' }, { projectId: 'project_a' }, { practiceId: null },
    { kind: 'Project' }, { kind: 'PracticeReadiness' }]) {
    assert.equal(decodeTechnicalAssignmentRecord({ ...row, ...delta }), null);
  }
});

test('the state fingerprint includes content, signed proof and persisted revocation', () => {
  const decoded = decodeTechnicalAssignmentRecord(row)!;
  const revoked = decodeTechnicalAssignmentRecord({ ...row, revokedAt: new Date('2026-10-23T12:05:00Z') })!;
  assert.equal(revoked.revokedAt, '2026-10-23T12:05:00.000Z');
  assert.notEqual(revoked.stateSha256, decoded.stateSha256);
  assert.notEqual(decodeTechnicalAssignmentRecord({ ...row, proof: 'c'.repeat(64) })!.stateSha256, decoded.stateSha256);
  assert.notEqual(decodeTechnicalAssignmentRecord({ ...row,
    payload: { ...payload, selection: { ...payload.selection, readableFields: ['title', 'status'] } } })!.stateSha256,
  decoded.stateSha256);
});

test('invalid DB dates, extra columns, unsafe versions and incomplete payloads are rejected', () => {
  for (const invalid of [null, { ...row, revokedAt: new Date(NaN) }, { ...row, revokedAt: '2026-10-23T12:05:00Z' },
    { ...row, version: 1 }, { ...row, revision: 0 }, { ...row, revision: 2_147_483_648 },
    { ...row, payload: {} }, { ...row, proof: 'bad' }, { ...row, payload: { ...payload, entity: 'client_a' } }]) {
    assert.equal(decodeTechnicalAssignmentRecord(invalid), null);
  }
});

test('decoded selection is detached from the DB object and is not a signature or admission verdict', () => {
  const input = structuredClone(row);
  const decoded = decodeTechnicalAssignmentRecord(input)!;
  input.payload.selection.readableFields.push('status');
  assert.deepEqual(decoded.payload.selection.readableFields, ['title']);
  // A structurally valid unverified signature can be decoded; only the existing
  // proof/journal verifier under fresh transaction admission can authorize it.
  assert.equal(decoded.proof, 'b'.repeat(64));
  assert.equal(Object.hasOwn(decoded, 'allowed'), false);
});
