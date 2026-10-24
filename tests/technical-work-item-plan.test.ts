import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalSha256 } from '../src/lib/canonical-json';
import { technicalWorkItemContext } from '../src/lib/technical-work-item-context';
import { previewTechnicalWorkItemChange, confirmTechnicalWorkItemChange,
  type LockedTechnicalWorkItemSnapshot } from '../src/lib/technical-work-item-plan';

const now = new Date('2026-10-24T06:00:00Z');
const key = { version: 1, secret: 'synthetic-item-planning-key-material' };
const target = { kind: 'TechnicalPractice' as const, targetId: 'synthetic-practice' };
const parent = { target, clientId: 'synthetic-client', projectId: null, serviceId: 'synthetic-service',
  companyId: null, contextSha256: 'a'.repeat(64), operational: true };
const item = { id: 'synthetic-task', kind: 'Task' as const, clientId: parent.clientId, projectId: null,
  serviceId: parent.serviceId, companyId: null, financialRestricted: false, active: true };
const link = { bindingId: 'b5884229-e5d1-4eab-83bf-762d047cc154', target, itemId: item.id,
  kind: item.kind, revision: 1, retainedPersonalDecision: true };
const context = technicalWorkItemContext(parent, item, link)!;
const selection = { itemId: item.id, target, contextSha256: context.contextSha256,
  recipientId: 'synthetic-tech-a', kind: 'Task' as const,
  readableFields: ['title', 'dueAt'] as ['title', 'dueAt'], editableFields: ['dueAt'] as ['dueAt'] };
const snapshot: LockedTechnicalWorkItemSnapshot = { parent, item, link, selection,
  current: { userId: selection.recipientId, role: 'consulente', active: true, sessionLive: true, ...target,
    targetWorkable: true, parentContextValid: true, selectiveCeilingAllows: true, currentContextSha256: parent.contextSha256,
    assignmentContextSha256: parent.contextSha256, currentRecipientEpoch: 2, assignmentRecipientEpoch: 2,
    currentRevision: 3, assignmentRevision: 3, revoked: false },
  assignment: { kind: target.kind, userId: selection.recipientId, responsibility: 'supporto', actions: ['manage_deadlines'],
    readableFields: ['title'], editableFields: [], documents: [], expiresAt: '2026-10-25T06:00:00Z' },
  admission: { target, actorId: selection.recipientId, sessionId: 'b971b452-5c29-4e06-8934-2a72af6ec2e6',
    assignmentId: 'af10c5e3-a8f9-4bc7-a10a-8211c6891cc2', assignmentRevision: 3,
    assignmentStateSha256: 'b'.repeat(64), authorityRevision: 1, actorEpoch: 2, authorEpoch: 1, keyVersion: 1,
    bindingId: link.bindingId, bindingRevision: 1, kind: item.kind, itemId: item.id,
    contextSha256: context.contextSha256, selectionSha256: canonicalSha256(selection), itemVersion: 5,
    validUntil: now.getTime() + 3600000 },
  row: { id: item.id, version: 5, values: { title: 'Scadenza tecnica', dueAt: '2026-10-26T12:00:00Z',
    description: 'Private unselected text', assignedToId: 'not-a-recipient', amount: 700, documentId: 'private-financial' } },
};
const command = { commandId: '63146064-1b85-44ef-823b-890b65452447',
  assignmentId: snapshot.admission.assignmentId, assignmentRevision: 3, bindingId: link.bindingId, bindingRevision: 1,
  kind: item.kind, itemId: item.id, expectedContextSha256: context.contextSha256, expectedItemVersion: 5,
  action: 'update_fields' as const, patch: { dueAt: '2026-10-27T13:00:00+01:00' } };
const preview = () => previewTechnicalWorkItemChange(key, snapshot, command, now)!;

