import assert from 'node:assert/strict';
import test from 'node:test';
import { createLeadEditPreview, readLeadEditPreview, type LeadEditPreviewAdmission } from '../src/lib/selective-lead-edit-preview';

const now = Date.parse('2026-10-22T08:00:00Z');
const key = { version: 3, secret: 'synthetic-only-edit-preview-secret-not-an-actual-key' };
const selection = {
  protocol: 'SELECTIVE_LEAD_EDIT_SELECTION_V1', leadId: 'lead', recipientId: 'recipient',
  readGrantId: 'c9cd54fe-5acf-4227-8bf4-1c320e740248', readGrantRevision: 1, readGrantProof: 'a'.repeat(64),
  revision: 0, commandId: '7a7bcc84-aa6d-416c-9c54-f7a5202f6d48', fields: ['priority'], expiresAt: null,
};
const admission: LeadEditPreviewAdmission = {
  actorId: 'admin', sessionId: '22435bcc-d7e1-4892-9839-acbe158ca1ac',
  actorEpoch: 1, recipientEpoch: 2, leadEpoch: 3, authorityRevision: 1, readGrantRevision: 1,
  capabilityRevision: 0, stateHash: 'b'.repeat(64), validUntil: now + 600_000,
};
const command = {
  protocol: 'SELECTIVE_LEAD_EDIT_COMMAND_V1', leadId: 'lead',
  readGrantId: selection.readGrantId, readGrantRevision: 1, readGrantProof: selection.readGrantProof,
  capabilityId: '71f517f9-f30c-4a58-9c5f-84344ba93089', capabilityRevision: 1,
  commandId: '485042ef-32e6-464a-99df-60336fccda5b',
  expectedVersion: '2026-10-22T07:59:00.000Z', changes: { priority: 'alta' },
};
const editor = { ...admission, actorId: 'recipient', capabilityRevision: 1 };

test('selection and concrete change previews are separate protocols, never interchangeable approvals', () => {
  const a = createLeadEditPreview('selection', key, selection, admission, now);
  const b = createLeadEditPreview('change', key, command, editor, now);
  assert.deepEqual(readLeadEditPreview('selection', key, a, admission, now), selection);
  assert.deepEqual(readLeadEditPreview('change', key, b, editor, now), command);
  assert.equal(readLeadEditPreview('change', key, a, admission, now), null);
  assert.equal(readLeadEditPreview('selection', key, b, editor, now), null);
  assert.throws(() => createLeadEditPreview('change', key, selection, admission, now));
  assert.throws(() => createLeadEditPreview('selection', key, command, editor, now));
});

test('a preview expires after five minutes or the earlier live session/grant expiry', () => {
  const token = createLeadEditPreview('change', key, command, editor, now);
  assert.ok(readLeadEditPreview('change', key, token, editor, now + 299_999));
  assert.equal(readLeadEditPreview('change', key, token, editor, now + 300_000), null);
  const shorter = { ...editor, validUntil: now + 1000 };
  const short = createLeadEditPreview('change', key, command, shorter, now);
  assert.ok(readLeadEditPreview('change', key, short, shorter, now + 999));
  assert.equal(readLeadEditPreview('change', key, short, shorter, now + 1000), null);
  assert.throws(() => createLeadEditPreview('change', key, command, shorter, now + 1000));
});

test('fresh state/version, actor/session, authority and grant generations are bound to confirmation', () => {
  const token = createLeadEditPreview('change', key, command, editor, now);
  for (const delta of [{ actorId: 'other' }, { sessionId: selection.commandId }, { actorEpoch: 2 },
    { recipientEpoch: 3 }, { leadEpoch: 4 }, { authorityRevision: 2 }, { readGrantRevision: 2 },
    { capabilityRevision: 2 }, { stateHash: 'c'.repeat(64) }, { validUntil: now + 999_999 }]) {
    assert.equal(readLeadEditPreview('change', key, token, { ...editor, ...delta }, now), null);
  }
  assert.throws(() => createLeadEditPreview('change', key, { ...command, capabilityRevision: 2 }, editor, now));
});

test('tampering with values, extra hidden fields, alternate encoding or signing key cannot pass confirmation', () => {
  const token = createLeadEditPreview('change', key, command, editor, now);
  const decoded = JSON.parse(Buffer.from(token, 'base64url').toString('utf-8'));
  decoded.payload.input.changes.priority = 'urgente';
  const tampered = Buffer.from(JSON.stringify(decoded)).toString('base64url');
  assert.equal(readLeadEditPreview('change', key, tampered, editor, now), null);
  assert.equal(readLeadEditPreview('change', { ...key, secret: key.secret + 'changed' }, token, editor, now), null);
  assert.equal(readLeadEditPreview('change', key, token + '=', editor, now), null);
  assert.equal(readLeadEditPreview('change', key, token, editor, now - 1), null);
  assert.equal(readLeadEditPreview('change', key, 'a'.repeat(32_001), editor, now), null);
  assert.throws(() => createLeadEditPreview('change', key, { ...command, changes: { priority: 'alta', notes: 'not selected' } }, editor, now));
});

test('maximum allowed unicode interest remains representable without increasing the token ceiling', () => {
  const input = { ...command, changes: { interest: '漢'.repeat(5000) } };
  const token = createLeadEditPreview('change', key, input, editor, now);
  assert.ok(token.length <= 32_000);
  assert.deepEqual(readLeadEditPreview('change', key, token, editor, now), input);
});
