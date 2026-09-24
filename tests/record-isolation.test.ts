import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RoleCode } from '@prisma/client';
import {
  canEditChecklistItem, canEditDocument, canEditTask, canEditTechnicalPractice,
  canViewChecklistItem, canViewClient, canViewCommercialOffer, canViewDocument,
  canViewProject, canViewService, canViewTask, canViewTechnicalPractice,
} from '../src/lib/access-control';
import { buildNotificationAccess } from '../src/lib/internal-notification-policy';

const roles = ['commerciale', 'consulente', 'backoffice'] satisfies RoleCode[];
function context(owner: string) {
  const client = { id: 'client', salesOwnerId: owner, consultantId: owner, deletedAt: null };
  const project = { id: 'project', clientId: client.id, consultantId: null, deletedAt: null, client };
  const service = { id: 'service', clientId: client.id, projectId: project.id, assignedToId: null, deletedAt: null, client, project };
  const parents = { clientId: client.id, projectId: project.id, clientServiceId: service.id, client, project, clientService: service };
  const task = { ...parents, assignedToId: null, createdById: 'previous' };
  const checklist = { ...parents, createdById: 'previous', updatedById: 'previous' };
  const document = { ...parents, uploadedById: 'previous', containsSensitiveData: true, documentCategory: 'altro', type: 'documento' };
  const offer = { clientId: client.id, leadId: null, client, createdById: 'previous' };
  const practice = { id: 'practice', ...parents, commercialOwnerId: null, technicalOwnerId: null, deletedAt: null };
  return { client, project, service, task, checklist, document, offer, practice };
}

for (const role of roles) test(`${role}: client reassignment revokes historical creator/uploader access`, () => {
  const actor = { userId: 'previous', role };
  for (const owner of ['previous', 'replacement']) {
    const c = context(owner), allowed = owner === actor.userId;
    assert.equal(canViewClient(actor, c.client), allowed);
    assert.equal(canViewProject(actor, c.project), allowed);
    assert.equal(canViewService(actor, c.service), allowed);
    assert.equal(canViewTask(actor, c.task), allowed);
    assert.equal(canEditTask(actor, c.task), allowed);
    assert.equal(canViewChecklistItem(actor, c.checklist), allowed);
    assert.equal(canEditChecklistItem(actor, c.checklist), allowed && role !== 'commerciale');
    assert.equal(canViewDocument(actor, c.document, true), allowed);
    assert.equal(canEditDocument(actor, { ...c.document, project: null, clientService: null }, true), allowed);
    assert.equal(canViewDocument(actor, c.document, false), false, 'sensitive permission is independently required');
    assert.equal(canViewCommercialOffer(actor, c.offer), allowed);
    assert.equal(canViewTechnicalPractice(actor, c.practice), allowed);
  }
});

test('an explicit current assignment remains a grant, while personal provenance cannot defeat it', () => {
  const actor = { userId: 'previous', role: 'backoffice' as const };
  const c = context('replacement');
  assert.equal(canViewTask(actor, { ...c.task, assignedToId: actor.userId }), true);
  assert.equal(canViewService(actor, { ...c.service, assignedToId: actor.userId }), true);
  assert.equal(canViewTechnicalPractice(actor, { ...c.practice, technicalOwnerId: actor.userId }), true);
  assert.equal(canEditTechnicalPractice(actor, { technicalOwnerId: actor.userId }), true);
  assert.equal(canEditTechnicalPractice(actor, { technicalOwnerId: 'replacement' }), false);
  const personal = { clientId: null, assignedToId: null, createdById: actor.userId };
  assert.equal(canViewTask(actor, personal), true);
  assert.equal(canEditTask(actor, personal), true);
  assert.equal(canViewTask(actor, { ...personal, assignedToId: 'replacement' }), false);
  assert.equal(canEditTask(actor, { ...personal, assignedToId: 'replacement' }), false);
  const personalDocument = { ...c.document, clientId: null, projectId: null, clientServiceId: null, client: null, project: null, clientService: null };
  assert.equal(canViewDocument(actor, personalDocument, true), true);
  assert.equal(canViewDocument({ ...actor, userId: 'other' }, personalDocument, true), false);
});

test('service-linked documents inherit the current project assignment without a redundant document projectId', () => {
  const actor = { userId: 'previous', role: 'backoffice' as const }, c = context('replacement');
  const project = { ...c.project, consultantId: actor.userId };
  const service = { ...c.service, project };
  const document = { ...c.document, projectId: null, project: null, clientService: service };
  assert.equal(canViewClient(actor, c.client), false);
  assert.equal(canViewService(actor, service), true);
  assert.equal(canViewDocument(actor, document, true), true);
  assert.equal(canViewDocument(actor, document, false), false);
  assert.equal(canViewDocument(actor, { ...document, clientService: { ...service, project: c.project } }, true), false);
  assert.equal(canViewDocument(actor, { ...document, clientService: { ...service, project: null } }, true), false);
  assert.equal(canViewDocument(actor, { ...document, clientService: { ...service, project: { ...project, clientId: 'foreign' } } }, true), false);
});

for (const role of roles) test(`${role}: notification access uses current bindings and rejects stale snapshots`, () => {
  const actor = { userId: 'previous', role };
  for (const owner of ['previous', 'replacement']) {
    const c = context(owner), allowed = owner === actor.userId;
    const access = buildNotificationAccess(actor, {
      clients: [c.client], projects: [c.project], services: [c.service], practices: [c.practice], leads: [],
    });
    const communication = { technicalPracticeId: c.practice.id, clientId: c.client.id, projectId: c.project.id,
      clientServiceId: c.service.id, commercialOwnerId: actor.userId, technicalOwnerId: actor.userId, createdById: actor.userId };
    assert.equal(access.canViewTask(c.task), allowed);
    assert.equal(access.canViewOffer(c.offer), allowed);
    assert.equal(access.canViewCommunication(communication), allowed);
    assert.deepEqual(access.practiceIds, allowed ? [c.practice.id] : []);
    assert.equal(access.canViewCommunication({ ...communication, projectId: null }), false);
    assert.equal(access.canViewCommunication({ ...communication, clientId: 'other' }), false);
  }
});

test('notification scope closes when a parent is archived, missing or inconsistent', () => {
  const c = context('previous'), actor = { userId: 'previous', role: 'consulente' as const };
  for (const clients of [[], [{ ...c.client, deletedAt: new Date() }]]) {
    const access = buildNotificationAccess(actor, { clients, projects: [c.project], services: [c.service], practices: [c.practice], leads: [] });
    assert.equal(access.canViewTask(c.task), false);
    assert.equal(access.canViewOffer(c.offer), false);
    assert.deepEqual(access.practiceIds, []);
  }
  const access = buildNotificationAccess(actor, { clients: [c.client], projects: [{ ...c.project, clientId: 'other' }], services: [c.service], practices: [c.practice], leads: [] });
  assert.equal(access.canViewTask(c.task), false);
  assert.deepEqual(access.practiceIds, []);
});
