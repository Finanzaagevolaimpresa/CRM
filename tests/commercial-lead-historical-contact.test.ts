import assert from 'node:assert/strict';
import test from 'node:test';
import {
  historicalContactAudit, historicalContactInput, HistoricalContactError, prepareHistoricalContact, prepareHistoricalConversion,
  type HistoricalContactContext,
} from '../src/lib/commercial-lead-historical-contact-contract';

const form = () => ({ commandId: '11111111-1111-4111-8111-111111111111', leadId: 'synthetic-lead',
  expectedInboxVersion: 2, expectedAssignmentId: 'synthetic-assignment', occurredAt: '2026-01-05T09:30:00.000Z',
  source: 'EMAIL', evidenceReference: 'Registro sintetico, riferimento A-1', attested: true });
const context = (): HistoricalContactContext => ({ leadId: 'synthetic-lead', actorId: 'synthetic-commercial-a', actorRole: 'commerciale',
  sessionLive: true, canWriteLead: true, selectiveAccessOnly: false, currentOwnerId: 'synthetic-commercial-a',
  assignmentId: 'synthetic-assignment', acceptedAssignmentId: 'synthetic-assignment', acceptedById: 'synthetic-commercial-a',
  origin: 'MANUAL_CRM', state: 'OPEN', inboxVersion: 2, deleted: false, converted: false, cycleSequence: 1,
  firstResponseAt: null, historicalContactExists: false, initializedAt: '2026-02-01T08:00:00.000Z', recordedAt: '2026-02-01T10:00:00.000Z' });
const rejects = (action: () => unknown, code: HistoricalContactError['code']) => assert.throws(action,
  (error: unknown) => error instanceof HistoricalContactError && error.code === code);

test('real occurrence and database registration remain distinct without rewriting SLA', () => {
  const before = context();
  const value = prepareHistoricalContact(historicalContactInput(form()), before);
  assert.equal(value.occurredAt, '2026-01-05T09:30:00.000Z');
  assert.equal(value.recordedAt, '2026-02-01T10:00:00.000Z');
  assert.equal(value.slaEffect, 'NO_REWRITE');
  assert.equal(before.firstResponseAt, null);
  assert.equal(before.inboxVersion, 2);
});

test('dates must be explicit UTC instants and existing calendar dates', () => {
  for (const occurredAt of ['2026-02-30T08:00:00.000Z', '2026-01-01', '2026-01-01T08:00:00', '2026-01-01T08:00:00+01:00', 'invalid']) {
    rejects(() => historicalContactInput({ ...form(), occurredAt }), 'INVALID_INPUT');
  }
});

test('same-time, later or future occurrences cannot become historical evidence', () => {
  for (const occurredAt of [context().initializedAt, context().recordedAt, '2027-01-01T00:00:00.000Z']) {
    rejects(() => prepareHistoricalContact(historicalContactInput({ ...form(), occurredAt }), context()), 'NOT_HISTORICAL');
  }
  rejects(() => prepareHistoricalContact(historicalContactInput(form()), { ...context(), recordedAt: '2025-01-01T00:00:00.000Z' }), 'NOT_HISTORICAL');
});

test('an explicit attestation, known source, bounded reference and UUID command are required', () => {
  const invalid = [{ attested: false }, { attested: 'true' }, { source: 'UNKNOWN' }, { evidenceReference: '' },
    { evidenceReference: 'x'.repeat(501) }, { evidenceReference: 'one\ntwo' }, { commandId: 'reused arbitrary string' },
    { expectedInboxVersion: 0 }, { expectedInboxVersion: 1.5 }, { leadId: '' }, { expectedAssignmentId: '' }, { unexpected: true }];
  for (const mutation of invalid) rejects(() => historicalContactInput({ ...form(), ...mutation }), 'INVALID_INPUT');
});

test('Admin, another commercial, expired session and read-only grants cannot attest for the owner', () => {
  const invalid = [{ actorRole: 'admin' }, { actorId: 'synthetic-commercial-b' }, { sessionLive: false },
    { canWriteLead: false }, { selectiveAccessOnly: true }, { currentOwnerId: null }];
  for (const mutation of invalid) rejects(() => prepareHistoricalContact(historicalContactInput(form()), { ...context(), ...mutation }), 'NOT_AUTHORIZED');
});

test('assignment changes including A-B-A require the new current personal acceptance', () => {
  const invalid = [{ assignmentId: 'new-assignment' }, { acceptedAssignmentId: 'old-assignment' },
    { acceptedById: 'synthetic-commercial-b' }, { acceptedAssignmentId: null }];
  for (const mutation of invalid) rejects(() => prepareHistoricalContact(historicalContactInput(form()), { ...context(), ...mutation }), 'STALE_CONTEXT');
});

test('stale version, different record, trash, conversion, website origin and reopened cycle are denied', () => {
  const invalid = [{ inboxVersion: 3 }, { leadId: 'other-lead' }, { deleted: true }, { converted: true },
    { origin: 'PROJECTED_NEW' }, { state: 'CLOSED' }, { cycleSequence: 2 }];
  for (const mutation of invalid) rejects(() => prepareHistoricalContact(historicalContactInput(form()), { ...context(), ...mutation }), 'STALE_CONTEXT');
});

test('an existing live response or historical evidence cannot be overwritten', () => {
  rejects(() => prepareHistoricalContact(historicalContactInput(form()), { ...context(), firstResponseAt: context().recordedAt }), 'ALREADY_RECORDED');
  rejects(() => prepareHistoricalContact(historicalContactInput(form()), { ...context(), historicalContactExists: true }), 'ALREADY_RECORDED');
});