test('a selected deadline has an exact normalized preview and a bounded change plan without hidden values', () => {
  const p = preview(); assert.ok(p);
  assert.deepEqual(p.before, { dueAt: '2026-10-26T12:00:00.000Z' });
  assert.deepEqual(p.after, { dueAt: '2026-10-27T12:00:00.000Z' });
  const changed = confirmTechnicalWorkItemChange(key, snapshot, p.command, p.token, true, now);
  assert.ok(changed); assert.equal(changed.previousItemVersion, 5); assert.equal(changed.itemVersion, 6);
  assert.equal(snapshot.row.version, 5);
  for (const value of ['Private unselected text', 'Scadenza tecnica', 'private-financial', 'not-a-recipient', '700']) {
    assert.equal(JSON.stringify(changed).includes(value), false);
  }
});
test('confirmation requires the normalized exact proposal and an explicit confirmation', () => {
  const p = preview();
  assert.equal(confirmTechnicalWorkItemChange(key, snapshot, command, p.token, true, now), null);
  assert.equal(confirmTechnicalWorkItemChange(key, snapshot, p.command, p.token, false, now), null);
  assert.equal(confirmTechnicalWorkItemChange(key, snapshot, { ...p.command, patch: { dueAt: null } }, p.token, true, now), null);
});
test('another technician or either commercial profile cannot use the prepared plan', () => {
  const p = preview();
  for (const [role,userId] of [['consulente','synthetic-tech-b'],['commerciale','synthetic-sales-a'],['commerciale','synthetic-sales-b']]) {
    const s = structuredClone(snapshot); s.current.role = role; s.current.userId = userId;
    assert.equal(previewTechnicalWorkItemChange(key, s, command, now), null);
    assert.equal(confirmTechnicalWorkItemChange(key, s, p.command, p.token, true, now), null);
  }
});
test('a different parent, row, version or retained item link is denied after preview', () => {
  const p = preview();
  const changes: Array<(s: LockedTechnicalWorkItemSnapshot) => void> = [
    s => { s.parent.target.targetId = 'another-practice'; },
    s => { s.item.clientId = 'another-client'; },
    s => { s.row.id = 'another-task'; },
    s => { s.row.version++; },
    s => { s.link.revision++; },
    s => { s.link.retainedPersonalDecision = false; },
    s => { s.admission.contextSha256 = 'd'.repeat(64); },
  ];
  for (const mutate of changes) { const s = structuredClone(snapshot); mutate(s);
    assert.equal(confirmTechnicalWorkItemChange(key, s, p.command, p.token, true, now), null); }
});
test('revocation, lifecycle, financial privacy and changed recipient epochs deny all proposals', () => {
  const p = preview();
  const changes: Array<(s: LockedTechnicalWorkItemSnapshot) => void> = [
    s => { s.current.revoked = true; }, s => { s.current.sessionLive = false; },
    s => { s.current.currentRecipientEpoch++; }, s => { s.parent.operational = false; },
    s => { s.item.active = false; }, s => { s.item.financialRestricted = true; },
    s => { s.current.selectiveCeilingAllows = false; },
    s => { s.assignment.expiresAt = now.toISOString(); },
  ];
  for (const mutate of changes) { const s = structuredClone(snapshot); mutate(s);
    assert.equal(confirmTechnicalWorkItemChange(key, s, p.command, p.token, true, now), null); }
});
test('a permission change cannot be hidden by replacing the selection hash', () => {
  const p = preview(); const s = structuredClone(snapshot);
  s.selection.editableFields = []; s.admission.selectionSha256 = canonicalSha256(s.selection);
  assert.equal(confirmTechnicalWorkItemChange(key, s, p.command, p.token, true, now), null);
  const other = structuredClone(snapshot); other.selection.readableFields = ['title'];
  assert.equal(previewTechnicalWorkItemChange(key, other, command, now), null);
});
test('unchanged values, unreadable fields, fake state and document updates do not create a plan', () => {
  for (const patch of [{ dueAt: '2026-10-26T12:00:00.000Z' }, { title: 'Not editable' },
    { status: 'completata' }, { documentId: 'private-financial' }]) {
    assert.equal(previewTechnicalWorkItemChange(key, snapshot, { ...command, patch }, now), null);
  }
});
test('final clock, malformed token and expired preview cannot produce an execution plan', () => {
  const p = preview();
  assert.equal(confirmTechnicalWorkItemChange(key, snapshot, p.command, p.token, true, new Date(now.getTime()+300000)), null);
  assert.equal(confirmTechnicalWorkItemChange(key, snapshot, p.command, 'bad', true, now), null);
  assert.equal(confirmTechnicalWorkItemChange(key, snapshot, p.command, p.token, true, new Date(NaN)), null);
});
