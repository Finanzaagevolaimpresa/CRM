import assert from 'node:assert/strict';
import test from 'node:test';
import { selectDocumentUploadContext as select, DocumentUploadContextError } from '../src/lib/document-upload-context';
const allowed = { clients: [{ id: 'owned', generalUploadAllowed: true }, { id: 'child-only', generalUploadAllowed: false }],
  projects: [{ id: 'project-a', clientId: 'owned' }, { id: 'project-b', clientId: 'child-only' }],
  services: [{ id: 'service-a', clientId: 'owned', projectId: 'project-a' }, { id: 'other-project-service', clientId: 'owned', projectId: 'another' }] };
test('authorized context preserves exact associations while client-only upload stays unlinked', () => {
  assert.deepEqual(select({ clientId: 'owned', projectId: 'project-a', clientServiceId: 'service-a' }, allowed), { clientId: 'owned', projectId: 'project-a', clientServiceId: 'service-a' });
  assert.deepEqual(select({ clientId: 'owned' }, allowed), { clientId: 'owned', projectId: '', clientServiceId: '' });
});
test('foreign, mismatched and stale selector values fail closed', () => {
  for (const query of [{ clientId: 'foreign' }, { clientId: 'owned', projectId: 'project-b' },
    { clientId: 'owned', projectId: 'project-a', clientServiceId: 'other-project-service' }, { clientId: 'owned', projectId: 'revoked' }])
    assert.throws(() => select(query, allowed), DocumentUploadContextError);
});
test('child assignment cannot preselect the general dossier', () => {
  assert.throws(() => select({ clientId: 'child-only' }, allowed), DocumentUploadContextError);
  assert.equal(select({ clientId: 'child-only', projectId: 'project-b' }, allowed).projectId, 'project-b');
});
test('arrays, path inputs and absent identifiers never become a context', () => {
  for (const query of [{}, { clientId: ['owned'] }, { clientId: '../owned' }, { clientId: 'owned', projectId: '' }])
    assert.throws(() => select(query, allowed), DocumentUploadContextError);
});
