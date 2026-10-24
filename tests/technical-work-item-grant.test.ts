import assert from 'node:assert/strict';
import test from 'node:test';
import { technicalAssignmentSelection } from '../src/lib/technical-assignment-contract';
import { technicalWorkItemGrants } from '../src/lib/technical-work-item-grant';
import { canonicalJson } from '../src/lib/canonical-json';
import { canViewTask, canEditTask, canViewChecklistItem, canEditChecklistItem } from '../src/lib/access-control';

const legacy = { kind: 'Project', userId: 'synthetic-tech', responsibility: 'supporto', actions: ['request_admin'],
  readableFields: ['title'], editableFields: [], expiresAt: '2026-11-01T12:00:00Z', documents: [] };
const item = { kind: 'Task', itemId: 'synthetic-task', generation: 4, scopeGeneration: 2,
  scopeSha256: 'b'.repeat(64), readableFields: ['title', 'dueAt'], editableFields: ['dueAt'] };
test('legacy personal payload canonical bytes do not gain new default fields', () => {
  assert.equal(canonicalJson(technicalAssignmentSelection.parse(legacy)), canonicalJson(legacy));
});
test('deadline and checklist actions need distinct explicit selections, not a parent grant', () => {
  assert.equal(technicalAssignmentSelection.safeParse({ ...legacy, actions: ['manage_deadlines'] }).success, false);
  assert.equal(technicalAssignmentSelection.safeParse({ ...legacy, workItems: [item] }).success, false);
  assert.equal(technicalAssignmentSelection.safeParse({ ...legacy, actions: ['manage_checklist'], workItems: [item] }).success, false);
  assert.equal(technicalAssignmentSelection.safeParse({ ...legacy, actions: ['manage_deadlines'], workItems: [item] }).success, true);
});
test('each item forbids duplicates, unselected edits, impossible generations and unknown fields', () => {
  for (const value of [[item, item], [{ ...item, scopeGeneration: 5 }], [{ ...item, editableFields: ['description'] }],
    [{ ...item, readableFields: ['documentId'] }], [{ ...item, editableFields: ['status'] }], [{ ...item, assignedToId: 'someone' }]]) {
    assert.equal(technicalWorkItemGrants.safeParse(value).success, false);
  }
});
test('a retained item restriction defeats ordinary self-assignment after a target moves or a grant is revoked', () => {
  const actor = { id: 'synthetic-tech', role: 'consulente' as const, technicalTaskIds: [item.itemId], technicalChecklistIds: ['synthetic-check'] };
  const client = { id: 'new-client', salesOwnerId: null, consultantId: actor.id };
  const task = { id: item.itemId, clientId: client.id, assignedToId: actor.id, createdById: actor.id, client };
  const checklist = { id: 'synthetic-check', title: 'Relazione', clientId: client.id, createdById: actor.id, updatedById: actor.id, client };
  assert.equal(canViewTask(actor, task), false); assert.equal(canEditTask(actor, task), false);
  assert.equal(canViewChecklistItem(actor, checklist), false); assert.equal(canEditChecklistItem(actor, checklist), false);
  assert.equal(canViewTask(actor, { ...task, id: undefined }), false);
  assert.equal(canViewChecklistItem(actor, { ...checklist, id: undefined }), false);
});
