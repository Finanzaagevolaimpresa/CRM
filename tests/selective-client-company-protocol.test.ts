import test from 'node:test';
import assert from 'node:assert/strict';
import { selectiveClientSelectionSchema } from '../src/lib/selective-client-policy';
import { selectiveClientGrantPayloadSchema } from '../src/lib/selective-client-grant';
import { canonicalJson } from '../src/lib/canonical-json';
import { createSelectiveClientPreview, readSelectiveClientPreview } from '../src/lib/selective-client-preview';
import { selectiveClientProof } from '../src/lib/selective-client-proof';
const v1 = { clientId: 'client-synthetic', recipientId: 'recipient-synthetic', revision: 0,
  commandId: '7a7bcc84-aa6d-416c-9c54-f7a5202f6d48', fields: ['displayName'], expiresAt: null };
const v2 = { ...v1, version: 2, documents: [] };
const company = { companyId: 'company-synthetic', fields: ['vatNumber'] };
const v3 = { ...v1, version: 3, fields: [], documents: [], companies: [company] };
const now = Date.parse('2026-10-21T17:00:00Z'), key = { version: 1, secret: 'synthetic-company-protocol-key-only-000000000' };
const admission = { actorId: 'admin-synthetic', sessionId: 'c9cd54fe-5acf-4227-8bf4-1c320e740248',
  authorityRevision: 1, actorEpoch: 1, recipientEpoch: 1, clientEpoch: 1, stateHash: 'a'.repeat(64) };

test('V1 and V2 canonical signatures remain byte-for-byte unchanged, without implicit companies', () => {
  for (const value of [v1, v2]) {
    const parsed = selectiveClientSelectionSchema.parse(value);
    assert.equal(canonicalJson(parsed), canonicalJson(value));
    assert.equal(selectiveClientProof(key, 'grant', parsed), selectiveClientProof(key, 'grant', value));
    assert.equal(Object.hasOwn(parsed, 'companies'), false);
    assert.equal(selectiveClientSelectionSchema.safeParse({ ...value, companies: [] }).success, false);
  }
});
test('V3 permits company-only choices and denies silent defaults, unknown/private fields and duplicates', () => {
  assert.equal(selectiveClientSelectionSchema.safeParse(v3).success, true);
  for (const value of [{ ...v3, companies: undefined }, { ...v3, documents: undefined },
    { ...v3, companies: [] }, { ...v3, companies: [company, company] },
    { ...v3, companies: [{ ...company, fields: [] }] },
    { ...v3, companies: [{ ...company, fields: ['vatNumber', 'vatNumber'] }] },
    { ...v3, companies: [{ ...company, fields: ['financialNotes'] }] },
    { ...v3, companies: [{ ...company, includeFutureCompanies: true }] }]) {
    assert.equal(selectiveClientSelectionSchema.safeParse(value).success, false);
  }
});
test('V3 company snapshots must have the exact selected identities and positive persistent generations', () => {
  const payload = { id: 'c9cd54fe-5acf-4227-8bf4-1c320e740248', selection: v3, revision: 1,
    approvedById: 'admin-synthetic', approvedAt: new Date(now).toISOString(), authorityRevision: 1,
    actorEpoch: 1, recipientEpoch: 1, clientEpoch: 1, keyVersion: 1, documents: [],
    companies: [{ companyId: company.companyId, companyEpoch: 1, stateHash: 'b'.repeat(64) }] };
  assert.ok(selectiveClientGrantPayloadSchema.safeParse(payload).success);
  for (const companies of [undefined, [], [payload.companies[0], payload.companies[0]],
    [{ ...payload.companies[0], companyId: 'other-company' }], [{ ...payload.companies[0], companyEpoch: 0 }]]) {
    assert.equal(selectiveClientGrantPayloadSchema.safeParse({ ...payload, companies }).success, false);
  }
});
test('signed preview binds company identity and field choices and expires without replay extension', () => {
  const token = createSelectiveClientPreview(key, v3, admission, now);
  assert.deepEqual(readSelectiveClientPreview(token, key, admission, now), v3);
  assert.equal(readSelectiveClientPreview(token, key, { ...admission, stateHash: 'b'.repeat(64) }, now), null);
  assert.equal(readSelectiveClientPreview(token, key, admission, now + 300_000), null);
  const envelope = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  envelope.payload.input.companies[0].fields.push('name');
  assert.equal(readSelectiveClientPreview(Buffer.from(canonicalJson(envelope)).toString('base64url'), key, admission, now), null);
});
