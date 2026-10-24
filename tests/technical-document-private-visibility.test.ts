import assert from 'node:assert/strict';
import test from 'node:test';
import type { RoleCode } from '@prisma/client';
import { canEditDocument, canViewDocument } from '../src/lib/access-control';
import { ordinaryDocumentCountsByClient, technicalDocumentPrivateVisibility } from '../src/lib/technical-document-visibility';

const client = { id: 'client_a', salesOwnerId: 'person_a', consultantId: 'person_a' };
const project = { id: 'project_a', clientId: client.id, consultantId: 'person_a', client };
const document = { clientId: client.id, projectId: project.id, clientServiceId: null,
  uploadedById: 'person_a', containsSensitiveData: false, documentCategory: 'altro', type: 'documento',
  visibilityLevel: 'interno', client, project, clientService: null };

test('ordinary roles, uploader provenance and project responsibility never disclose a private acquisition', () => {
  for (const role of ['admin', 'direzione', 'amministrazione', 'commerciale', 'consulente', 'backoffice', 'revisore', 'collaboratore_limitato'] satisfies RoleCode[]) {
    for (const userId of ['person_a', 'person_b']) {
      const actor = { role, userId };
      assert.equal(canViewDocument(actor, { ...document, visibilityLevel: technicalDocumentPrivateVisibility }, true), false);
      assert.equal(canEditDocument(actor, { ...document, visibilityLevel: technicalDocumentPrivateVisibility }, true), false);
    }
  }
  assert.equal(canViewDocument({ role: 'admin', userId: 'person_b' }, document), true);
  assert.equal(canViewDocument({ role: 'consulente', userId: 'person_a' }, document), true);
  assert.equal(canViewDocument({ role: 'consulente', userId: 'person_b' }, document), false);
  assert.equal(canEditDocument({ role: 'admin', userId: 'person_b' }, document), true);
  assert.equal(canEditDocument({ role: 'consulente', userId: 'person_a' }, document), true);
});

test('missing or future technical visibility cannot fall back to ordinary global access', () => {
  for (const visibilityLevel of ['', 'technical_admin_private_v2', 'technical_unknown']) {
    assert.equal(canViewDocument({ role: 'admin', userId: 'person_a' }, { ...document, visibilityLevel }, true), false);
    assert.equal(canEditDocument({ role: 'admin', userId: 'person_a' }, { ...document, visibilityLevel }, true), false);
  }
  const { visibilityLevel: omitted, ...withoutVisibility } = document;
  assert.equal(omitted, 'interno');
  // Runtime defence must cover an incomplete projection even though TS forbids it.
  assert.equal(canViewDocument({ role: 'admin', userId: 'person_a' }, withoutVisibility as typeof document, true), false);
  assert.equal(canEditDocument({ role: 'admin', userId: 'person_a' }, withoutVisibility as typeof document, true), false);
});

test('client counters do not reveal private acquisitions and retain distinct ordinary groups', () => {
  const group = (clientId: string | null, visibilityLevel: string, count: number) => ({ clientId, visibilityLevel, _count: { _all: count } });
  const ordinary = [group('client_a', 'interno', 2), group('client_a', 'privato', 1), group('client_b', 'interno', 4)];
  const privateGroups = [group('client_a', technicalDocumentPrivateVisibility, 7), group('client_b', 'technical_admin_private_v2', 8),
    group('client_private_only', technicalDocumentPrivateVisibility, 9), group('client_unknown', '', 3), group(null, 'interno', 5)];
  assert.deepEqual([...ordinaryDocumentCountsByClient([...ordinary, ...privateGroups])], [['client_a', 3], ['client_b', 4]]);
  assert.deepEqual(ordinaryDocumentCountsByClient(privateGroups), new Map());
});