test('payload digest binds the exact attestation, owner and current assignment', () => {
  const input = historicalContactInput(form());
  const first = prepareHistoricalContact(input, context());
  assert.equal(first.payloadHash, prepareHistoricalContact(input, context()).payloadHash);
  for (const mutation of [{ occurredAt: '2026-01-04T09:30:00.000Z' }, { source: 'PHONE' }, { evidenceReference: 'Different synthetic proof' }]) {
    assert.notEqual(first.payloadHash, prepareHistoricalContact(historicalContactInput({ ...form(), ...mutation }), context()).payloadHash);
  }
  const next = { ...context(), actorId: 'synthetic-commercial-b', currentOwnerId: 'synthetic-commercial-b', acceptedById: 'synthetic-commercial-b' };
  assert.notEqual(first.payloadHash, prepareHistoricalContact(input, next).payloadHash);
});

test('normalized equivalent references keep the same digest', () => {
  const one = historicalContactInput({ ...form(), evidenceReference: '  Caffè sintetico  ' });
  const two = historicalContactInput({ ...form(), evidenceReference: 'Caffe\u0300 sintetico' });
  assert.equal(prepareHistoricalContact(one, context()).payloadHash, prepareHistoricalContact(two, context()).payloadHash);
});

test('audit omits the source reference, dates, contact details and raw payload', () => {
  const prepared = prepareHistoricalContact(historicalContactInput(form()), context());
  assert.deepEqual(historicalContactAudit('synthetic-receipt', prepared), {
    type: 'N14_HISTORICAL_CONTACT_V1', recordId: 'synthetic-receipt', beforeVersion: 2, afterVersion: 3, outcome: 'NO_REWRITE',
  });
});

test('a caller cannot skip normalization by passing an already typed object', () => {
  const valid = historicalContactInput(form());
  rejects(() => prepareHistoricalContact({ ...valid, attested: false } as unknown as typeof valid, context()), 'INVALID_INPUT');
  rejects(() => prepareHistoricalContact({ ...valid, occurredAt: 'invalid' }, context()), 'INVALID_INPUT');
});

const receipt = () => {
  const prepared = prepareHistoricalContact(historicalContactInput(form()), context());
  return { id: 'synthetic-receipt', input: historicalContactInput(form()), actorId: context().actorId,
    recordedAt: context().recordedAt, inboxItemId: 'synthetic-inbox', cycleId: 'synthetic-cycle',
    inboxVersionAfter: 3, payloadHash: prepared.payloadHash };
};
const conversionContext = () => ({ ...context(), canCreateClient: true, historicalContactExists: true,
  inboxVersion: 3, inboxItemId: 'synthetic-inbox', cycleId: 'synthetic-cycle', recordedAt: '2026-02-02T08:00:00.000Z' });

test('historical conversion has a distinct basis and never manufactures a live first response', () => {
  const result = prepareHistoricalConversion(receipt(), conversionContext());
  assert.equal(result.basis, 'HISTORICAL_CONTACT_BEFORE_CRM');
  assert.equal(result.firstResponseAt, null);
  assert.equal(result.occurredAt, form().occurredAt);
  assert.equal(result.recordedAt, receipt().recordedAt);
});

test('historical conversion rechecks current session, write permissions and client creation', () => {
  for (const change of [{ sessionLive: false }, { canCreateClient: false }, { canWriteLead: false },
    { selectiveAccessOnly: true }, { actorRole: 'admin' }]) {
    rejects(() => prepareHistoricalConversion(receipt(), { ...conversionContext(), ...change }), 'NOT_AUTHORIZED');
  }
});

test('historical evidence does not survive a changed assignee or a new acceptance cycle', () => {
  rejects(() => prepareHistoricalConversion(receipt(), { ...conversionContext(), actorId: 'synthetic-commercial-b' }), 'STALE_CONTEXT');
  rejects(() => prepareHistoricalConversion(receipt(), { ...conversionContext(), assignmentId: 'assignment-after-a-b-a' }), 'STALE_CONTEXT');
  rejects(() => prepareHistoricalConversion(receipt(), { ...conversionContext(), acceptedAssignmentId: null }), 'STALE_CONTEXT');
});

test('another inbox, reopened cycle, trashed or converted lead cannot consume the evidence', () => {
  for (const change of [{ inboxItemId: 'other-inbox' }, { cycleId: 'other-cycle' }, { cycleSequence: 2 },
    { deleted: true }, { converted: true }, { state: 'CLOSED' }, { historicalContactExists: false }]) {
    rejects(() => prepareHistoricalConversion(receipt(), { ...conversionContext(), ...change }), 'STALE_CONTEXT');
  }
});

test('receipt integrity and monotonic versions must be preserved before conversion', () => {
  for (const change of [{ payloadHash: '0'.repeat(64) }, { inboxVersionAfter: 4 },
    { recordedAt: '2027-01-01T00:00:00.000Z' }, { actorId: 'synthetic-commercial-b' }]) {
    rejects(() => prepareHistoricalConversion({ ...receipt(), ...change }, conversionContext()), 'STALE_CONTEXT');
  }
  rejects(() => prepareHistoricalConversion(receipt(), { ...conversionContext(), inboxVersion: 2 }), 'STALE_CONTEXT');
  rejects(() => prepareHistoricalConversion({ ...receipt(), input: historicalContactInput({ ...form(), evidenceReference: 'Altered reference' }) }, conversionContext()), 'STALE_CONTEXT');
});

test('recorded live responses stay authoritative and cannot be reclassified as historical', () => {
  rejects(() => prepareHistoricalConversion(receipt(), { ...conversionContext(), firstResponseAt: context().recordedAt }), 'ALREADY_RECORDED');
});
