import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson } from '../src/lib/canonical-json';
import { selectiveClientSelectionSchema } from '../src/lib/selective-client-policy';
import { selectiveClientGrantPayloadSchema } from '../src/lib/selective-client-grant';
import { createSelectiveClientPreview, readSelectiveClientPreview } from '../src/lib/selective-client-preview';
import { selectiveClientProof } from '../src/lib/selective-client-proof';
const v1 = { clientId: 'client', recipientId: 'recipient', revision: 0,
  commandId: '7a7bcc84-aa6d-416c-9c54-f7a5202f6d48', fields: ['displayName'], expiresAt: null };
const v2 = { ...v1, version: 2, documents: [] }, v3 = { ...v2, version: 3, companies: [] };
const person = { membershipId: 'membership', companyId: 'company', personId: 'person', fields: ['email'] };
const v4 = { ...v3, version: 4, fields: [], people: [person] };
const now = Date.parse('2026-10-21T22:00:00Z'), key = { version: 1, secret: 'synthetic-person-protocol-key-only-000000000' };
const admission = { actorId: 'admin-synthetic', sessionId: 'c9cd54fe-5acf-4227-8bf4-1c320e740248',
  authorityRevision: 1, actorEpoch: 1, recipientEpoch: 1, clientEpoch: 1, stateHash: 'a'.repeat(64) };
test('V1/V2/V3 signatures remain unchanged; they cannot acquire implicit people arrays', () => {
  for (const value of [v1, v2, v3]) {
    const parsed = selectiveClientSelectionSchema.parse(value);
    assert.equal(canonicalJson(parsed), canonicalJson(value));
    assert.equal(selectiveClientProof(key, 'grant', parsed), selectiveClientProof(key, 'grant', value));
    assert.equal(Object.hasOwn(parsed, 'people'), false);
    assert.equal(selectiveClientSelectionSchema.safeParse({ ...value, people: [] }).success, false);
  }
});
test('V4 permits person-only selection but requires all explicit arrays and nonempty choices', () => {
  assert.ok(selectiveClientSelectionSchema.safeParse(v4).success);
  for (const patch of [{ people: undefined }, { companies: undefined }, { documents: undefined }, { people: [] },
    { people: [person, person] }, { people: [{ ...person, companyId: undefined }] }, { people: [{ ...person, fields: ['notes'] }] }]) {
    assert.equal(selectiveClientSelectionSchema.safeParse({ ...v4, ...patch }).success, false);
  }
});
test('V4 payload snapshots must match membership/company/person exactly and cannot accept extra snapshots', () => {
  const payload = { id: 'c9cd54fe-5acf-4227-8bf4-1c320e740248', selection: v4, revision: 1,
    approvedById: 'admin', approvedAt: new Date(now).toISOString(), authorityRevision: 1,
    actorEpoch: 1, recipientEpoch: 1, clientEpoch: 1, keyVersion: 1, documents: [], companies: [],
    people: [{ membershipId: person.membershipId, companyId: person.companyId, personId: person.personId,
      companyEpoch: 1, membershipEpoch: 1, personEpoch: 1, stateHash: 'b'.repeat(64) }] };
  assert.ok(selectiveClientGrantPayloadSchema.safeParse(payload).success);
  for (const people of [undefined, [], [payload.people[0], payload.people[0]], ...['membershipId', 'companyId', 'personId'].map(key => [{ ...payload.people[0], [key]: 'other' }])]) {
    assert.equal(selectiveClientGrantPayloadSchema.safeParse({ ...payload, people }).success, false);
  }
});
test('person preview binds exact content and context without extending expiry or permitting modified choices', () => {
  const token = createSelectiveClientPreview(key, v4, admission, now);
  assert.deepEqual(readSelectiveClientPreview(token, key, admission, now), v4);
  assert.equal(readSelectiveClientPreview(token, key, { ...admission, stateHash: 'b'.repeat(64) }, now), null);
  assert.equal(readSelectiveClientPreview(token, key, admission, now + 300_000), null);
  const envelope = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  envelope.payload.input.people[0].fields.push('firstName');
  assert.equal(readSelectiveClientPreview(Buffer.from(canonicalJson(envelope)).toString('base64url'), key, admission, now), null);
});
