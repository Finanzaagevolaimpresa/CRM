import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalJson } from '../src/lib/canonical-json';
import { createSelectiveLeadPreview, readSelectiveLeadPreview } from '../src/lib/selective-lead-preview';

const key = { version: 3, secret: 'synthetic-only-lead-preview-key-not-an-actual-credential' };
const now = Date.parse('2026-10-18T11:00:00Z');
const input = { leadId: 'synthetic-lead', recipientId: 'synthetic-recipient', revision: 0,
  commandId: '7a7bcc84-aa6d-416c-9c54-f7a5202f6d48', fields: ['companyName', 'status'], expiresAt: null };
const admission = { actorId: 'synthetic-admin', sessionId: '0ef3a22d-3574-4230-8434-1e13afdd81f6',
  authorityRevision: 1, actorEpoch: 2, recipientEpoch: 3, leadEpoch: 4, stateHash: 'a'.repeat(64) };
const token = createSelectiveLeadPreview(key, input, admission, now);

test('preview binds the exact two-field command without granting anything', () => {
  assert.deepEqual(readSelectiveLeadPreview(token, key, admission, now), input);
  assert.equal(readSelectiveLeadPreview(token, key, admission, now - 1), null);
});

test('role, authority, session, recipient and lead lifecycle changes invalidate a stale preview', () => {
  for (const field of ['authorityRevision', 'actorEpoch', 'recipientEpoch', 'leadEpoch'] as const) {
    assert.equal(readSelectiveLeadPreview(token, key, { ...admission, [field]: admission[field] + 1 }, now), null, field);
  }
  for (const changed of [{ actorId: 'other-admin' }, { sessionId: '9a27c9e2-17cd-4610-881f-990a448e7cf8' }, { stateHash: 'b'.repeat(64) }]) {
    assert.equal(readSelectiveLeadPreview(token, key, { ...admission, ...changed }, now), null);
  }
});

test('expiry is strict at the boundary and is checked again after a simulated lock wait', () => {
  assert.ok(readSelectiveLeadPreview(token, key, admission, now + 299_999));
  assert.equal(readSelectiveLeadPreview(token, key, admission, now + 300_000), null);
  const selection = { ...input, expiresAt: new Date(now + 1000).toISOString() };
  const limited = createSelectiveLeadPreview(key, selection, admission, now);
  assert.equal(readSelectiveLeadPreview(limited, key, admission, now + 1000), null);
  assert.throws(() => createSelectiveLeadPreview(key, { ...selection, expiresAt: new Date(now).toISOString() }, admission, now));
});

test('tampering with selected fields, context or command is rejected', () => {
  const envelope = JSON.parse(Buffer.from(token, 'base64url').toString());
  for (const changed of [{ fields: ['companyName', 'status', 'email'] }, { leadId: 'other-lead' }, { recipientId: 'other-user' },
    { commandId: 'c9cd54fe-5acf-4227-8bf4-1c320e740248' }]) {
    const forged = { ...envelope, payload: { ...envelope.payload, input: { ...input, ...changed } } };
    const encoded = Buffer.from(canonicalJson(forged)).toString('base64url');
    assert.equal(readSelectiveLeadPreview(encoded, key, admission, now), null);
  }
});

test('rotated keys, malformed or oversized tokens and noncanonical payloads fail closed', () => {
  assert.equal(readSelectiveLeadPreview(token, { ...key, version: 4 }, admission, now), null);
  assert.equal(readSelectiveLeadPreview(token, { ...key, secret: key.secret + '-other' }, admission, now), null);
  for (const bad of ['', '*', 'a'.repeat(12_001), token + '=', Buffer.from('{}').toString('base64url')]) {
    assert.equal(readSelectiveLeadPreview(bad, key, admission, now), null);
  }
  assert.equal(readSelectiveLeadPreview(token, key, admission, NaN), null);
});
