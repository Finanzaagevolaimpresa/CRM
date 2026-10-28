import assert from 'node:assert/strict';
import test from 'node:test';
import { admitTechnicalReminderSelection } from '../src/lib/record-reminder-technical-policy';
import { technicalAssignmentPayload } from '../src/lib/technical-assignment-proof';

const contextHash = 'a'.repeat(64), scopeHash = 'b'.repeat(64);
function fixture(recipient = 'synthetic-tech-a') {
  const payload = technicalAssignmentPayload.parse({ protocol: 'TECHNICAL_ASSIGNMENT_V1',
    id: '00000000-0000-4000-8000-000000000001', revision: 2, commandId: '00000000-0000-4000-8000-000000000002',
    targetId: 'synthetic-project-a', selection: { kind: 'Project', userId: recipient, responsibility: 'responsabile',
      actions: ['manage_deadlines'], readableFields: ['title'], editableFields: [], documents: [],
      workItems: [{ kind: 'Task', itemId: 'synthetic-task-a', generation: 3, scopeGeneration: 2,
        scopeSha256: scopeHash, readableFields: ['dueAt'], editableFields: [] }], expiresAt: '2030-11-26T17:00:00.000Z' },
    approvedById: 'synthetic-admin', approvedAt: '2030-10-26T09:00:00.000Z',
    authorityRevision: 2, actorEpoch: 3, recipientEpoch: 4, contextSha256: contextHash, keyVersion: 1 });
  const current = { kind: 'Project' as const, targetId: payload.targetId, taskId: 'synthetic-task-a',
    assignmentId: payload.id, assignmentRevision: payload.revision, journalVerified: true, revoked: false,
    authority: { enabled: true, userId: payload.approvedById, revision: 2, managerEpoch: 3, managerAllowed: true },
    recipient: { id: recipient, epoch: 4, active: true, allowed: true, selectiveCeilingAllows: true },
    contextSha256: contextHash, scopeSha256: scopeHash, scopeGeneration: 2, keyVersion: 1,
    now: new Date('2030-10-27T09:00:00.000Z') };
  return { payload, current };
}
test('two technicians have separate current deadline admissions without a fabricated browser session', () => {
  const first = fixture(), second = fixture('synthetic-tech-b');
  const a = admitTechnicalReminderSelection(first.payload, first.current);
  const b = admitTechnicalReminderSelection(second.payload, second.current);
  assert.ok(a); assert.ok(b); assert.notEqual(a.accessBinding, b.accessBinding);
  assert.equal(Object.hasOwn(first.current, 'sessionLive'), false);
  assert.equal(admitTechnicalReminderSelection(first.payload, second.current), null);
});
test('target title, task title and descriptions are absent from a deadline admission', () => {
  const f = fixture(), result = admitTechnicalReminderSelection(f.payload, f.current);
  assert.deepEqual(Object.keys(result!).sort(), ['accessBinding', 'accessUntil']);
  assert.equal(JSON.stringify(result).includes('synthetic'), false);
});
test('a retained item without explicit dueAt permission cannot receive a reminder', () => {
  const { payload, current } = fixture();
  for (const readableFields of [['title'], ['status'], ['description']]) {
    assert.equal(admitTechnicalReminderSelection({ ...payload, selection: { ...payload.selection,
      workItems: [{ ...payload.selection.workItems![0], readableFields }] } }, current), null);
  }
});
test('record access or another task under the same customer is not enough', () => {
  const { payload, current } = fixture();
  assert.equal(admitTechnicalReminderSelection(payload, { ...current, taskId: 'synthetic-task-b' }), null);
  assert.equal(admitTechnicalReminderSelection(payload, { ...current, targetId: 'synthetic-project-b' }), null);
  assert.equal(admitTechnicalReminderSelection(payload, { ...current, kind: 'TechnicalPractice' }), null);
});
test('two commercial users cannot consume the technical decision', () => {
  const { payload, current } = fixture();
  for (const id of ['synthetic-sales-a', 'synthetic-sales-b']) {
    assert.equal(admitTechnicalReminderSelection(payload, { ...current, recipient: { ...current.recipient, id, allowed: false } }), null);
  }
});
test('lost authority, explicit deny, revocation and an unverified journal fail closed', () => {
  const { payload, current } = fixture();
  for (const patch of [{ revoked: true }, { journalVerified: false }, { assignmentRevision: 3 }, { keyVersion: 2 },
    { contextSha256: 'c'.repeat(64) }, { scopeSha256: 'd'.repeat(64) }, { scopeGeneration: 3 }]) {
    assert.equal(admitTechnicalReminderSelection(payload, { ...current, ...patch }), null);
  }
  for (const patch of [{ enabled: false }, { revision: 3 }, { managerEpoch: 4 }, { managerAllowed: false }, { userId: 'other-admin' }]) {
    assert.equal(admitTechnicalReminderSelection(payload, { ...current, authority: { ...current.authority, ...patch } }), null);
  }
  for (const patch of [{ active: false }, { allowed: false }, { selectiveCeilingAllows: false }, { epoch: 5 }]) {
    assert.equal(admitTechnicalReminderSelection(payload, { ...current, recipient: { ...current.recipient, ...patch } }), null);
  }
});
test('an access expiry exactly at the database instant is already expired', () => {
  const { payload, current } = fixture();
  assert.equal(admitTechnicalReminderSelection(payload, { ...current, now: new Date(payload.selection.expiresAt) }), null);
  assert.equal(admitTechnicalReminderSelection(payload, { ...current, now: new Date('invalid') }), null);
  assert.equal(admitTechnicalReminderSelection(payload, { ...current, now: new Date('2030-10-25') }), null);
});
test('scope A-to-B-to-A cannot reuse the retained task decision', () => {
  const { payload, current } = fixture();
  assert.equal(admitTechnicalReminderSelection(payload, { ...current, scopeGeneration: 4 }), null);
});
test('work content can advance within the existing scope; a new reminder binds its own exact generation', () => {
  const { payload, current } = fixture();
  assert.ok(admitTechnicalReminderSelection(payload, current));
  assert.equal(Object.hasOwn(current, 'generation'), false);
});
test('another action or malformed field widening cannot replace manage_deadlines', () => {
  const { payload, current } = fixture();
  for (const actions of [['request_admin'], ['manage_deadlines', 'dispatch']]) {
    assert.equal(admitTechnicalReminderSelection({ ...payload, selection: { ...payload.selection, actions } }, current), null);
  }
  assert.equal(admitTechnicalReminderSelection({ ...payload, selection: { ...payload.selection,
    workItems: [{ ...payload.selection.workItems![0], readableFields: ['*'] }] } }, current), null);
});
