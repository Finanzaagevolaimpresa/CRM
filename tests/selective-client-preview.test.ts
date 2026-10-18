import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalJson } from '../src/lib/canonical-json';
import { createSelectiveClientPreview, readSelectiveClientPreview } from '../src/lib/selective-client-preview';
import { selectiveClientProof } from '../src/lib/selective-client-proof';
import { selectiveLeadProof } from '../src/lib/selective-lead-proof';

const key = { version: 3, secret: 'synthetic-client-preview-key-no-real-credential' };
const now = Date.parse('2026-10-18T13:00:00Z');
const input = { clientId: 'client-synthetic', recipientId: 'recipient-synthetic', revision: 0,
  commandId: '7a7bcc84-aa6d-416c-9c54-f7a5202f6d48', fields: ['displayName', 'status'], expiresAt: null };
const admission = { actorId: 'admin-synthetic', sessionId: '0ef3a22d-3574-4230-8434-1e13afdd81f6',
  authorityRevision: 1, actorEpoch: 2, recipientEpoch: 3, clientEpoch: 4, stateHash: 'a'.repeat(64) };
const token = createSelectiveClientPreview(key, input, admission, now);

test('preview authenticates the exact client selection but creates no permission', () => {
  assert.deepEqual(readSelectiveClientPreview(token, key, admission, now), input);
  assert.equal(readSelectiveClientPreview(token, key, admission, now - 1), null);
});

test('session, owner, identity, content or authority changes invalidate preview', () => {
  for (const field of ['authorityRevision', 'actorEpoch', 'recipientEpoch', 'clientEpoch'] as const) {
    assert.equal(readSelectiveClientPreview(token, key, { ...admission, [field]: admission[field] + 1 }, now), null);
  }
  for (const delta of [{ actorId: 'another-admin' }, { sessionId: '9a27c9e2-17cd-4610-881f-990a448e7cf8' }, { stateHash: 'b'.repeat(64) }]) {
    assert.equal(readSelectiveClientPreview(token, key, { ...admission, ...delta }, now), null);
  }
});

test('expiry is strict after a simulated lock wait and cannot be renewed implicitly', () => {
  assert.ok(readSelectiveClientPreview(token, key, admission, now + 299_999));
  assert.equal(readSelectiveClientPreview(token, key, admission, now + 300_000), null);
  const limited = createSelectiveClientPreview(key, { ...input, expiresAt: new Date(now + 1).toISOString() }, admission, now);
  assert.equal(readSelectiveClientPreview(limited, key, admission, now + 1), null);
  assert.throws(() => createSelectiveClientPreview(key, { ...input, expiresAt: new Date(now).toISOString() }, admission, now));
});

test('fields, recipient, command and client identity cannot be changed after preview', () => {
  const envelope = JSON.parse(Buffer.from(token, 'base64url').toString());
  for (const delta of [{ fields: ['displayName', 'type', 'status'] }, { clientId: 'another-client' },
    { recipientId: 'another-user' }, { commandId: 'c9cd54fe-5acf-4227-8bf4-1c320e740248' }]) {
    const forged = { ...envelope, payload: { ...envelope.payload, input: { ...input, ...delta } } };
    assert.equal(readSelectiveClientPreview(Buffer.from(canonicalJson(forged)).toString('base64url'), key, admission, now), null);
  }
});

test('lead grants, wrong purpose, wrong keys and malformed tokens cannot be client previews', () => {
  const envelope = JSON.parse(Buffer.from(token, 'base64url').toString());
  for (const proof of [selectiveLeadProof(key, 'preview', envelope.payload), selectiveClientProof(key, 'grant', envelope.payload)]) {
    assert.equal(readSelectiveClientPreview(Buffer.from(canonicalJson({ ...envelope, proof })).toString('base64url'), key, admission, now), null);
  }
  assert.equal(readSelectiveClientPreview(token, { ...key, version: 4 }, admission, now), null);
  assert.equal(readSelectiveClientPreview(token, { ...key, secret: key.secret + 'changed' }, admission, now), null);
  for (const bad of ['', '*', 'a'.repeat(12_001), token + '=', Buffer.from('{}').toString('base64url')]) {
    assert.equal(readSelectiveClientPreview(bad, key, admission, now), null);
  }
});
