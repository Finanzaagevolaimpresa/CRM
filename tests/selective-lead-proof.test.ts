import assert from 'node:assert/strict';
import test from 'node:test';
import { selectiveLeadProof, verifySelectiveLeadProof } from '../src/lib/selective-lead-proof';
import { selectiveProof } from '../src/lib/selective-project-proof';

const key = { version: 3, secret: 'synthetic-only-selective-lead-test-key-not-a-credential' };
const value = { leadId: 'synthetic-lead', recipientId: 'synthetic-recipient', fields: ['companyName', 'status'],
  authorityRevision: 2, lifecycleEpoch: 7, revision: 1, actorId: 'synthetic-authority', sessionId: 'synthetic-session',
  commandId: 'synthetic-command', expires: 1000 };

test('project evidence and previews cannot be replayed as a lead grant or command receipt', () => {
  const preview = selectiveLeadProof(key, 'preview', value);
  const project = selectiveProof(key, 'grant', value);
  assert.equal(verifySelectiveLeadProof(key, 'preview', value, preview), true);
  for (const purpose of ['grant', 'receipt'] as const) {
    assert.equal(verifySelectiveLeadProof(key, purpose, value, preview), false);
    assert.equal(verifySelectiveLeadProof(key, purpose, value, project), false);
  }
});

test('changing context, fields, authority, epoch, session, revision or expiry invalidates proof', () => {
  const proof = selectiveLeadProof(key, 'grant', value);
  for (const field of Object.keys(value)) {
    assert.equal(verifySelectiveLeadProof(key, 'grant', { ...value, [field]: 'tampered' }, proof), false, field);
  }
  assert.equal(verifySelectiveLeadProof(key, 'grant', { ...value, fields: ['companyName', 'status', 'email'] }, proof), false);
});

test('key rotation, malformed proofs and unknown protocol purposes fail closed', () => {
  const proof = selectiveLeadProof(key, 'receipt', value);
  assert.equal(verifySelectiveLeadProof({ ...key, version: 4 }, 'receipt', value, proof), false);
  assert.equal(verifySelectiveLeadProof({ ...key, secret: key.secret + '-other' }, 'receipt', value, proof), false);
  for (const candidate of ['', 'a', 'z'.repeat(64), proof.toUpperCase(), proof + '00']) {
    assert.equal(verifySelectiveLeadProof(key, 'receipt', value, candidate), false);
  }
  assert.throws(() => selectiveLeadProof(key, 'email' as 'grant', value));
  assert.throws(() => selectiveLeadProof({ ...key, version: 0 }, 'grant', value));
  assert.throws(() => selectiveLeadProof({ ...key, secret: 'short' }, 'grant', value));
});
