import assert from 'node:assert/strict';
import test from 'node:test';
import { selectiveLeadProof } from '../src/lib/selective-lead-proof';
import type { SelectiveLeadGrantPayload, SelectiveLeadGrantAdmission } from '../src/lib/selective-lead-grant';
import { validateLeadEditSelection, parseBoundLeadEditCommand, selectiveLeadEditCommandSchema } from '../src/lib/selective-lead-edit-policy';
import { readSelectiveLeadEditGrant, selectiveLeadEditProof, type SelectiveLeadEditPayload,
  type SelectiveLeadEditAdmission } from '../src/lib/selective-lead-edit-grant';

const now = Date.parse('2026-10-22T08:00:00Z');
const key = { version: 3, secret: 'synthetic-only-lead-edit-test-key-not-a-real-credential' };
const read: SelectiveLeadGrantPayload = {
  id: 'c9cd54fe-5acf-4227-8bf4-1c320e740248', revision: 1,
  selection: { leadId: 'lead', recipientId: 'reader', revision: 0,
    commandId: '7a7bcc84-aa6d-416c-9c54-f7a5202f6d48', fields: ['interest', 'priority'], expiresAt: null },
  approvedById: 'admin', approvedAt: new Date(now).toISOString(), authorityRevision: 1,
  actorEpoch: 2, recipientEpoch: 3, leadEpoch: 4, keyVersion: 3,
};
const readCurrent: SelectiveLeadGrantAdmission = {
  leadId: 'lead', recipientId: 'reader', revision: 1,
  authority: { enabled: true, userId: 'admin', revision: 1, actorEpoch: 2, actorActive: true },
  recipientActive: true, recipientEpoch: 3, leadEpoch: 4, leadOperational: true,
};
const signedRead = { payload: read, proof: selectiveLeadProof(key, 'grant', read), revokedAt: null };
const payload: SelectiveLeadEditPayload = {
  protocol: 'SELECTIVE_LEAD_EDIT_GRANT_V1', id: '71f517f9-f30c-4a58-9c5f-84344ba93089', revision: 1,
  selection: { protocol: 'SELECTIVE_LEAD_EDIT_SELECTION_V1', leadId: 'lead', recipientId: 'reader',
    readGrantId: read.id, readGrantRevision: 1, readGrantProof: signedRead.proof, revision: 0,
    commandId: '22435bcc-d7e1-4892-9839-acbe158ca1ac', fields: ['interest', 'priority'], expiresAt: null },
  approvedById: 'admin', approvedAt: new Date(now).toISOString(), authorityRevision: 5,
  actorEpoch: 2, recipientEpoch: 3, leadEpoch: 4, keyVersion: 3,
};
const current: SelectiveLeadEditAdmission = {
  capabilityId: payload.id, capabilityRevision: 1,
  authority: { purpose: 'lead-edit', enabled: true, userId: 'admin', revision: 5, actorEpoch: 2,
    actorActive: true, actorIsAdmin: true, writeAllowed: true },
  read: readCurrent, recipientWriteDenied: false, leadConverted: false,
};
const signed = (p = payload) => ({ payload: p, proof: selectiveLeadEditProof(key, 'grant', p), revokedAt: null });
const command = {
  protocol: 'SELECTIVE_LEAD_EDIT_COMMAND_V1', commandId: '485042ef-32e6-464a-99df-60336fccda5b',
  leadId: 'lead', capabilityId: payload.id, capabilityRevision: 1,
  readGrantId: read.id, readGrantRevision: 1, readGrantProof: signedRead.proof,
  expectedVersion: '2026-10-22T07:00:00.000Z', changes: { priority: 'alta' },
};
const commandCurrent = { capabilityId: payload.id, capabilityRevision: 1, selection: payload.selection,
  currentVersion: command.expectedVersion };

test('a read grant alone never becomes an editing capability; both signatures and distinct authority are required', () => {
  assert.equal(readSelectiveLeadEditGrant(signedRead, signedRead, key, current, now), null);
  assert.equal(readSelectiveLeadEditGrant(signed(), signedRead, key,
    { ...current, authority: { ...current.authority, enabled: false } }, now), null);
  assert.deepEqual(readSelectiveLeadEditGrant(signed(), signedRead, key, current, now), payload);
});

test('revocation and replacement of the exact read grant invalidate edits even with an unchanged edit signature', () => {
  assert.equal(readSelectiveLeadEditGrant(signed(), { ...signedRead, revokedAt: new Date(now).toISOString() }, key, current, now), null);
  const changed = { ...read, revision: 2, selection: { ...read.selection, revision: 1 } };
  const changedRead = { payload: changed, proof: selectiveLeadProof(key, 'grant', changed), revokedAt: null };
  assert.equal(readSelectiveLeadEditGrant(signed(), changedRead, key, { ...current, read: { ...readCurrent, revision: 2 } }, now), null);
  assert.equal(readSelectiveLeadEditGrant({ ...signed(), revokedAt: new Date(now).toISOString() }, signedRead, key, current, now), null);
});

