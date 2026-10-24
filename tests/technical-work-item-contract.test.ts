import assert from 'node:assert/strict';
import test from 'node:test';
import { technicalImplementedActions, type CurrentTechnicalAssignmentAdmission,
  type TechnicalAssignmentSelection } from '../src/lib/technical-assignment-contract';
import { projectTechnicalWorkItem, technicalWorkItemPatch, technicalWorkItemSelection, technicalWorkItemSelections,
  type TechnicalWorkItemBinding, type TechnicalWorkItemSelection } from '../src/lib/technical-work-item-contract';

const now = new Date('2026-10-23T16:00:00Z');
const target = { kind: 'TechnicalPractice' as const, targetId: 'synthetic-practice-a' };
const assignment: TechnicalAssignmentSelection = { kind: target.kind, userId: 'synthetic-tech-a', responsibility: 'co_responsabile',
  actions: ['manage_checklist', 'manage_deadlines'], readableFields: ['title'], editableFields: [], documents: [],
  workItems: [{ kind:'ChecklistItem',itemId:'synthetic-checklist-a',generation:1,scopeGeneration:1,scopeSha256:'c'.repeat(64),readableFields:['title','status'],editableFields:['title'] },
    { kind:'Task',itemId:'synthetic-task-a',generation:1,scopeGeneration:1,scopeSha256:'c'.repeat(64),readableFields:['title','dueAt','priority'],editableFields:['dueAt','priority'] }],
  expiresAt: '2026-10-24T16:00:00Z' };
const current: CurrentTechnicalAssignmentAdmission = { userId: assignment.userId, role: 'consulente', active: true,
  sessionLive: true, ...target, targetWorkable: true, parentContextValid: true, selectiveCeilingAllows: true,
  currentContextSha256: 'a'.repeat(64), assignmentContextSha256: 'a'.repeat(64), currentRecipientEpoch: 1,
  assignmentRecipientEpoch: 1, currentRevision: 2, assignmentRevision: 2, revoked: false };
const selection: TechnicalWorkItemSelection = { target, itemId: 'synthetic-checklist-a', kind: 'ChecklistItem',
  recipientId: assignment.userId, contextSha256: 'b'.repeat(64), readableFields: ['title', 'status'], editableFields: ['title'] };
const binding: TechnicalWorkItemBinding = { target, itemId: selection.itemId, kind: selection.kind,
  contextSha256: selection.contextSha256, active: true, archived: false, financialRestricted: false };
const row = { title: 'Relazione tecnica', status: 'da_richiedere', notes: 'Non selezionate', clientId: 'synthetic-client',
  contract: 'Privato', amount: 400, documentId: 'unselected-document', fileId: 'unselected-file' };
const projection = (delta: Partial<CurrentTechnicalAssignmentAdmission> = {}) => projectTechnicalWorkItem({ ...current, ...delta }, assignment, selection, binding, row, now);

