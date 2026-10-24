import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalJson } from '../src/lib/canonical-json';
import { technicalAssignmentProof } from '../src/lib/technical-assignment-proof';
import { createTechnicalWorkItemPreview, readTechnicalWorkItemPreview, technicalWorkItemCommand,
  technicalWorkItemReceipt, technicalWorkItemRequestDigest, readTechnicalWorkItemReceipt,
  signTechnicalWorkItemReceipt, type TechnicalWorkItemAdmission, type TechnicalWorkItemCommand,
  type TechnicalWorkItemReceipt } from '../src/lib/technical-work-item-command';

const now = Date.parse('2026-10-24T05:00:00Z');
const key = { version: 2, secret: 'synthetic-work-item-key-material-17' };
const command: TechnicalWorkItemCommand = { commandId: '3ca27be0-c282-405e-b7b2-4f12ddfdc169',
  assignmentId: 'dd2d84c3-05b7-4f2f-b797-00b137274845', assignmentRevision: 3,
  bindingId: '8ad0ccdd-5acb-4d16-a720-3870423c15b8', bindingRevision: 2,
  kind: 'Task', itemId: 'synthetic-task', expectedContextSha256: 'a'.repeat(64), expectedItemVersion: 7,
  action: 'update_fields', patch: { title: 'Relazione tecnica', dueAt: '2026-10-27T10:00:00.000Z' } };
const current: TechnicalWorkItemAdmission = { target: { kind: 'TechnicalPractice', targetId: 'synthetic-practice-a' },
  actorId: 'synthetic-tech-a', sessionId: '223c3ae2-0114-44e8-8804-73c65b6133cc',
  assignmentId: command.assignmentId, assignmentRevision: command.assignmentRevision,
  assignmentStateSha256: 'b'.repeat(64), authorityRevision: 1, actorEpoch: 2, authorEpoch: 3, keyVersion: key.version,
  bindingId: command.bindingId, bindingRevision: command.bindingRevision, kind: command.kind, itemId: command.itemId,
  contextSha256: command.expectedContextSha256, selectionSha256: 'c'.repeat(64), itemVersion: command.expectedItemVersion,
  validUntil: now + 900_000 };
const token = createTechnicalWorkItemPreview(key, command, current, now);
const receipt: TechnicalWorkItemReceipt = { protocol: 'TECHNICAL_WORK_ITEM_RECEIPT_V1',
  commandId: command.commandId, actorId: current.actorId, sessionId: current.sessionId, target: current.target,
  assignmentId: command.assignmentId, assignmentRevision: command.assignmentRevision,
  bindingId: command.bindingId, bindingRevision: command.bindingRevision, kind: command.kind, itemId: command.itemId,
  action: command.action, fieldCount: 2, requestDigest: technicalWorkItemRequestDigest(current.target, command),
  previousItemVersion: 7, itemVersion: 8, recordedAt: new Date(now + 10).toISOString(), keyVersion: key.version };
const signature = signTechnicalWorkItemReceipt(key, receipt);
const expected = { commandId: command.commandId, actorId: current.actorId, sessionId: current.sessionId,
  target: current.target, requestDigest: receipt.requestDigest };