test('editing expiry cannot outlive reading and field selection must be a nonempty unique readable subset', () => {
  const expiringRead = { ...read, selection: { ...read.selection, expiresAt: new Date(now + 1000).toISOString() } };
  assert.throws(() => validateLeadEditSelection(payload.selection, expiringRead, signedRead.proof, now));
  const expiring = { ...payload.selection, expiresAt: new Date(now + 1000).toISOString() };
  assert.ok(validateLeadEditSelection(expiring, expiringRead, signedRead.proof, now));
  assert.throws(() => validateLeadEditSelection(expiring, expiringRead, signedRead.proof, now + 1000));
  for (const fields of [[], ['priority', 'priority'], ['status'], ['notes'], ['interest', 'priority', 'phone']]) {
    assert.throws(() => validateLeadEditSelection({ ...payload.selection, fields }, read, signedRead.proof, now));
  }
  const narrow = { ...read, selection: { ...read.selection, fields: ['priority' as const] } };
  assert.throws(() => validateLeadEditSelection(payload.selection, narrow, signedRead.proof, now));
});

test('conversion, archived/restored generations, inactive identities and explicit write denial close admission', () => {
  for (const delta of [{ leadConverted: true }, { recipientWriteDenied: true },
    { capabilityRevision: 2 }, { capabilityId: read.id }]) {
    assert.equal(readSelectiveLeadEditGrant(signed(), signedRead, key, { ...current, ...delta }, now), null);
  }
  for (const delta of [{ leadOperational: false }, { leadEpoch: 5 }, { recipientEpoch: 4 }, { recipientActive: false }]) {
    assert.equal(readSelectiveLeadEditGrant(signed(), signedRead, key, { ...current, read: { ...readCurrent, ...delta } }, now), null);
  }
  for (const delta of [{ enabled: false }, { actorActive: false }, { actorIsAdmin: false },
    { writeAllowed: false }, { revision: 6 }, { actorEpoch: 3 }, { userId: 'other' }]) {
    assert.equal(readSelectiveLeadEditGrant(signed(), signedRead, key, { ...current, authority: { ...current.authority, ...delta } }, now), null);
  }
});

test('read protocol signatures, other purposes, changed bytes, keys and future approvals cannot authorize edits', () => {
  for (const proof of [selectiveLeadProof(key, 'grant', payload), selectiveLeadEditProof(key, 'receipt', payload), '0'.repeat(64)]) {
    assert.equal(readSelectiveLeadEditGrant({ ...signed(), proof }, signedRead, key, current, now), null);
  }
  assert.equal(readSelectiveLeadEditGrant({ ...signed(), payload: { ...payload, selection: { ...payload.selection, fields: ['priority'] } } }, signedRead, key, current, now), null);
  assert.equal(readSelectiveLeadEditGrant(signed(), signedRead, { ...key, version: 4 }, current, now), null);
  assert.equal(readSelectiveLeadEditGrant(signed(), signedRead, { ...key, secret: key.secret + 'x' }, current, now), null);
  assert.equal(readSelectiveLeadEditGrant(signed({ ...payload, approvedAt: new Date(now + 1).toISOString() }), signedRead, key, current, now), null);
  assert.equal(readSelectiveLeadEditGrant(signed(), signedRead, key, current, NaN), null);
});

test('command accepts only selected fields and no hidden ordinary form values or implicit defaults', () => {
  assert.deepEqual(parseBoundLeadEditCommand(command, commandCurrent).changes, { priority: 'alta' });
  for (const changes of [{}, { priority: undefined }, { priority: 'highest' }, { assignedToId: 'owner' },
    { status: 'vinto' }, { notes: 'private' }, { interest: 'x', phone: '123' }]) {
    assert.throws(() => parseBoundLeadEditCommand({ ...command, changes }, commandCurrent));
  }
  assert.throws(() => parseBoundLeadEditCommand({ ...command, status: 'vinto' }, commandCurrent));
  assert.throws(() => parseBoundLeadEditCommand({ ...command, changes: { interest: 'new' } },
    { ...commandCurrent, selection: { ...payload.selection, fields: ['priority'] } }));
  assert.deepEqual(selectiveLeadEditCommandSchema.parse({ ...command, changes: { interest: '  ' } }).changes, { interest: null });
  assert.throws(() => selectiveLeadEditCommandSchema.parse({ ...command, changes: { interest: 'x'.repeat(5001) } }));
});

test('stale form, grant replacement and command/capability substitution cannot become last-write-wins', () => {
  for (const delta of [{ expectedVersion: '2026-10-22T06:00:00.000Z' }, { leadId: 'other' },
    { capabilityId: read.id }, { capabilityRevision: 2 }, { readGrantId: payload.id },
    { readGrantRevision: 2 }, { readGrantProof: 'a'.repeat(64) }]) {
    assert.throws(() => parseBoundLeadEditCommand({ ...command, ...delta }, commandCurrent));
  }
});