test('selected checklist fields are usable without disclosing parent IDs, notes, finance or documents', () => {
  assert.deepEqual(projection(), { title: row.title, status: row.status });
  assert.deepEqual(technicalWorkItemPatch(current, assignment, selection, binding, { title: '  Nuova relazione  ' }, now), { title: 'Nuova relazione' });
});
test('a second technician cannot reuse the first personal item choice even with an independent assignment', () => {
  assert.equal(projection({ userId: 'synthetic-tech-b' }), null);
  assert.equal(projectTechnicalWorkItem({ ...current, userId: 'synthetic-tech-b' }, { ...assignment, userId: 'synthetic-tech-b' }, selection, binding, row, now), null);
  assert.deepEqual(projectTechnicalWorkItem({ ...current, userId: 'synthetic-tech-b' }, { ...assignment, userId: 'synthetic-tech-b' },
    { ...selection, recipientId: 'synthetic-tech-b' }, binding, row, now), { title: row.title, status: row.status });
});
test('two sales profiles, a generic Admin and unrelated roles cannot consume a technical item selection', () => {
  for (const [role, userId] of [['commerciale', 'synthetic-sales-a'], ['commerciale', 'synthetic-sales-b'], ['admin', assignment.userId], ['collaboratore_limitato', assignment.userId]]) {
    assert.equal(projection({ role, userId }), null);
  }
});
test('same client, different project or practice is not a target grant; kind substitution is denied', () => {
  assert.equal(projection({ targetId: 'synthetic-practice-b' }), null);
  assert.equal(projection({ kind: 'Project' }), null);
  assert.equal(projectTechnicalWorkItem(current, assignment, selection, { ...binding, target: { ...target, targetId: 'synthetic-practice-b' } }, row, now), null);
  assert.equal(projectTechnicalWorkItem(current, assignment, selection, { ...binding, itemId: 'synthetic-checklist-b' }, row, now), null);
  assert.equal(projectTechnicalWorkItem(current, assignment, selection, { ...binding, kind: 'Task' }, row, now), null);
});
test('revocation, expired session, actor changes, closed target and changed scope deny an already open view', () => {
  for (const delta of [{ revoked: true }, { active: false }, { sessionLive: false }, { targetWorkable: false },
    { parentContextValid: false }, { selectiveCeilingAllows: false }, { currentRecipientEpoch: 2 }, { currentRevision: 3 },
    { currentContextSha256: 'c'.repeat(64) }]) assert.equal(projection(delta), null);
  assert.equal(projectTechnicalWorkItem(current, { ...assignment, expiresAt: now.toISOString() }, selection, binding, row, now), null);
});
test('stale, archived, inactive or financially restricted item bindings fail closed', () => {
  for (const delta of [{ active: false }, { archived: true }, { financialRestricted: true }, { contextSha256: 'c'.repeat(64) }]) {
    assert.equal(projectTechnicalWorkItem(current, assignment, selection, { ...binding, ...delta }, row, now), null);
  }
});
test('a readable target or different operational action does not authorize checklist content', () => {
  assert.equal(projectTechnicalWorkItem(current, { ...assignment, actions: ['request_admin'] }, selection, binding, row, now), null);
  assert.equal(projectTechnicalWorkItem(current, { ...assignment, actions: ['manage_deadlines'] }, selection, binding, row, now), null);
});
test('selected fields missing or malformed in the loaded row deny rather than invent a value', () => {
  for (const data of [{ title: row.title }, { title: null, status: row.status }, { title: '', status: row.status }, { ...row, status: 'sent_to_customer' }]) {
    assert.equal(projectTechnicalWorkItem(current, assignment, selection, binding, data, now), null);
  }
});
test('closed item selections reject broad wildcard, unknown, duplicate, implicit editable or cross-recipient fields', () => {
  for (const data of [{ ...selection, readableFields: ['*'] }, { ...selection, readableFields: ['documentId'] },
    { ...selection, readableFields: ['title', 'title'] }, { ...selection, editableFields: ['notes'] },
    { ...selection, editableFields: ['status'] }, { ...selection, amount: true }]) assert.equal(technicalWorkItemSelection.safeParse(data).success, false);
  assert.equal(technicalWorkItemSelections.safeParse([selection, selection]).success, false);
});
test('mutations cannot assign owners, relink parents/documents, fake states or include inherited/symbol properties', () => {
  const values: unknown[] = [{ notes: 'Not editable' }, { status: 'richiesto' }, { status: 'validato' }, { assignedToId: 'synthetic-tech-b' },
    { clientId: 'foreign' }, { projectId: 'foreign' }, { documentId: 'financial' }, { title: 'Ok', [Symbol('hidden')]: true },
    {}, [], Object.create({ title: 'Inherited' }), JSON.parse('{"__proto__":"change"}')];
  for (const raw of values) assert.equal(technicalWorkItemPatch(current, assignment, selection, binding, raw, now), null);
});
test('deadline fields require separate explicit selection, normalize instants and never expose assignee or private description', () => {
  const picked: TechnicalWorkItemSelection = { ...selection, kind: 'Task', itemId: 'synthetic-task-a',
    readableFields: ['title', 'dueAt', 'priority'], editableFields: ['dueAt', 'priority'] };
  const linked: TechnicalWorkItemBinding = { ...binding, kind: 'Task', itemId: picked.itemId };
  assert.deepEqual(projectTechnicalWorkItem(current, assignment, picked, linked,
    { title: 'Scadenza tecnica', dueAt: '2026-10-25T10:00:00+01:00', priority: 'alta', description: 'Non selezionata', assignedToId: 'foreign' }, now),
    { title: 'Scadenza tecnica', dueAt: '2026-10-25T09:00:00.000Z', priority: 'alta' });
  assert.deepEqual(technicalWorkItemPatch(current, assignment, picked, linked, { dueAt: null }, now), { dueAt: null });
  for (const raw of [{ dueAt: '2026-99-99' }, { dueAt: '' }, { priority: 'critical' }, { status: 'completata' }]) {
    assert.equal(technicalWorkItemPatch(current, assignment, picked, linked, raw, now), null);
  }
});
test('implemented operations remain a closed set with separately profiled upload and no dispatch', () => {
  assert.deepEqual(technicalImplementedActions, ['update_fields', 'update_status', 'request_admin', 'manage_checklist', 'manage_deadlines', 'upload_document']);
});
