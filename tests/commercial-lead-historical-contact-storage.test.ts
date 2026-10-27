import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeHistoricalContactRecord } from '../src/lib/commercial-lead-historical-contact-storage';
import { historicalContactInput } from '../src/lib/commercial-lead-historical-contact-contract';

const row = () => ({
  id: '11111111-1111-4111-8111-111111111111',
  input: historicalContactInput({ commandId: '11111111-1111-4111-8111-111111111111',
    leadId: 'synthetic-lead', expectedAssignmentId: 'synthetic-assignment', expectedInboxVersion: 2,
    occurredAt: '2026-01-05T09:30:00.000Z', source: 'EMAIL', evidenceReference: 'Riferimento sintetico A-1', attested: true }),
  actorId: 'synthetic-commercial', sessionId: '22222222-2222-4222-8222-222222222222',
  inboxItemId: '33333333-3333-4333-8333-333333333333', cycleId: '44444444-4444-4444-8444-444444444444',
  assignmentId: 'synthetic-assignment', recordedAt: new Date('2026-02-01T10:00:00.000Z'),
  inboxVersionBefore: 2, inboxVersionAfter: 3, payloadHash: 'a'.repeat(64),
  auditId: 'synthetic-audit', transactionId: 12345n,
});

test('receipt decoding preserves database registration separately from the declared occurrence', () => {
  const decoded = decodeHistoricalContactRecord(row());
  assert.equal(decoded.input.occurredAt, '2026-01-05T09:30:00.000Z');
  assert.equal(decoded.recordedAt.toISOString(), '2026-02-01T10:00:00.000Z');
  assert.equal(decoded.inboxVersionAfter, 3);
  assert.ok(Object.isFrozen(decoded));
  assert.ok(Object.isFrozen(decoded.input));
});

test('partial or foreign command identity cannot be decoded as a durable receipt', () => {
  for (const change of [{ id: '55555555-5555-4555-8555-555555555555' }, { assignmentId: 'other-assignment' },
    { inboxVersionBefore: 1 }, { inboxVersionAfter: 4 }, { auditId: null }, { transactionId: 0n }]) {
    assert.throws(() => decodeHistoricalContactRecord({ ...row(), ...change }));
  }
});

test('raw browser strings, arrays, null and extended records are not database rows', () => {
  for (const value of [null, [], {}, 'receipt', { ...row(), extra: true },
    { ...row(), recordedAt: '2026-02-01T10:00:00.000Z' }, { ...row(), transactionId: '12345' }]) {
    assert.throws(() => decodeHistoricalContactRecord(value));
  }
});

test('stored input is reparsed and cannot hide undeclared content or replace attestation', () => {
  for (const change of [{ protocol: 'UNKNOWN' }, { unexpected: 'hidden' }, { attested: false },
    { occurredAt: '2026-02-30T09:30:00.000Z' }, { evidenceReference: '' }, { source: 'UNKNOWN' }]) {
    assert.throws(() => decodeHistoricalContactRecord({ ...row(), input: { ...row().input, ...change } }));
  }
});

test('missing session, inbox, cycle and digest keep incomplete receipts unavailable', () => {
  for (const field of ['sessionId', 'inboxItemId', 'cycleId', 'payloadHash']) {
    for (const invalid of [null, '', 'invalid']) assert.throws(() => decodeHistoricalContactRecord({ ...row(), [field]: invalid }));
  }
});
