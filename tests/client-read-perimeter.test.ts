import assert from 'node:assert/strict';
import test from 'node:test';
import type { RoleCode } from '@prisma/client';
import { perimeterRoles } from '../src/lib/client-read-perimeter-policy';
import { canViewClient, canViewProject, canViewService, canViewDocument, canViewTechnicalPractice, canEditClient, canEditProject, canEditService, canEditDocument, canEditTechnicalPractice, canViewLead } from '../src/lib/access-control';
import { clientVisibilityWhere } from '../src/lib/core-query-policy';

const client = { id: 'shared', salesOwnerId: 'sales', consultantId: 'technical' };
const project = { id: 'project', clientId: client.id, consultantId: null, client };
const service = { id: 'service', clientId: client.id, projectId: project.id, assignedToId: null, client, project };
const document = { clientId: client.id, projectId: project.id, clientServiceId: service.id, uploadedById: 'uploader', containsSensitiveData: true, type: 'text/plain', documentCategory: 'altro', client, project, clientService: service };
const practice = { client, commercialOwnerId: null, technicalOwnerId: null };

for (const role of perimeterRoles) test(`${role}: client profile scope does not expose other assignments or grant writes`, () => {
  const actor = { userId: 'reader', role };
  const supervisor = role === 'amministrazione';
  assert.equal(canViewClient(actor, client), supervisor);
  const granted = { ...actor, clientReadScope: [client.id] };
  assert.equal(canViewClient(granted, client), true);
  assert.equal(canViewClient(granted, { ...client, id: 'foreign' }), supervisor);
  assert.equal(canViewClient(granted, { salesOwnerId: null, consultantId: null }), supervisor);
  assert.equal(canViewProject(granted, project), supervisor);
  assert.equal(canViewService(granted, service), supervisor);
  assert.equal(canViewDocument(granted, document, true), supervisor);
  assert.equal(canViewDocument(granted, document, false), false);
  assert.equal(canViewDocument(granted, { ...document, clientId: 'foreign' }, true), false);
  assert.equal(canViewTechnicalPractice(granted, practice), supervisor);
  assert.equal(canEditClient(granted, client), false);
  assert.equal(canEditProject(granted, project), false);
  assert.equal(canEditService(granted, service), false);
  assert.equal(canEditDocument(granted, document, true), false);
  assert.equal(canEditTechnicalPractice(granted, practice), false);
  assert.equal(canViewLead(granted, { assignedToId: null }), supervisor);
  assert.equal(canViewDocument({ ...granted, clientReadScope: [] }, document, true), supervisor);
});

test('read scope is not a role bypass and does not revoke separate current ownership', () => {
  const unknown = { role: 'unknown' as RoleCode, userId: 'reader', clientReadScope: [client.id] };
  assert.equal(canViewClient(unknown, client), false);
  assert.deepEqual(clientVisibilityWhere(unknown), { id: { in: [] } });
  assert.equal(canViewClient({ role: 'commerciale', userId: 'sales', clientReadScope: [] }, client), true);
  for (const role of ['revisore'] as const) {
    assert.deepEqual(clientVisibilityWhere({ role, userId: 'reader' }), { id: { in: [] } });
    assert.deepEqual(clientVisibilityWhere({ role, userId: 'reader', clientReadScope: [client.id, client.id] }), { id: { in: [client.id] } });
  }
  assert.deepEqual(clientVisibilityWhere({ role: 'amministrazione', userId: 'reader' }), {});
});
