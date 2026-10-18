import assert from 'node:assert/strict';
import test from 'node:test';
import { canAssignService, canEditChecklistItem, canEditClient, canEditCommercialOffer,
  canEditDocument, canEditProject, canEditService, canEditTask, canEditTechnicalPractice,
  canViewAiOutput, canViewChecklistItem, canViewClient, canViewClientContext,
  canViewCommercialOffer, canViewDocument, canViewProject, canViewService, canViewTask,
  canViewTechnicalPractice, type Actor } from '../src/lib/access-control';

const admin = { userId: 'synthetic-recipient', role: 'admin' } satisfies Actor;
const selected: Actor = { ...admin, selectiveClientIds: ['selected-client'] };
function context(clientId = 'selected-client') {
  const client = { id: clientId, salesOwnerId: admin.userId, consultantId: admin.userId };
  const project = { id: 'synthetic-project', clientId, consultantId: admin.userId, client };
  const clientService = { id: 'synthetic-service', clientId, projectId: project.id,
    assignedToId: admin.userId, client, project };
  return { clientId, client, project, clientService, projectId: project.id, clientServiceId: clientService.id };
}

test('client selection overrides global supervision, ownership and an existing full-client read grant', () => {
  const { client } = context();
  for (const role of ['admin', 'direzione', 'amministrazione', 'commerciale', 'consulente', 'backoffice', 'revisore'] as const) {
    const actor = { userId: admin.userId, role, clientReadScope: [client.id] };
    assert.equal(canViewClient(actor, client), true, role);
    assert.equal(canViewClient({ ...actor, selectiveClientIds: [client.id] }, client), false, role);
  }
  assert.equal(canEditClient(admin, client), true);
  assert.equal(canEditClient(selected, client), false);
  assert.equal(canViewClient(selected, { salesOwnerId: admin.userId, consultantId: admin.userId }), false);
  assert.equal(canEditClient(selected, { salesOwnerId: admin.userId, consultantId: admin.userId }), false);
});

test('client restriction closes linked ordinary operations even for an assigned Admin recipient', () => {
  const ctx = context();
  const task = { ...ctx, assignedToId: admin.userId, createdById: admin.userId };
  const document = { ...ctx, uploadedById: admin.userId, containsSensitiveData: false, documentCategory: 'altro', type: 'documento' };
  const checklist = { ...ctx, createdById: admin.userId, updatedById: admin.userId };
  const practice = { ...ctx, technicalOwnerId: admin.userId, commercialOwnerId: admin.userId };
  const checks: Array<[string, (actor: Actor) => boolean]> = [
    ['project read', actor => canViewProject(actor, ctx.project)],
    ['project edit', actor => canEditProject(actor, ctx.project)],
    ['service read', actor => canViewService(actor, ctx.clientService)],
    ['service edit', actor => canEditService(actor, ctx.clientService)],
    ['service assign', actor => canAssignService(actor, ctx.clientService)],
    ['context', actor => canViewClientContext(actor, ctx)],
    ['document read', actor => canViewDocument(actor, document)],
    ['document edit', actor => canEditDocument(actor, document)],
    ['task read', actor => canViewTask(actor, task)],
    ['task edit', actor => canEditTask(actor, task)],
    ['checklist read', actor => canViewChecklistItem(actor, checklist)],
    ['checklist edit', actor => canEditChecklistItem(actor, checklist)],
    ['practice read', actor => canViewTechnicalPractice(actor, practice)],
    ['practice edit', actor => canEditTechnicalPractice(actor, practice)],
    ['AI output', actor => canViewAiOutput(actor, { ...ctx, run: { clientId: ctx.clientId,
      projectId: ctx.projectId, clientServiceId: ctx.clientServiceId, createdById: admin.userId } })],
  ];
  for (const [name, check] of checks) {
    assert.equal(check(admin), true, `ordinary admission: ${name}`);
    assert.equal(check(selected), false, `selected exclusion: ${name}`);
  }
});

test('an offer cannot expose the selected client through a lead or direct relationship', () => {
  const ctx = context();
  for (const offer of [
    { id: 'offer-client', clientId: ctx.clientId, client: ctx.client },
    { id: 'offer-lead', leadId: 'synthetic-lead', lead: { assignedToId: admin.userId, clientId: ctx.clientId } },
  ]) {
    assert.equal(canViewCommercialOffer(admin, offer), true);
    assert.equal(canEditCommercialOffer(admin, offer), true);
    assert.equal(canViewCommercialOffer(selected, offer), false);
    assert.equal(canEditCommercialOffer(selected, offer), false);
  }
});

test('unrelated client contexts keep their ordinary permissions', () => {
  const ctx = context('unrelated-client');
  assert.equal(canViewClient(selected, ctx.client), true);
  assert.equal(canEditClient(selected, ctx.client), true);
  assert.equal(canViewProject(selected, ctx.project), true);
  assert.equal(canViewService(selected, ctx.clientService), true);
  assert.equal(canAssignService(selected, ctx.clientService), true);
  assert.equal(canViewClientContext(selected, ctx), true);
});

test('a contradictory outer client does not hide a restricted technical-practice context', () => {
  const inner = context();
  const mixed = { ...inner, clientId: 'unrelated-client', technicalOwnerId: admin.userId };
  assert.equal(canEditTechnicalPractice(selected, mixed), false);
  assert.equal(canViewClientContext(selected, mixed), false);
  assert.equal(canAssignService(selected, { ...inner.clientService, clientId: 'unrelated-client' }), false);
});
