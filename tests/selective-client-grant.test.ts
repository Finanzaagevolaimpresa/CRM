import assert from 'node:assert/strict';
import test from 'node:test';
import { readSelectiveClientGrant, selectiveClientGrantProjection, type SelectiveClientGrantAdmission,
  type SelectiveClientGrantPayload } from '../src/lib/selective-client-grant';
import { selectiveClientProof } from '../src/lib/selective-client-proof';
import { selectiveLeadProof } from '../src/lib/selective-lead-proof';

const key = { version: 3, secret: 'synthetic-client-key-no-real-credential-or-provider' };
const now = Date.parse('2026-10-18T13:00:00Z');
const payload: SelectiveClientGrantPayload = {
  id: 'c9cd54fe-5acf-4227-8bf4-1c320e740248', revision: 1,
  selection: { clientId: 'client-synthetic', recipientId: 'recipient-synthetic', revision: 0,
    commandId: '7a7bcc84-aa6d-416c-9c54-f7a5202f6d48', fields: ['displayName', 'status'], expiresAt: null },
  approvedById: 'admin-synthetic', approvedAt: new Date(now).toISOString(), authorityRevision: 1,
  actorEpoch: 2, recipientEpoch: 3, clientEpoch: 4, keyVersion: 3,
};
const admission: SelectiveClientGrantAdmission = {
  clientId: 'client-synthetic', recipientId: 'recipient-synthetic', revision: 1,
  authority: { enabled: true, userId: 'admin-synthetic', revision: 1, actorEpoch: 2, actorActive: true },
  recipientActive: true, recipientEpoch: 3, clientEpoch: 4, clientOperational: true,
};
function signed(p = payload) { return { payload: p, proof: selectiveClientProof(key, 'grant', p), revokedAt: null }; }

test('a current personal client selection returns only chosen scalar values', () => {
  const valid = readSelectiveClientGrant(signed(), key, admission, now);
  assert.ok(valid);
  const projected = selectiveClientGrantProjection({ id: 'client-synthetic', displayName: 'Cliente sintetico', status: 'attivo',
    notes: 'PRIVATE', leadId: 'HIDDEN_LEAD', companies: [{ name: 'HIDDEN_COMPANY' }] }, valid);
  assert.equal(projected.length, 2);
  assert.doesNotMatch(JSON.stringify(projected), /PRIVATE|HIDDEN/);
  assert.throws(() => selectiveClientGrantProjection({ id: 'another-client' }, valid));
});

test('expired/revoked grants and changed lifecycle generations remain denied after restoration', () => {
  assert.equal(readSelectiveClientGrant({ ...signed(), revokedAt: new Date(now).toISOString() }, key, admission, now), null);
  const limited = signed({ ...payload, selection: { ...payload.selection, expiresAt: new Date(now + 1).toISOString() } });
  assert.ok(readSelectiveClientGrant(limited, key, admission, now));
  assert.equal(readSelectiveClientGrant(limited, key, admission, now + 1), null);
  assert.equal(readSelectiveClientGrant(signed(), key, { ...admission, clientOperational: false }, now), null);
  assert.equal(readSelectiveClientGrant(signed(), key, { ...admission, clientEpoch: 5 }, now), null);
});

test('current actor/recipient authority and identity generations cannot be inherited from another binding', () => {
  for (const delta of [{ enabled: false }, { actorActive: false }, { userId: 'another-admin' }, { revision: 2 }, { actorEpoch: 3 }]) {
    assert.equal(readSelectiveClientGrant(signed(), key, { ...admission, authority: { ...admission.authority, ...delta } }, now), null);
  }
  for (const delta of [{ recipientActive: false }, { recipientEpoch: 4 }, { recipientId: 'another-user' }, { clientId: 'another-client' }, { revision: 2 }]) {
    assert.equal(readSelectiveClientGrant(signed(), key, { ...admission, ...delta }, now), null);
  }
});

test('cross-protocol proof, tampering, self-grant, future date and stale key cannot admit a client', () => {
  assert.equal(readSelectiveClientGrant({ ...signed(), proof: selectiveLeadProof(key, 'grant', payload) }, key, admission, now), null);
  assert.equal(readSelectiveClientGrant({ ...signed(), proof: selectiveClientProof(key, 'preview', payload) }, key, admission, now), null);
  assert.equal(readSelectiveClientGrant({ ...signed(), payload: { ...payload, selection: { ...payload.selection, fields: ['type'] } } }, key, admission, now), null);
  assert.equal(readSelectiveClientGrant(signed({ ...payload, approvedById: admission.recipientId }), key,
    { ...admission, authority: { ...admission.authority, userId: admission.recipientId } }, now), null);
  assert.equal(readSelectiveClientGrant(signed({ ...payload, approvedAt: new Date(now + 1).toISOString() }), key, admission, now), null);
  assert.equal(readSelectiveClientGrant(signed(), { ...key, version: 4 }, admission, now), null);
  assert.equal(readSelectiveClientGrant(signed(), key, admission, NaN), null);
});
