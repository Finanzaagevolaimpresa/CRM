import test from 'node:test';
import assert from 'node:assert/strict';
import { assertUpdatePreview, parseRecordUpdateSummary, parseUpdateSelection, recordUpdateSummary, resolveUpdateSelection, updateAdmission, updateChannels, updatePreviewDigest, type UpdateDirectoryPerson, type UpdatePreviewBinding } from '../src/lib/record-update-contract';

const directory: UpdateDirectoryPerson[] = [
  { id: 'sales', name: 'Commerciale sintetico', email: 'sales@example.test', role: 'commerciale', active: true, deleted: false, revision: '1' },
  { id: 'technical', name: 'Tecnico sintetico', email: 'tech@example.test', role: 'consulente', active: true, deleted: false, revision: '1' },
  { id: 'administration', name: 'Amministrazione sintetica', email: 'office@example.test', role: 'amministrazione', active: true, deleted: false, revision: '1' },
];
const selection = { people: ['sales'], groups: ['commerciali', 'tecnico'] };
test('selection expands only existing people and deduplicates overlap with groups', () => {
  const actual = resolveUpdateSelection(selection, directory);
  assert.deepEqual(actual.people.map(row => row.id), ['sales', 'technical']);
  assert.equal(actual.directoryBinding, resolveUpdateSelection({ people: ['sales', 'sales'], groups: ['tecnico', 'commerciali'] }, [...directory].reverse()).directoryBinding);
  assert.throws(() => parseUpdateSelection({ ...selection, grantAccess: true }), /INVALID/);
  assert.throws(() => parseUpdateSelection({ people: [], groups: ['fictional-department'] }), /INVALID/);
  assert.throws(() => parseUpdateSelection({ people: [], groups: ['constructor'] }), /INVALID/);
  assert.throws(() => resolveUpdateSelection({ people: [], groups: ['direzione'] }, directory), /EMPTY_GROUP/);
});
test('stale people, group membership and address changes invalidate the selection binding', () => {
  const original = resolveUpdateSelection(selection, directory).directoryBinding;
  for (const patch of [{ email: 'changed@example.test' }, { revision: '2' }, { name: 'Changed' }]) {
    assert.notEqual(resolveUpdateSelection(selection, directory.map(row => row.id === 'sales' ? { ...row, ...patch } : row)).directoryBinding, original);
  }
  assert.notEqual(resolveUpdateSelection(selection, [...directory, { ...directory[0], id: 'new-member' }]).directoryBinding, original);
  assert.throws(() => resolveUpdateSelection(selection, directory.map(row => row.id === 'sales' ? { ...row, role: 'backoffice' } : row)), /EMPTY_GROUP/);
  assert.throws(() => resolveUpdateSelection({ people: ['sales'], groups: [] }, directory.map(row => row.id === 'sales' ? { ...row, active: false } : row)), /DIRECTORY_CHANGED/);
  assert.throws(() => resolveUpdateSelection({ people: ['absent'], groups: [] }, directory), /DIRECTORY_CHANGED/);
});
test('groups cannot exceed the actual-recipient bound', () => {
  assert.throws(() => resolveUpdateSelection({ people: [], groups: ['commerciali'] }, Array.from({ length: 21 }, (_, i) => ({ ...directory[0], id: 'sales-' + i }))), /TOO_MANY/);
});
test('summaries cannot carry notes, money, recipients, attachments or arbitrary payloads', () => {
  assert.deepEqual(recordUpdateSummary('STATE_CHANGED', ['status', 'status']), { event: 'STATE_CHANGED', changed: ['status'] });
  for (const key of ['notes', 'margin', 'fee', 'attachments', 'email', 'recipients', 'title', '__proto__']) {
    assert.throws(() => recordUpdateSummary('RECORD_CHANGED', [key]), /INVALID/);
    assert.throws(() => parseRecordUpdateSummary({ event: 'COMMUNICATION', changed: ['communication'], [key]: 'private' }), /INVALID/);
  }
});
test('selection never grants access and an email rule never approves a send', () => {
  assert.deepEqual(updateAdmission(directory[0], false), { available: false, reason: 'NO_CURRENT_ACCESS', canGrantAccess: false });
  assert.equal(updateAdmission({ ...directory[0], deleted: true }, true).available, false);
  assert.equal(updateAdmission(directory[0], true).available, true);
  for (const mode of ['CRM', 'EMAIL_DRAFT', 'CRM_AND_EMAIL_DRAFT'] as const) assert.equal(updateChannels(mode).sendApproved, false);
  assert.deepEqual(updateChannels('CRM'), { crm: true, emailDraft: false, sendApproved: false });
});
const preview: UpdatePreviewBinding = { actorId: 'admin', sessionId: 'session', kind: 'PRACTICE', recordId: 'record', recordVersion: 'version', scopeEpoch: 'epoch', directoryBinding: 'directory', recipientAccessBinding: 'access', patchDigest: 'patch', selection, events: ['STATE_CHANGED'], mode: 'CRM', persistent: false, ruleVersion: 0, commandId: 'command' };
test('the same preview cannot approve another actor, session, record, patch, recipients, access, scope or rule', () => {
  const digest = updatePreviewDigest(preview);
  assert.doesNotThrow(() => assertUpdatePreview(digest, preview));
  for (const key of ['actorId', 'sessionId', 'recordId', 'recordVersion', 'scopeEpoch', 'directoryBinding', 'recipientAccessBinding', 'patchDigest', 'commandId'] as const) {
    assert.throws(() => assertUpdatePreview(digest, { ...preview, [key]: 'changed' }), /STALE/);
  }
  for (const patch of [{ mode: 'EMAIL_DRAFT' as const }, { persistent: true }, { ruleVersion: 1 }, { selection: { people: ['administration'], groups: [] } }, { events: ['COMMUNICATION'] as const }]) {
    assert.throws(() => assertUpdatePreview(digest, { ...preview, ...patch, events: [...(patch.events ?? preview.events)] }), /STALE/);
  }
});
