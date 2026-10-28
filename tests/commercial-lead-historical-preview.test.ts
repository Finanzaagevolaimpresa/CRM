import assert from 'node:assert/strict';
import test from 'node:test';
import { createHistoricalContactPreview, readHistoricalContactPreview,
  type HistoricalContactPreviewAdmission } from '../src/lib/commercial-lead-historical-preview';
import { historicalEventInstant } from '../src/lib/commercial-lead-historical-view';
import { canonicalJson } from '../src/lib/canonical-json';

const key = { version: 1, secret: 'isolated-historical-preview-secret-0000000000000000' };
const input = () => ({ commandId: '11111111-1111-4111-8111-111111111111', leadId: 'synthetic-lead',
  expectedInboxVersion: 2, expectedAssignmentId: 'synthetic-assignment', occurredAt: '2026-01-05T09:30:00.000Z',
  source: 'EMAIL', evidenceReference: 'Registro sintetico A-1', attested: true });
const admission = (): HistoricalContactPreviewAdmission => ({
  sessionId: '22222222-2222-4222-8222-222222222222', sessionExpiresAt: Date.parse('2026-02-01T12:00:00.000Z'),
  inboxItemId: '33333333-3333-4333-8333-333333333333', cycleId: '44444444-4444-4444-8444-444444444444',
  context: { leadId: 'synthetic-lead', actorId: 'synthetic-owner', actorRole: 'commerciale', sessionLive: true,
    canWriteLead: true, selectiveAccessOnly: false, currentOwnerId: 'synthetic-owner', assignmentId: 'synthetic-assignment',
    acceptedAssignmentId: 'synthetic-assignment', acceptedById: 'synthetic-owner', origin: 'MANUAL_CRM', state: 'OPEN',
    inboxVersion: 2, deleted: false, converted: false, cycleSequence: 1, firstResponseAt: null,
    historicalContactExists: false, initializedAt: '2026-02-01T08:00:00.000Z', recordedAt: '2026-02-01T10:00:00.000Z' },
});
test('preview preserves actual event, initialization and preview time as distinct facts', () => {
  const a = admission(), p = createHistoricalContactPreview(key, input(), a);
  assert.equal(p.input.occurredAt, input().occurredAt);
  assert.equal(p.initializedAt, a.context.initializedAt);
  assert.equal(p.previewedAt, a.context.recordedAt);
  assert.equal(p.expiresAt, '2026-02-01T10:05:00.000Z'); assert.equal(p.slaEffect, 'NO_REWRITE');
  const now = { ...a, context: { ...a.context, recordedAt: '2026-02-01T10:02:00.000Z' } };
  assert.deepEqual(readHistoricalContactPreview(key, p.token, now), p.input);
  assert.equal(a.context.firstResponseAt, null);
});
test('preview expires at the earlier of five minutes and the session expiry', () => {
  for (const sessionExpiresAt of [Date.parse('2026-02-01T10:01:00.000Z'), admission().sessionExpiresAt]) {
    const a = { ...admission(), sessionExpiresAt }, p = createHistoricalContactPreview(key, input(), a);
    const now = { ...a, context: { ...a.context, recordedAt: p.expiresAt } };
    assert.equal(readHistoricalContactPreview(key, p.token, now), null);
    assert.ok(Date.parse(p.expiresAt) <= sessionExpiresAt);
  }
});
test('clock rollback, malformed token and weak or rotated keys are denied', () => {
  const a = admission(), p = createHistoricalContactPreview(key, input(), a);
  assert.equal(readHistoricalContactPreview(key, p.token, { ...a, context: { ...a.context, recordedAt: '2026-02-01T09:59:59.999Z' } }), null);
  for (const token of ['', 'a'.repeat(16001), p.token + '=', '{}', 'a']) assert.equal(readHistoricalContactPreview(key, token, a), null);
  for (const changed of [{ ...key, version: 2 }, { ...key, secret: 'another-isolated-secret-00000000000000000000000000' }, { ...key, secret: 'short' }]) {
    assert.equal(readHistoricalContactPreview(changed, p.token, a), null);
  }
  assert.throws(() => createHistoricalContactPreview({ ...key, secret: 'short' }, input(), a));
});
test('payload content, command, purpose and expiry cannot be altered after preview', () => {
  const a = admission(), p = createHistoricalContactPreview(key, input(), a);
  for (const change of ['source', 'reference', 'command', 'purpose', 'expiry'] as const) {
    const value = JSON.parse(Buffer.from(p.token, 'base64url').toString('utf8'));
    if (change === 'source') value.payload.input.source = 'PHONE';
    if (change === 'reference') value.payload.input.evidenceReference = 'Other synthetic reference';
    if (change === 'command') value.payload.input.commandId = '55555555-5555-4555-8555-555555555555';
    if (change === 'purpose') value.payload.protocol = 'N14_HISTORICAL_CONVERSION_V1';
    if (change === 'expiry') value.payload.expiresAt += 60000;
    assert.equal(readHistoricalContactPreview(key, Buffer.from(canonicalJson(value)).toString('base64url'), a), null);
  }
});
test('current actor, acceptance, assignment, version, permissions and lifecycle are rechecked', () => {
  const a = admission(), p = createHistoricalContactPreview(key, input(), a);
  for (const change of [{ actorId: 'other' }, { actorRole: 'admin' }, { sessionLive: false }, { currentOwnerId: 'other' },
    { acceptedAssignmentId: 'other' }, { assignmentId: 'other' }, { acceptedById: 'other' }, { inboxVersion: 3 },
    { canWriteLead: false }, { selectiveAccessOnly: true }, { state: 'CLOSED' }, { deleted: true }, { converted: true },
    { cycleSequence: 2 }, { firstResponseAt: '2026-02-01T09:00:00.000Z' }, { historicalContactExists: true },
    { initializedAt: '2026-02-01T08:01:00.000Z' }]) {
    assert.equal(readHistoricalContactPreview(key, p.token, { ...a, context: { ...a.context, ...change } }), null);
  }
});
test('session, inbox and cycle cannot be swapped even with the same actor', () => {
  const a = admission(), p = createHistoricalContactPreview(key, input(), a), id = '66666666-6666-4666-8666-666666666666';
  for (const change of [{ sessionId: id }, { inboxItemId: id }, { cycleId: id }, { sessionExpiresAt: a.sessionExpiresAt + 1 }]) {
    assert.equal(readHistoricalContactPreview(key, p.token, { ...a, ...change }), null);
  }
});
test('preview cannot authorize an untrue historical date or a missing attestation', () => {
  assert.throws(() => createHistoricalContactPreview(key, { ...input(), occurredAt: admission().context.initializedAt }, admission()));
  assert.throws(() => createHistoricalContactPreview(key, { ...input(), attested: false }, admission()));
});
test('explicit event offset disambiguates repeated autumn hours and is independent of browser timezone', () => {
  assert.equal(historicalEventInstant('2026-10-25T02:30', '+02:00'), '2026-10-25T00:30:00.000Z');
  assert.equal(historicalEventInstant('2026-10-25T02:30', '+01:00'), '2026-10-25T01:30:00.000Z');
  assert.equal(historicalEventInstant('2026-01-01T00:15', '+01:00'), '2025-12-31T23:15:00.000Z');
  assert.equal(historicalEventInstant('2026-01-01T00:15', '+00:00'), '2026-01-01T00:15:00.000Z');
});
test('event input rejects nonexistent calendar dates, unknown offsets and implicit timezone', () => {
  for (const value of ['2026-02-30T10:00', '2026-01-01T24:00', '2026-01-01T10:60', '2026-13-01T10:00', 'invalid', '2026-01-01']) {
    assert.equal(historicalEventInstant(value, '+01:00'), null);
  }
  for (const offset of ['', 'Europe/Rome', '-03:00', 'constructor']) assert.equal(historicalEventInstant('2026-01-01T10:00', offset), null);
});
