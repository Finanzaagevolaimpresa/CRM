import assert from 'node:assert/strict';
import test from 'node:test';
import type { TechnicalAssignmentSelection } from '../src/lib/technical-assignment-contract';
import { technicalAssignmentProof } from '../src/lib/technical-assignment-proof';
import { canonicalJson } from '../src/lib/canonical-json';
import { createTechnicalWorkPreview, readTechnicalWorkPreview, technicalWorkCommand, technicalWorkRequestDigest,
  technicalWorkReceipt, validateTechnicalWorkPatch, verifyTechnicalWorkReceipt, type TechnicalWorkAdmission,
  type TechnicalWorkCommand } from '../src/lib/technical-work-contract';

const key = { version: 1, secret: 'synthetic-work-only-key-000000000000001' };
const now = Date.parse('2026-10-23T08:00:00Z');
const target = { kind: 'TechnicalPractice' as const, targetId: 'synthetic-practice-a' };
const selection: TechnicalAssignmentSelection = { kind: target.kind, userId: 'synthetic-tech-a', responsibility: 'co_responsabile',
  actions: ['update_fields', 'update_status'], readableFields: ['title', 'status', 'priority', 'dueDate', 'clientVisibleStatus'],
  editableFields: ['priority', 'dueDate', 'clientVisibleStatus'], documents: [], expiresAt: new Date(now + 3600_000).toISOString() };
const command: TechnicalWorkCommand = { commandId: '18a13acf-d67f-48f7-9965-8deed576769e',
  assignmentId: '3ed73827-9444-4875-8037-5658e85cc727', assignmentRevision: 2, expectedContextSha256: 'a'.repeat(64),
  expectedTargetSha256: 'b'.repeat(64), action: 'update_fields', patch: { priority: 'alta', clientVisibleStatus: 'In verifica' } };
const admission: TechnicalWorkAdmission = { target, actorId: selection.userId, sessionId: '8bb47993-0740-4907-8bf6-dc2917b46076',
  assignmentId: command.assignmentId, assignmentRevision: 2, assignmentStateSha256: 'c'.repeat(64), authorityRevision: 1,
  actorEpoch: 3, authorEpoch: 5, keyVersion: 1, contextSha256: command.expectedContextSha256,
  targetSha256: command.expectedTargetSha256, validUntil: now + 900_000 };