test('preview preserves the exact editable proposal and expires after five minutes', () => {
  assert.deepEqual(readTechnicalWorkItemPreview(key, token, current, now + 299_999), command);
  assert.equal(readTechnicalWorkItemPreview(key, token, current, now + 300_000), null);
  assert.equal(readTechnicalWorkItemPreview(key, token, current, now - 1), null);
});
test('preview expires at the earliest current session/assignment/document boundary', () => {
  const short = { ...current, validUntil: now + 1_000 };
  const shortToken = createTechnicalWorkItemPreview(key, command, short, now);
  assert.deepEqual(readTechnicalWorkItemPreview(key, shortToken, short, now + 999), command);
  assert.equal(readTechnicalWorkItemPreview(key, shortToken, short, now + 1_000), null);
  assert.throws(() => createTechnicalWorkItemPreview(key, command, { ...short, validUntil: now }, now));
});
test('another technician, reopened session or practice cannot reuse an earlier preview', () => {
  for (const delta of [{ actorId: 'synthetic-tech-b' }, { sessionId: '9a3d8508-2a3e-4be3-91cb-fef73d4da678' },
    { target: { ...current.target, targetId: 'synthetic-practice-b' } },
    { target: { ...current.target, kind: 'Project' as const } }]) {
    assert.equal(readTechnicalWorkItemPreview(key, token, { ...current, ...delta }, now + 1), null);
  }
});
test('revocation or permission/selection/key changes invalidate an open preview even with unchanged values', () => {
  for (const delta of [{ assignmentRevision: 4 }, { assignmentStateSha256: 'd'.repeat(64) }, { actorEpoch: 3 },
    { authorEpoch: 4 }, { authorityRevision: 2 }, { selectionSha256: 'd'.repeat(64) }, { keyVersion: 3 },
    { contextSha256: 'd'.repeat(64) }, { validUntil: now + 800_000 }]) {
    assert.equal(readTechnicalWorkItemPreview(key, token, { ...current, ...delta }, now + 1), null);
  }
});
test('ordinary item edits, relinking and a different item invalidate the optimistic preview', () => {
  for (const delta of [{ itemVersion: 8 }, { bindingRevision: 3 }, { itemId: 'synthetic-other-task' },
    { bindingId: '05337776-538d-4a7e-9f98-7b67e3158d14' }, { kind: 'ChecklistItem' as const }]) {
    assert.equal(readTechnicalWorkItemPreview(key, token, { ...current, ...delta }, now + 1), null);
    assert.throws(() => createTechnicalWorkItemPreview(key, command, { ...current, ...delta }, now));
  }
});
test('a preview never carries a status assertion, assignment, parent relink or document selection', () => {
  for (const patch of [{ status: 'completata' }, { completedAt: new Date(now).toISOString() },
    { assignedToId: 'synthetic-tech-b' }, { projectId: 'foreign' }, { documentId: 'restricted-document' },
    { title: 'Allowed', audit: 'invented' }, {}]) {
    assert.equal(technicalWorkItemCommand.safeParse({ ...command, patch }).success, false);
  }
  assert.equal(technicalWorkItemCommand.safeParse({ ...command, kind: 'ChecklistItem', patch: { dueAt: null } }).success, false);
  assert.equal(technicalWorkItemCommand.safeParse({ ...command, action: 'update_status', patch: { status: 'validato' } }).success, false);
});
test('same command ID with different content or target has a different digest for idempotency conflict', () => {
  const original = technicalWorkItemRequestDigest(current.target, command);
  assert.notEqual(technicalWorkItemRequestDigest(current.target, { ...command, patch: { title: 'Changed' } }), original);
  assert.notEqual(technicalWorkItemRequestDigest({ ...current.target, targetId: 'foreign' }, command), original);
  assert.equal(technicalWorkItemRequestDigest(current.target, { ...command, patch: { dueAt: command.patch.dueAt, title: command.patch.title } }), original);
});
test('tampering, unknown envelope keys, noncanonical encoding and other signed domains fail closed', () => {
  const original = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  const changed = structuredClone(original);changed.payload.command.patch.title = 'Substitution';
  const otherDomain = { ...original, proof: technicalAssignmentProof(key, 'work-preview', original.payload) };
  for (const value of [changed, otherDomain, { ...original, bypass: true }]) {
    assert.equal(readTechnicalWorkItemPreview(key, Buffer.from(canonicalJson(value)).toString('base64url'), current, now + 1), null);
  }
  assert.equal(readTechnicalWorkItemPreview(key, Buffer.from(JSON.stringify(original, null, 2)).toString('base64url'), current, now + 1), null);
  for (const invalid of [token + '=', '', '!', 'a'.repeat(48_001)]) {
    assert.equal(readTechnicalWorkItemPreview(key, invalid, current, now + 1), null);
  }
  assert.equal(readTechnicalWorkItemPreview({ ...key, secret: 'synthetic-work-item-key-material-18' }, token, current, now + 1), null);
});
test('invalid time or exhausted versions cannot create a new command', () => {
  for (const invalid of [-1, NaN, Infinity, 1.5]) assert.throws(() => createTechnicalWorkItemPreview(key, command, current, invalid));
  assert.throws(() => createTechnicalWorkItemPreview(key, { ...command, expectedItemVersion: 2_147_483_647 },
    { ...current, itemVersion: 2_147_483_647 }, now));
});
test('lost-response receipt is exact and minimized without relying on a still-live assignment', () => {
  assert.deepEqual(readTechnicalWorkItemReceipt(key, receipt, signature, expected, new Date(now + 100)), receipt);
  for (const forbidden of ['title', 'notes', 'description', 'before', 'after', 'documents', 'email']) {
    assert.equal(technicalWorkItemReceipt.safeParse({ ...receipt, [forbidden]: 'private' }).success, false);
  }
  assert.equal(readTechnicalWorkItemReceipt(key, { ...receipt, itemVersion: 9 }, signature, expected, new Date(now + 100)), null);
  assert.equal(technicalWorkItemReceipt.safeParse({ ...receipt, kind: 'ChecklistItem', fieldCount: 3 }).success, false);
});
test('receipt reconciliation cannot disclose a different author/session/command/target or accept a changed request', () => {
  for (const delta of [{ actorId: 'synthetic-tech-b' }, { sessionId: '9a3d8508-2a3e-4be3-91cb-fef73d4da678' },
    { commandId: '47fb59db-c804-48a1-80cd-fe605152a49b' }, { requestDigest: 'f'.repeat(64) },
    { target: { ...current.target, targetId: 'foreign' } }]) {
    assert.equal(readTechnicalWorkItemReceipt(key, receipt, signature, { ...expected, ...delta }, new Date(now + 100)), null);
  }
});
test('future, malformed, changed-key and differently signed receipts do not invent an outcome', () => {
  assert.equal(readTechnicalWorkItemReceipt(key, receipt, signature, expected, new Date(now)), null);
  assert.equal(readTechnicalWorkItemReceipt(key, receipt, signature, expected, new Date(NaN)), null);
  assert.equal(readTechnicalWorkItemReceipt({ ...key, version: 3 }, receipt, signature, expected, new Date(now + 100)), null);
  assert.equal(readTechnicalWorkItemReceipt(key, receipt, 'short', expected, new Date(now + 100)), null);
  assert.equal(readTechnicalWorkItemReceipt(key, receipt, technicalAssignmentProof(key, 'work-receipt', receipt), expected, new Date(now + 100)), null);
});
