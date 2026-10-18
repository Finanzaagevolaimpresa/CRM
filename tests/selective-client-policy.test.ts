import assert from 'node:assert/strict';
import test from 'node:test';
import { clientContextOutsideSelection, clientFieldProjection, clientOutsideSelection, hasSelectiveClientContext,
  isSelectiveClient, selectiveClientAuditAllowed, selectiveClientSelectionSchema } from '../src/lib/selective-client-policy';

const selection = { clientId: 'client-synthetic', recipientId: 'recipient-synthetic', revision: 0,
  commandId: '7a7bcc84-aa6d-416c-9c54-f7a5202f6d48', fields: ['displayName', 'status'], expiresAt: null };

test('selected client identity never includes notes, owner, source lead or related dossiers', () => {
  const value = clientFieldProjection({ displayName: 'Cliente sintetico', status: 'attivo', type: 'azienda',
    notes: 'PRIVATE', leadId: 'HIDDEN_LEAD', salesOwnerId: 'HIDDEN_OWNER',
    companies: [{ name: 'HIDDEN_COMPANY' }], projects: [{ title: 'HIDDEN_PROJECT' }],
    documents: [{ name: 'HIDDEN_FILE' }], approvedCommunications: [{ text: 'HIDDEN_EMAIL' }] }, ['displayName', 'status']);
  assert.deepEqual(value, [{ key: 'displayName', label: 'Denominazione', value: 'Cliente sintetico' },
    { key: 'status', label: 'Stato', value: 'attivo' }]);
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE|HIDDEN|azienda/);
});

test('private fields, companies and operations require separate contracts', () => {
  for (const fields of [['notes'], ['leadId'], ['salesOwnerId'], ['companies'], ['companyName'], ['vatNumber'], ['future']]) {
    assert.equal(selectiveClientSelectionSchema.safeParse({ ...selection, fields }).success, false);
  }
  for (const key of ['write', 'upload', 'download', 'documents', 'companies', 'role']) {
    assert.equal(selectiveClientSelectionSchema.safeParse({ ...selection, [key]: true }).success, false);
  }
  assert.equal(selectiveClientSelectionSchema.safeParse(selection).success, true);
});

test('malformed, empty, duplicate or unversioned selections are denied', () => {
  for (const change of [{ fields: [] }, { fields: ['status', 'status'] }, { clientId: '../client' },
    { revision: -1 }, { revision: 0.5 }, { commandId: 'missing-identity' }, { expiresAt: 'tomorrow' }]) {
    assert.equal(selectiveClientSelectionSchema.safeParse({ ...selection, ...change }).success, false);
  }
});

test('a historical restriction applies before role or broader client grant, including missing identity', () => {
  const scope = { role: 'admin', clientReadScope: ['restricted'], selectiveClientIds: ['restricted', 'restricted'] };
  assert.equal(isSelectiveClient(scope, 'restricted'), true);
  assert.equal(isSelectiveClient(scope, null), true);
  assert.equal(isSelectiveClient(scope), true);
  assert.equal(isSelectiveClient(scope, 'unrelated'), false);
  assert.deepEqual(clientOutsideSelection(scope), { id: { notIn: ['restricted'] } });
  assert.equal(isSelectiveClient({}, 'unrelated'), false);
});

test('projection rejects nested data, forged field types and duplication', () => {
  assert.throws(() => clientFieldProjection({ displayName: { hidden: true } }, ['displayName']));
  assert.throws(() => clientFieldProjection({ notes: 'PRIVATE' }, ['notes' as 'status']));
  assert.throws(() => clientFieldProjection({ status: 'attivo' }, ['status', 'status']));
  assert.deepEqual(clientFieldProjection({ status: null }, ['status']), [{ key: 'status', label: 'Stato', value: '—' }]);
});

test('nested selected client cannot be hidden behind a conflicting outer dossier identity', () => {
  const scope = { selectiveClientIds: ['restricted'] };
  const inner = [
    { client: { id: 'restricted' } },
    { company: { clientId: 'restricted' } },
    { project: { clientId: 'restricted' } },
    { project: { client: { id: 'restricted' } } },
    { project: { company: { client: { id: 'restricted' } } } },
    { clientService: { clientId: 'restricted' } },
    { clientService: { client: { id: 'restricted' } } },
    { clientService: { project: { clientId: 'restricted' } } },
    { clientService: { project: { company: { clientId: 'restricted' } } } },
  ];
  for (const link of inner) assert.equal(hasSelectiveClientContext(scope, { clientId: 'unrelated', ...link }), true);
  assert.equal(hasSelectiveClientContext(scope, { clientId: 'restricted', client: { id: 'unrelated' } }), true);
  assert.equal(hasSelectiveClientContext(scope, { clientId: 'unrelated', project: { clientId: 'unrelated' } }), false);
  assert.equal(hasSelectiveClientContext(scope, { clientId: null, project: null }), false);
  assert.equal(hasSelectiveClientContext({}, { clientId: 'restricted' }), false);
  assert.deepEqual(clientContextOutsideSelection(scope), { OR: [{ clientId: null }, { clientId: { notIn: ['restricted'] } }] });
});

test('audit exclusion covers original client identity and related entity before/after payloads', () => {
  const scope = { selectiveClientIds: ['restricted'], selectiveClientAuditEntityIds: ['private-document'] };
  assert.equal(selectiveClientAuditAllowed(scope, { entityId: 'restricted' }), false);
  assert.equal(selectiveClientAuditAllowed(scope, { entityId: 'private-document' }), false);
  assert.equal(selectiveClientAuditAllowed(scope, { entityId: 'indirect', before: { nested: [{ clientId: 'restricted' }] } }), false);
  assert.equal(selectiveClientAuditAllowed(scope, { entityId: 'indirect', after: { attachmentId: 'private-document' } }), false);
  assert.equal(selectiveClientAuditAllowed(scope, { entityId: 'unrelated', after: { status: 'attivo' } }), true);
  assert.equal(selectiveClientAuditAllowed({}, { entityId: 'restricted' }), true);
});

test('a company-only record cannot bypass its selected client through missing or contradictory clientId', () => {
  const scope = { selectiveClientIds: ['selected-client'], selectiveClientCompanyIds: ['selected-company'] };
  assert.equal(hasSelectiveClientContext(scope, { companyId: 'selected-company' }), true);
  assert.equal(hasSelectiveClientContext(scope, { clientId: 'other-client', companyId: 'selected-company' }), true);
  assert.equal(hasSelectiveClientContext(scope, { clientId: 'other-client', project: { companyId: 'selected-company' } }), true);
  assert.equal(hasSelectiveClientContext(scope, { clientId: 'other-client', companyId: 'other-company' }), false);
  assert.equal(hasSelectiveClientContext(scope, { clientId: null, companyId: null }), false);
});