test('technical work changes exactly selected fields and canonical values, including explicit nullable clearing', () => {
  assert.deepEqual(validateTechnicalWorkPatch(selection, command), command.patch);
  assert.deepEqual(validateTechnicalWorkPatch(selection, { ...command, patch: { dueDate: '2026-10-24T11:00:00+02:00', clientVisibleStatus: '' } }),
    { dueDate: '2026-10-24T09:00:00.000Z', clientVisibleStatus: null });
  assert.deepEqual(validateTechnicalWorkPatch(selection, { ...command, patch: { dueDate: null } }), { dueDate: null });
});
test('readable alone cannot edit; owner, commercial, client, private and financial fields cannot be patched', () => {
  for (const patch of [{ title: 'Read only' }, { technicalOwnerId: 'synthetic-tech-b' }, { commercialOwnerId: 'synthetic-sales-b' },
    { clientId: 'foreign-client' }, { internalNotes: 'Private' }, { totalInvestment: '100' }, { status: 'approvata' }] as Record<string, string | null>[]) {
    assert.throws(() => validateTechnicalWorkPatch(selection, { ...command, patch }));
  }
  assert.throws(() => validateTechnicalWorkPatch({ ...selection, actions: ['update_status'], editableFields: [] }, command));
  assert.throws(() => technicalWorkCommand.parse({ ...command, extra: true }));
  assert.throws(() => validateTechnicalWorkPatch(selection, { ...command, patch: JSON.parse('{"__proto__":"change"}') }));
});
test('status is a separate action, never archive/reactivation, contract phase or extra field mutation', () => {
  assert.deepEqual(validateTechnicalWorkPatch(selection, { ...command, action: 'update_status', patch: { status: 'in_progettazione' } }), { status: 'in_progettazione' });
  for (const patch of [{ status: 'archiviata' }, { status: null }, { status: 'in_progettazione', clientVisibleStatus: 'Also this' }] as Record<string, string | null>[]) {
    assert.throws(() => validateTechnicalWorkPatch(selection, { ...command, action: 'update_status', patch }));
  }
  const project: TechnicalAssignmentSelection = { ...selection, kind: 'Project', readableFields: ['title', 'description', 'status'], editableFields: ['description'] };
  for (const status of ['archiviato', 'contratto_in_attesa']) assert.throws(() => validateTechnicalWorkPatch(project, { ...command, action: 'update_status', patch: { status } }));
  assert.deepEqual(validateTechnicalWorkPatch(project, { ...command, patch: { description: null } }), { description: null });
});
test('invalid priority, dates, types, excessive fields and empty mutations fail before persistence', () => {
  for (const patch of [{ priority: 'critical' }, { dueDate: '' }, { dueDate: '2026-99-99' }, { clientVisibleStatus: 'x'.repeat(5001) }, {},
    { priority: 4 }, { dueDate: true }]) assert.throws(() => validateTechnicalWorkPatch(selection, { ...command, patch } as TechnicalWorkCommand));
  const withTitle: TechnicalAssignmentSelection = { ...selection, editableFields: ['title'], actions: ['update_fields'] };
  assert.throws(() => validateTechnicalWorkPatch(withTitle, { ...command, patch: { title: null } }));
});
test('exact preview binds patch, target, actor, session, assignment revision, current scope, key and target version', () => {
  const token = createTechnicalWorkPreview(key, command, admission, now);
  assert.deepEqual(readTechnicalWorkPreview(key, token, admission, now + 1), command);
  for (const delta of [{ target: { ...target, targetId: 'synthetic-practice-b' } }, { actorId: 'synthetic-tech-b' },
    { sessionId: '25df1814-2206-4ef4-8044-5f1a95c24861' }, { assignmentRevision: 3 }, { actorEpoch: 4 },
    { authorityRevision: 2 }, { authorEpoch: 6 }, { keyVersion: 2 }, { assignmentStateSha256: 'd'.repeat(64) },
    { contextSha256: 'e'.repeat(64) }, { targetSha256: 'f'.repeat(64) }]) {
    assert.equal(readTechnicalWorkPreview(key, token, { ...admission, ...delta }, now + 1), null);
  }
  const envelope = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  envelope.payload.command.patch.clientVisibleStatus = 'Changed after preview';
  assert.equal(readTechnicalWorkPreview(key, Buffer.from(canonicalJson(envelope)).toString('base64url'), admission, now + 1), null);
  assert.throws(() => createTechnicalWorkPreview(key, { ...command, expectedTargetSha256: 'f'.repeat(64) }, admission, now));
});
test('expired previews, malformed encodings, domain substitution and changed keys cannot execute', () => {
  const token = createTechnicalWorkPreview(key, command, admission, now);
  assert.equal(readTechnicalWorkPreview(key, token, admission, now + 300_000), null);
  assert.equal(readTechnicalWorkPreview(key, token, admission, now - 1), null);
  assert.equal(readTechnicalWorkPreview(key, `${token}=`, admission, now), null);
  assert.equal(readTechnicalWorkPreview({ ...key, secret: 'other-synthetic-key-0000000000000001' }, token, admission, now), null);
  const envelope = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  for (const purpose of ['assignment', 'preview', 'receipt', 'work-receipt'] as const) {
    envelope.proof = technicalAssignmentProof(key, purpose, envelope.payload);
    assert.equal(readTechnicalWorkPreview(key, Buffer.from(canonicalJson(envelope)).toString('base64url'), admission, now), null);
  }
  const near = { ...admission, validUntil: now + 5 };
  assert.equal(readTechnicalWorkPreview(key, createTechnicalWorkPreview(key, command, near, now), near, now + 5), null);
});
test('receipt is a minimized signed outcome and cannot authorize another command or reveal arbitrary values', () => {
  const digest = technicalWorkRequestDigest(target, command);
  assert.notEqual(technicalWorkRequestDigest(target, { ...command, patch: { priority: 'media' } }), digest);
  const receipt = technicalWorkReceipt.parse({ protocol: 'TECHNICAL_WORK_RECEIPT_V1', commandId: command.commandId,
    actorId: admission.actorId, sessionId: admission.sessionId, target, assignmentId: command.assignmentId,
    assignmentRevision: 2, action: command.action, fieldCount: 2, requestDigest: digest,
    targetVersion: new Date(now).toISOString(), recordedAt: new Date(now).toISOString(), keyVersion: 1 });
  const proof = technicalAssignmentProof(key, 'work-receipt', receipt);
  const expected = { commandId: command.commandId, actorId: admission.actorId, sessionId: admission.sessionId, target, requestDigest: digest };
  assert.deepEqual(verifyTechnicalWorkReceipt(receipt, proof, key, expected, new Date(now + 1)), receipt);
  for (const delta of [{ actorId: 'synthetic-tech-b' }, { sessionId: '25df1814-2206-4ef4-8044-5f1a95c24861' },
    { target: { ...target, targetId: 'other' } }, { requestDigest: 'f'.repeat(64) }]) {
    assert.equal(verifyTechnicalWorkReceipt(receipt, proof, key, { ...expected, ...delta }, new Date(now + 1)), null);
  }
  assert.equal(verifyTechnicalWorkReceipt({ ...receipt, patch: command.patch }, proof, key, expected, new Date(now + 1)), null);
  assert.equal(verifyTechnicalWorkReceipt(receipt, technicalAssignmentProof(key, 'receipt', receipt), key, expected, new Date(now + 1)), null);
  assert.equal(JSON.stringify(receipt).includes('In verifica'), false);
});
