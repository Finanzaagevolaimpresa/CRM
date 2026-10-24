import assert from 'node:assert/strict';
import test from 'node:test';
import { canViewProject, canViewService, canViewDocument, canEditProject, canAssignService, canViewTask, canViewTechnicalPractice, canEditTechnicalPractice } from '../src/lib/access-control';
import { projectFieldProjection, selectiveSelectionSchema, hasSelectiveContext, selectiveAuditAllowed } from '../src/lib/selective-project-policy';
import { selectiveProof, verifySelectiveProof } from '../src/lib/selective-project-proof';

const client = { id: 'client', salesOwnerId: 'recipient', consultantId: 'recipient' };
const project = { id: 'project', clientId: client.id, consultantId: 'recipient', client };
const service = { id: 'service', projectId: project.id, clientId: client.id, assignedToId: 'recipient', project, client };
const scope = { selectiveProjectIds: [project.id], selectiveServiceIds: [service.id], selectiveDocumentIds: ['document'], selectiveAuditEntityIds: ['project', 'document'] };
test('selection limits Admin, assignments, client grants and permission overrides before legacy predicates', () => {
  for (const role of ['admin', 'direzione', 'commerciale', 'consulente', 'backoffice', 'revisore', 'amministrazione', 'collaboratore_limitato'] as const) {
    const actor = { userId: 'recipient', role, active: true, permissionOverrides: [{ permission: 'project.write', allowed: true }], clientReadScope: ['client'], ...scope };
    assert.equal(canViewProject(actor, project), false);
    assert.equal(canEditProject(actor, project), false);
    assert.equal(canViewService(actor, service), false);
    assert.equal(canAssignService(actor, service), false);
    assert.equal(canViewDocument(actor, { id: 'document', projectId: project.id, clientServiceId: service.id, clientId: client.id, uploadedById: actor.userId,
      containsSensitiveData: false, visibilityLevel: 'interno', documentCategory: 'altro', type: 'text/plain', project, client, clientService: service } as Parameters<typeof canViewDocument>[1]), false);
    assert.equal(canViewTask(actor, { assignedToId: actor.userId, createdById: actor.userId, clientId: client.id, project, client }), false);
    assert.equal(canViewTechnicalPractice(actor, { clientId: client.id, client, project, technicalOwnerId: actor.userId }), false);
    assert.equal(canEditTechnicalPractice(actor, { projectId: project.id, technicalOwnerId: actor.userId }), false);
    assert.equal(canEditTechnicalPractice(actor, { projectId: null, clientService: service, technicalOwnerId: actor.userId }), false);
  }
  assert.equal(canViewProject({ userId: 'recipient', role: 'admin', ...scope }, { ...project, id: 'other-project' }), true);
});
test('closed field catalogue rejects future fields, writes and duplicate versions', () => {
  const input = { projectId: 'p', recipientId: 'u', revision: 0, fields: ['title'], documents: [{ versionId: 'v1', download: false }], expiresAt: null };
  assert.equal(selectiveSelectionSchema.safeParse(input).success, true);
  for (const change of [{ fields: ['scenarioA'] }, { fields: ['privateNotes'] }, { edit: true }, { documents: [...input.documents, ...input.documents] }]) {
    assert.equal(selectiveSelectionSchema.safeParse({ ...input, ...change }).success, false);
  }
  assert.deepEqual(projectFieldProjection({ title: 'Selected', description: 'Hidden', future: 'Hidden', scenarioA: 'Private' }, ['title']), [{ key: 'title', label: 'Titolo', value: 'Selected' }]);
});
test('indirect service context and audit snapshots cannot restore restricted information', () => {
  assert.equal(hasSelectiveContext(scope, { clientServiceId: 'service' }), true);
  assert.equal(selectiveAuditAllowed(scope, { entityId: 'document', after: { fileName: 'excluded' } }), false);
  assert.equal(selectiveAuditAllowed(scope, { after: { before: { projectId: 'project', privateNote: 'excluded' } } }), false);
  assert.equal(selectiveAuditAllowed(scope, { entityId: 'unrelated', after: { safe: true } }), true);
});
test('domain separated proofs bind the exact selection, key and purpose', () => {
  const key = { version: 1, secret: 'synthetic-key-for-unit-tests-only-000000' }, value = { projectId: 'p', revision: 1, fields: ['title'] };
  const proof = selectiveProof(key, 'preview', value);
  assert.equal(verifySelectiveProof(key, 'preview', value, proof), true);
  assert.equal(verifySelectiveProof(key, 'grant', value, proof), false);
  assert.equal(verifySelectiveProof(key, 'preview', { ...value, fields: ['title', 'description'] }, proof), false);
  assert.equal(verifySelectiveProof({ ...key, version: 2 }, 'preview', value, proof), false);
  assert.equal(verifySelectiveProof(key, 'preview', value, '0'.repeat(64)), false);
});
