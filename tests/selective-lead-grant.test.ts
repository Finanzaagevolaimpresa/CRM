import assert from 'node:assert/strict';
import test from 'node:test';
import { readSelectiveLeadGrant, selectiveLeadGrantProjection, type SelectiveLeadGrantAdmission,
  type SelectiveLeadGrantPayload } from '../src/lib/selective-lead-grant';
import { selectiveLeadProof } from '../src/lib/selective-lead-proof';

const key = { version: 3, secret: 'synthetic-only-lead-grant-key-not-an-actual-credential' };
const now = Date.parse('2026-10-18T11:00:00Z');
const payload: SelectiveLeadGrantPayload = {
  id: 'c9cd54fe-5acf-4227-8bf4-1c320e740248', revision: 1,
  selection: { leadId: 'synthetic-lead', recipientId: 'synthetic-recipient', revision: 0,
    commandId: '7a7bcc84-aa6d-416c-9c54-f7a5202f6d48', fields: ['companyName', 'status'], expiresAt: null },
  approvedById: 'synthetic-admin', approvedAt: new Date(now).toISOString(), authorityRevision: 1,
  actorEpoch: 2, recipientEpoch: 3, leadEpoch: 4, keyVersion: 3,
};
const admission: SelectiveLeadGrantAdmission = {
  leadId: 'synthetic-lead', recipientId: 'synthetic-recipient', revision: 1,
  authority: { enabled: true, userId: 'synthetic-admin', revision: 1, actorEpoch: 2, actorActive: true },
  recipientActive: true, recipientEpoch: 3, leadEpoch: 4, leadOperational: true,
};
function signed(p = payload) { return { payload: p, proof: selectiveLeadProof(key, 'grant', p), revokedAt: null }; }

test('a current grant returns only the two personally selected fields', () => {
  const valid = readSelectiveLeadGrant(signed(), key, admission, now);
  assert.ok(valid);
  assert.deepEqual(selectiveLeadGrantProjection({ id: 'synthetic-lead', companyName: 'Azienda sintetica',
    status: 'nuovo', email: 'private@example.invalid', notes: 'not shared', client: { id: 'private-client' } }, valid), [
    { key: 'companyName', label: 'Azienda', value: 'Azienda sintetica' },
    { key: 'status', label: 'Stato', value: 'nuovo' },
  ]);
  assert.throws(() => selectiveLeadGrantProjection({ id: 'different-lead' }, valid));
});

test('revocation, expiry and lifecycle restoration never restore a projection', () => {
  assert.equal(readSelectiveLeadGrant({ ...signed(), revokedAt: new Date(now).toISOString() }, key, admission, now), null);
  const expiring = signed({ ...payload, selection: { ...payload.selection, expiresAt: new Date(now + 1).toISOString() } });
  assert.ok(readSelectiveLeadGrant(expiring, key, admission, now));
  assert.equal(readSelectiveLeadGrant(expiring, key, admission, now + 1), null);
  assert.equal(readSelectiveLeadGrant(signed(), key, { ...admission, leadOperational: false }, now), null);
  assert.equal(readSelectiveLeadGrant(signed(), key, { ...admission, leadEpoch: 5 }, now), null);
});

test('current personal authority and both user epochs are required', () => {
  for (const delta of [{ enabled: false }, { actorActive: false }, { userId: 'other-admin' }, { revision: 2 }, { actorEpoch: 3 }]) {
    assert.equal(readSelectiveLeadGrant(signed(), key, { ...admission, authority: { ...admission.authority, ...delta } }, now), null);
  }
  for (const delta of [{ recipientActive: false }, { recipientEpoch: 4 }]) {
    assert.equal(readSelectiveLeadGrant(signed(), key, { ...admission, ...delta }, now), null);
  }
});

test('context, current revision and command version cannot be substituted', () => {
  for (const delta of [{ leadId: 'other' }, { recipientId: 'other' }, { revision: 2 }]) {
    assert.equal(readSelectiveLeadGrant(signed(), key, { ...admission, ...delta }, now), null);
  }
  assert.equal(readSelectiveLeadGrant(signed({ ...payload, selection: { ...payload.selection, revision: 1 } }), key, admission, now), null);
  assert.equal(readSelectiveLeadGrant(signed({ ...payload, approvedById: admission.recipientId }), key,
    { ...admission, authority: { ...admission.authority, userId: admission.recipientId } }, now), null);
});

test('tampered selected fields, future approval, different proof purpose and key fail closed', () => {
  assert.equal(readSelectiveLeadGrant({ ...signed(), payload: { ...payload, selection: { ...payload.selection, fields: ['email'] } } }, key, admission, now), null);
  assert.equal(readSelectiveLeadGrant(signed({ ...payload, approvedAt: new Date(now + 1).toISOString() }), key, admission, now), null);
  assert.equal(readSelectiveLeadGrant({ ...signed(), proof: selectiveLeadProof(key, 'preview', payload) }, key, admission, now), null);
  assert.equal(readSelectiveLeadGrant(signed(), { ...key, version: 4 }, admission, now), null);
  assert.equal(readSelectiveLeadGrant(signed(), { ...key, secret: key.secret + 'changed' }, admission, now), null);
  assert.equal(readSelectiveLeadGrant(signed(), key, admission, NaN), null);
});
