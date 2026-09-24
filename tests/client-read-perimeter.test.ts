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

for (const role of perimeterRoles) test(`${role}: explicit client scope permits consultation, not operational ownership`, () => {
  const actor = { userId: 'reader', role };
  assert.equal(canViewClient(actor, client), false);
  const granted = { ...actor, clientReadScope: [client.id] };
  assert.equal(canViewClient(granted, client), true);
  assert.equal(canViewClient(granted, { ...client, id: 'foreign' }), false);
  assert.equal(canViewClient(granted, { salesOwnerId: null, consultantId: null }), false);
  assert.equal(canViewProject(granted, project), true);
  assert.equal(canViewService(granted, service), true);
  assert.equal(canViewDocument(granted, document, true), true);
  assert.equal(canViewDocument(granted, document, false), false);
  assert.equal(canViewDocument(granted, { ...document, clientId: 'foreign' }, true), false);
  assert.equal(canViewTechnicalPractice(granted, practice), true);
  assert.equal(canEditClient(granted, client), false);
  assert.equal(canEditProject(granted, project), false);
  assert.equal(canEditService(granted, service), false);
  assert.equal(canEditDocument(granted, document, true), false);
  assert.equal(canEditTechnicalPractice(granted, practice), false);
  assert.equal(canViewLead(granted, { assignedToId: null }), false);
  assert.equal(canViewDocument({ ...granted, clientReadScope: [] }, document, true), false);
});

test('read scope is not a role bypass and does not revoke separate current ownership', () => {
  const unknown = { role: 'unknown' as RoleCode, userId: 'reader', clientReadScope: [client.id] };
  assert.equal(canViewClient(unknown, client), false);
  assert.deepEqual(clientVisibilityWhere(unknown), { id: { in: [] } });
  assert.equal(canViewClient({ role: 'commerciale', userId: 'sales', clientReadScope: [] }, client), true);
  for (const role of ['revisore', 'amministrazione'] as const) {
    assert.deepEqual(clientVisibilityWhere({ role, userId: 'reader' }), { id: { in: [] } });
    assert.deepEqual(clientVisibilityWhere({ role, userId: 'reader', clientReadScope: [client.id, client.id] }), { id: { in: [client.id] } });
  }
});
