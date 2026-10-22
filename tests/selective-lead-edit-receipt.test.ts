import assert from 'node:assert/strict';
import test from 'node:test';
import { selectiveLeadProof } from '../src/lib/selective-lead-proof';
import type { SelectiveLeadGrantPayload } from '../src/lib/selective-lead-grant';
import { selectiveLeadEditProof, type SelectiveLeadEditAdmission, type SelectiveLeadEditPayload } from '../src/lib/selective-lead-edit-grant';
import { leadEditRequestDigest, signLeadEditReceipt, readLeadEditReceipt } from '../src/lib/selective-lead-edit-receipt';

const now = Date.parse('2026-10-22T08:00:00.000Z');
const key = { version: 3, secret: 'synthetic-only-lead-edit-receipt-secret-not-a-live-key' };
const read: SelectiveLeadGrantPayload = {
  id: 'c9cd54fe-5acf-4227-8bf4-1c320e740248', revision: 1,
  selection: { leadId: 'lead', recipientId: 'reader', revision: 0,
    commandId: '7a7bcc84-aa6d-416c-9c54-f7a5202f6d48', fields: ['interest', 'priority'], expiresAt: null },
  approvedById: 'admin', approvedAt: new Date(now - 5000).toISOString(), authorityRevision: 1,
  actorEpoch: 2, recipientEpoch: 3, leadEpoch: 4, keyVersion: 3,
};
const signedRead = { payload: read, proof: selectiveLeadProof(key, 'grant', read), revokedAt: null };
const edit: SelectiveLeadEditPayload = {
  protocol: 'SELECTIVE_LEAD_EDIT_GRANT_V1', id: '71f517f9-f30c-4a58-9c5f-84344ba93089', revision: 1,
  selection: { protocol: 'SELECTIVE_LEAD_EDIT_SELECTION_V1', leadId: 'lead', recipientId: 'reader',
    readGrantId: read.id, readGrantRevision: 1, readGrantProof: signedRead.proof, revision: 0,
    commandId: '22435bcc-d7e1-4892-9839-acbe158ca1ac', fields: ['priority'], expiresAt: null },
  approvedById: 'admin', approvedAt: new Date(now - 3000).toISOString(), authorityRevision: 5,
  actorEpoch: 2, recipientEpoch: 3, leadEpoch: 4, keyVersion: 3,
};
const signedEdit = { payload: edit, proof: selectiveLeadEditProof(key, 'grant', edit), revokedAt: null };
const current: SelectiveLeadEditAdmission = {
  capabilityId: edit.id, capabilityRevision: 1,
  authority: { purpose: 'lead-edit', enabled: true, userId: 'admin', revision: 5, actorEpoch: 2,
    actorActive: true, actorIsAdmin: true, writeAllowed: true },
  read: { leadId: 'lead', recipientId: 'reader', revision: 1,
    authority: { enabled: true, userId: 'admin', revision: 1, actorEpoch: 2, actorActive: true },
    recipientActive: true, recipientEpoch: 3, leadEpoch: 4, leadOperational: true },
  recipientWriteDenied: false, leadConverted: false,
};
const command = {
  protocol: 'SELECTIVE_LEAD_EDIT_COMMAND_V1', commandId: '485042ef-32e6-464a-99df-60336fccda5b',
  leadId: 'lead', capabilityId: edit.id, capabilityRevision: 1,
  readGrantId: read.id, readGrantRevision: 1, readGrantProof: signedRead.proof,
  expectedVersion: '2026-10-22T07:00:00.000Z', changes: { priority: 'alta' },
};
const payload = {
  protocol: 'SELECTIVE_LEAD_EDIT_RESULT_V1', commandId: command.commandId, leadId: 'lead', actorId: 'reader',
  capabilityId: edit.id, capabilityRevision: 1, requestDigest: leadEditRequestDigest(command),
  beforeVersion: command.expectedVersion, afterVersion: '2026-10-22T07:59:59.000Z',
  changedFields: ['priority'], recordedAt: new Date(now).toISOString(), keyVersion: 3,
};
const expected = { commandId: command.commandId, requestDigest: payload.requestDigest };
const verify = (row: unknown, state = current) => readLeadEditReceipt(row, signedEdit, signedRead, key, state, expected, now);

test('receipt carries no values and an exact replay resolves to the same minimized result', () => {
  const row = signLeadEditReceipt(key, payload);
  assert.deepEqual(verify(row), payload);
  assert.deepEqual(verify(row), payload);
  assert.equal(JSON.stringify(row).includes('alta'), false);
  assert.throws(() => signLeadEditReceipt(key, { ...payload, after: { priority: 'alta' } }));
});
test('a changed command, actor, lead or capability cannot borrow another signed receipt', () => {
  const row = signLeadEditReceipt(key, payload);
  assert.equal(readLeadEditReceipt(row, signedEdit, signedRead, key, current,
    { ...expected, requestDigest: leadEditRequestDigest({ ...command, changes: { priority: 'bassa' } }) }, now), null);
  assert.equal(readLeadEditReceipt(row, signedEdit, signedRead, key, current,
    { ...expected, commandId: read.id }, now), null);
  for (const delta of [{ actorId: 'other' }, { leadId: 'other' }, { capabilityId: read.id }, { capabilityRevision: 2 }]) {
    assert.equal(verify(signLeadEditReceipt(key, { ...payload, ...delta })), null);
  }
});
test('revocation, authority suspension or a stale generation deny receipt consultation without rewriting history', () => {
  const row = signLeadEditReceipt(key, payload), before = JSON.stringify(row);
  assert.equal(readLeadEditReceipt(row, signedEdit, { ...signedRead, revokedAt: new Date(now).toISOString() }, key, current, expected, now), null);
  assert.equal(verify(row, { ...current, authority: { ...current.authority, enabled: false } }), null);
  assert.equal(verify(row, { ...current, read: { ...current.read, leadEpoch: 5 } }), null);
  assert.equal(JSON.stringify(row), before);
});
test('false fields, non-monotone versions, future receipts and proof purpose substitution are denied', () => {
  for (const delta of [{ changedFields: [] }, { changedFields: ['priority', 'priority'] },
    { changedFields: ['notes'] }, { afterVersion: command.expectedVersion }]) {
    assert.throws(() => signLeadEditReceipt(key, { ...payload, ...delta }));
  }
  assert.equal(verify(signLeadEditReceipt(key, { ...payload, changedFields: ['interest'] })), null);
  assert.equal(verify(signLeadEditReceipt(key, { ...payload, recordedAt: new Date(now + 1).toISOString() })), null);
  assert.equal(verify({ payload, proof: selectiveLeadEditProof(key, 'grant', payload) }), null);
  const row = signLeadEditReceipt(key, payload);
  assert.equal(verify({ ...row, payload: { ...payload, afterVersion: '2026-10-22T07:59:59.001Z' } }), null);
});
test('request digest ignores JSON property order but rejects hidden values and binds each explicit change', () => {
  assert.equal(leadEditRequestDigest({ ...command, changes: { priority: 'alta' } }), payload.requestDigest);
  assert.equal(leadEditRequestDigest(Object.fromEntries(Object.entries(command).reverse())), payload.requestDigest);
  assert.notEqual(leadEditRequestDigest({ ...command, changes: { priority: 'bassa' } }), payload.requestDigest);
  assert.throws(() => leadEditRequestDigest({ ...command, assignedToId: 'hidden' }));
});
