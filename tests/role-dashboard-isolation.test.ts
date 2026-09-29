import assert from 'node:assert/strict';
import test from 'node:test';
import { canEditProject, canEditService, canEditTask, canViewAiOutput, canViewChecklistItem, canViewClient, canViewClientContext, canViewCommercialOffer, canViewDocument, canViewLead, canViewProject, canViewService, canViewTask, canViewTechnicalPractice } from '../src/lib/access-control';
import { hasPermission } from '../src/lib/permission-evaluator';
import { canViewPracticeReadinessWork } from '../src/lib/practice-readiness-access';

const roles = ['commerciale', 'consulente', 'backoffice', 'revisore', 'collaboratore_limitato'] as const;
const client = { id: 'shared-client', salesOwnerId: 'alice', consultantId: 'alice' };
const project = { id: 'project', clientId: client.id, consultantId: 'bob', client };
const service = { id: 'service', clientId: client.id, projectId: project.id, assignedToId: 'bob', client, project };
const task = { clientId: client.id, projectId: project.id, clientServiceId: service.id, assignedToId: 'bob', createdById: 'alice', client, project, clientService: service };
const document = { ...task, uploadedById: 'alice', containsSensitiveData: false, documentCategory: 'altro', type: 'text/plain' };
const checklist = { ...task, updatedById: 'alice' };
const practice = { client, technicalOwnerId: 'bob', commercialOwnerId: null };

test('unassigned practice and readiness inherit service, then project, never sibling client ownership', () => {
  const alice = { userId: 'alice', role: 'consulente' as const }, bob = { ...alice, userId: 'bob' };
  const linked = { clientId: client.id, client, projectId: project.id, project, clientServiceId: service.id, clientService: service };
  const lead = { clientId: client.id, assignedToId: 'alice' };
  for (const context of [linked, { ...linked, clientServiceId: null, clientService: null }]) {
    assert.equal(canViewTechnicalPractice(alice, context), false);
    assert.equal(canViewTechnicalPractice(bob, context), true);
    assert.equal(canViewPracticeReadinessWork(alice, { ...context, lead }), false);
    assert.equal(canViewPracticeReadinessWork(bob, { ...context, lead }), true);
  }
  const reassigned = { ...linked, clientService: { ...service, assignedToId: 'alice' } };
  assert.equal(canViewTechnicalPractice(alice, reassigned), true);
  assert.equal(canViewTechnicalPractice(bob, reassigned), false);
  assert.equal(canViewPracticeReadinessWork(bob, { ...reassigned, lead }), false);
  assert.equal(canViewTechnicalPractice(bob, { ...linked, project: null }), false);
  assert.equal(canViewTechnicalPractice(alice, { ...linked, technicalOwnerId: 'alice' }), true);
  assert.equal(canViewPracticeReadinessWork(alice, { client, lead }), true);
  assert.equal(canViewPracticeReadinessWork(bob, { client, lead }), false);
});

for (const role of roles) test(`${role}: owning or sharing a client never overrides another individual's assignment`, () => {
  const actor = { role, userId: 'alice', clientReadScope: [client.id] };
  assert.equal(canViewClient(actor, client), true);
  assert.equal(canViewLead(actor, { assignedToId: 'bob' }), false);
  assert.equal(canViewProject(actor, project), false);
  assert.equal(canEditProject(actor, project), false);
  assert.equal(canViewService(actor, service), false);
  assert.equal(canEditService(actor, service), false);
  assert.equal(canViewTask(actor, task), false);
  assert.equal(canEditTask(actor, task), false);
  assert.equal(canViewDocument(actor, document), false);
  assert.equal(canViewChecklistItem(actor, checklist), false);
  assert.equal(canViewTechnicalPractice(actor, practice), false);
  assert.equal(canViewCommercialOffer(actor, { clientId: client.id, leadId: 'lead', createdById: 'alice', client, lead: { assignedToId: 'bob', clientId: client.id } }), false);
  assert.equal(canViewClientContext(actor, { ...task, clientService: { ...service, project: { ...project, consultantId: 'alice' } }, project: { ...project, consultantId: 'alice' } }), false);
  assert.equal(canViewClientContext(actor, { clientId: client.id, client, createdById: 'bob' }), false);
  const run = { clientId: client.id, projectId: null, clientServiceId: null, createdById: 'bob' };
  assert.equal(canViewAiOutput(actor, { ...run, run, client }), false);
  assert.equal(canViewService(actor, { ...service, assignedToId: 'alice' }), true);
  assert.equal(canViewTask(actor, { ...task, assignedToId: 'alice' }), true);
  assert.equal(canViewService(actor, { ...service, assignedToId: 'alice', client: { ...client, id: 'foreign' } }), false);
});

for (const role of ['admin', 'direzione', 'amministrazione'] as const) test(`${role}: global read supervision preserves independent function and sensitive-data permissions`, () => {
  const actor = { role, userId: 'supervisor', active: true, permissionOverrides: [] };
  assert.equal(canViewClient(actor, client), true);
  assert.equal(canViewLead(actor, { assignedToId: null }), true);
  assert.equal(canViewProject(actor, project), true);
  assert.equal(canViewService(actor, service), true);
  assert.equal(canViewTask(actor, task), true);
  assert.equal(canViewTechnicalPractice(actor, practice), true);
  assert.equal(canViewDocument(actor, { ...document, containsSensitiveData: true }, false), false);
  assert.equal(canViewDocument(actor, { ...document, containsSensitiveData: true }, true), true);
  if (role === 'amministrazione') {
    assert.equal(canEditProject(actor, project), false);
    assert.equal(canEditService(actor, service), false);
    assert.equal(canEditTask(actor, task), false);
    assert.equal(hasPermission(actor, 'user.write'), false);
    assert.equal(hasPermission(actor, 'ai.approve'), false);
  }
});
