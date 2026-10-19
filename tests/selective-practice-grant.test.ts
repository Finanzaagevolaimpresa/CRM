import assert from 'node:assert/strict';
import test from 'node:test';
import { readSelectivePracticeGrant, selectivePracticeGrantProjection, type SelectivePracticeGrantAdmission,
  type SelectivePracticeGrantPayload } from '../src/lib/selective-practice-grant';
import { selectivePracticeProof } from '../src/lib/selective-practice-proof';
import { selectiveLeadProof } from '../src/lib/selective-lead-proof';

const key = { version: 3, secret: 'synthetic-client-key-no-real-credential-or-provider' };
const now = Date.parse('2026-10-18T13:00:00Z');
const payload: SelectivePracticeGrantPayload = {
  id: 'c9cd54fe-5acf-4227-8bf4-1c320e740248', revision: 1,
  selection: { practiceId: 'practice-synthetic', recipientId: 'recipient-synthetic', revision: 0,
    commandId: '7a7bcc84-aa6d-416c-9c54-f7a5202f6d48', fields: ['title', 'status'], expiresAt: null },
  approvedById: 'admin-synthetic', approvedAt: new Date(now).toISOString(), authorityRevision: 1,
  actorEpoch: 2, recipientEpoch: 3, practiceEpoch: 4, contextHash: 'c'.repeat(64), keyVersion: 3,
};
const admission: SelectivePracticeGrantAdmission = {
  practiceId: 'practice-synthetic', recipientId: 'recipient-synthetic', revision: 1,
  authority: { enabled: true, userId: 'admin-synthetic', revision: 1, actorEpoch: 2, actorActive: true },
  recipientActive: true, recipientEpoch: 3, practiceEpoch: 4, practiceOperational: true, contextHash: 'c'.repeat(64),
};
function signed(p = payload) { return { payload: p, proof: selectivePracticeProof(key, 'grant', p), revokedAt: null }; }

test('a current personal practice selection returns only chosen scalar values', () => {
  const valid = readSelectivePracticeGrant(signed(), key, admission, now);
  assert.ok(valid);
  const projected = selectivePracticeGrantProjection({ id: 'practice-synthetic', title: 'Cliente sintetico', status: 'attivo',
    notes: 'PRIVATE', leadId: 'HIDDEN_LEAD', companies: [{ name: 'HIDDEN_COMPANY' }] }, valid);
  assert.equal(projected.length, 2);
  assert.doesNotMatch(JSON.stringify(projected), /PRIVATE|HIDDEN/);
  assert.throws(() => selectivePracticeGrantProjection({ id: 'another-practice' }, valid));
});

test('expired/revoked grants and changed lifecycle generations remain denied after restoration', () => {
  assert.equal(readSelectivePracticeGrant({ ...signed(), revokedAt: new Date(now).toISOString() }, key, admission, now), null);
  const limited = signed({ ...payload, selection: { ...payload.selection, expiresAt: new Date(now + 1).toISOString() } });
  assert.ok(readSelectivePracticeGrant(limited, key, admission, now));
  assert.equal(readSelectivePracticeGrant(limited, key, admission, now + 1), null);
  assert.equal(readSelectivePracticeGrant(signed(), key, { ...admission, practiceOperational: false }, now), null);
  assert.equal(readSelectivePracticeGrant(signed(), key, { ...admission, practiceEpoch: 5 }, now), null);
});

test('current actor/recipient authority and identity generations cannot be inherited from another binding', () => {
  for (const delta of [{ enabled: false }, { actorActive: false }, { userId: 'another-admin' }, { revision: 2 }, { actorEpoch: 3 }]) {
    assert.equal(readSelectivePracticeGrant(signed(), key, { ...admission, authority: { ...admission.authority, ...delta } }, now), null);
  }
  for (const delta of [{ recipientActive: false }, { recipientEpoch: 4 }, { recipientId: 'another-user' }, { practiceId: 'another-practice' }, { contextHash: 'b'.repeat(64) }, { revision: 2 }]) {
    assert.equal(readSelectivePracticeGrant(signed(), key, { ...admission, ...delta }, now), null);
  }
});

test('cross-protocol proof, tampering, self-grant, future date and stale key cannot admit a practice', () => {
  assert.equal(readSelectivePracticeGrant({ ...signed(), proof: selectiveLeadProof(key, 'grant', payload) }, key, admission, now), null);
  assert.equal(readSelectivePracticeGrant({ ...signed(), proof: selectivePracticeProof(key, 'preview', payload) }, key, admission, now), null);
  assert.equal(readSelectivePracticeGrant({ ...signed(), payload: { ...payload, selection: { ...payload.selection, fields: ['practiceType'] } } }, key, admission, now), null);
  assert.equal(readSelectivePracticeGrant(signed({ ...payload, approvedById: admission.recipientId }), key,
    { ...admission, authority: { ...admission.authority, userId: admission.recipientId } }, now), null);
  assert.equal(readSelectivePracticeGrant(signed({ ...payload, approvedAt: new Date(now + 1).toISOString() }), key, admission, now), null);
  assert.equal(readSelectivePracticeGrant(signed(), { ...key, version: 4 }, admission, now), null);
  assert.equal(readSelectivePracticeGrant(signed(), key, admission, NaN), null);
});
