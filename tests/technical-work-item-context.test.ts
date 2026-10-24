import assert from 'node:assert/strict';
import test from 'node:test';
import { technicalWorkItemContext, type TechnicalWorkItemContextLink, type TechnicalWorkItemParent,
  type TechnicalWorkItemRowContext } from '../src/lib/technical-work-item-context';

const parent: TechnicalWorkItemParent = { target: { kind: 'TechnicalPractice', targetId: 'synthetic-practice-a' },
  clientId: 'synthetic-client', projectId: 'synthetic-project', serviceId: 'synthetic-service', companyId: 'synthetic-company',
  contextSha256: 'a'.repeat(64), operational: true };
const item: TechnicalWorkItemRowContext = { id: 'synthetic-task', kind: 'Task', clientId: parent.clientId,
  projectId: parent.projectId, serviceId: null, companyId: null, financialRestricted: false, active: true, scopeGeneration: 1 };
const link: TechnicalWorkItemContextLink = { bindingId: '0b848791-bf2b-4ec8-9220-d887c79e0f28', target: parent.target,
  itemId: item.id, kind: item.kind, revision: 1, retainedPersonalDecision: true, itemScopeGeneration: 1 };

test('explicit binding permits an exact technical item without inventing source links or returning parent metadata', () => {
  const before = JSON.stringify(item), result = technicalWorkItemContext(parent, item, link);
  assert.ok(result);assert.equal(JSON.stringify(item), before);
  assert.deepEqual(Object.keys(result).sort(), ['bindingId', 'contextSha256', 'itemId', 'kind', 'target']);
  assert.equal(technicalWorkItemContext(parent, item, { ...link, retainedPersonalDecision: false }), null);
});
test('another practice under the same client, project and service is still a different target', () => {
  assert.equal(technicalWorkItemContext({ ...parent, target: { ...parent.target, targetId: 'synthetic-practice-b' } }, item, link), null);
});
test('foreign client, project, service, company and item kind are each denied independently', () => {
  for (const delta of [{ clientId: 'foreign' }, { projectId: 'foreign' }, { serviceId: 'foreign' }, { companyId: 'foreign' },
    { id: 'foreign' }, { kind: 'ChecklistItem' as const }]) assert.equal(technicalWorkItemContext(parent, { ...item, ...delta }, link), null);
});
test('lifecycle and financial constraints remain effective after an earlier personal link', () => {
  assert.equal(technicalWorkItemContext({ ...parent, operational: false }, item, link), null);
  assert.equal(technicalWorkItemContext(parent, { ...item, financialRestricted: true }, link), null);
  assert.equal(technicalWorkItemContext(parent, { ...item, active: false }, link), null);
});
test('context or retained binding revision changes invalidate the prior selection hash', () => {
  const before = technicalWorkItemContext(parent, item, link)!;
  assert.notEqual(technicalWorkItemContext({ ...parent, contextSha256: 'b'.repeat(64) }, item, link)!.contextSha256, before.contextSha256);
  assert.notEqual(technicalWorkItemContext(parent, item, { ...link, revision: 2 })!.contextSha256, before.contextSha256);
  assert.notEqual(technicalWorkItemContext(parent, { ...item, serviceId: parent.serviceId }, link)!.contextSha256, before.contextSha256);
});
test('project binding must name the same project and cannot use a practice link with the same string ID', () => {
  const project: TechnicalWorkItemParent = { ...parent, target: { kind: 'Project', targetId: parent.projectId! } };
  assert.ok(technicalWorkItemContext(project, item, { ...link, target: project.target }));
  assert.equal(technicalWorkItemContext({ ...project, projectId: 'foreign' }, item, { ...link, target: project.target }), null);
  assert.equal(technicalWorkItemContext(project, item, { ...link, target: { ...project.target, kind: 'TechnicalPractice' } }), null);
});

test('restored relationships or a reused identity cannot resurrect a prior retained link', () => {
  const restored = { ...item, scopeGeneration: 3 };
  assert.equal(technicalWorkItemContext(parent, restored, link), null);
  const renewed = technicalWorkItemContext(parent, restored, { ...link, revision: 2, itemScopeGeneration: 3 });
  assert.ok(renewed);
  assert.notEqual(renewed.contextSha256, technicalWorkItemContext(parent, item, link)!.contextSha256);
});
