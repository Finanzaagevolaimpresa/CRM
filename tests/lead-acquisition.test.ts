import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateBusinessInboxRecordHash } from '../src/lib/business-event-backbone';
import { acquisitionState, verifiedAcquisitionEvent } from '../src/lib/lead-acquisition-contract';
import { compareLeadEventIdempotencyV1, createLeadSubmittedEventV1, parseLeadSubmittedEventV1 } from '../src/lib/lead-event-contract';
import { syntheticLeadEventInputV1 } from './fixtures/n10-lead-event-v1';

test('M3 campaign codes preserve old envelopes and bind provenance without changing submission identity', () => {
  const input = syntheticLeadEventInputV1();
  const historical = createLeadSubmittedEventV1(input);
  assert.deepEqual(parseLeadSubmittedEventV1(historical), historical);
  assert.equal(Object.hasOwn(historical.payload, 'campaignCode'), false);
  const campaign = createLeadSubmittedEventV1({ ...input, payload: { ...input.payload, campaignCode: 'AUTUNNO-26', adCode: 'META:02' } });
  assert.equal(campaign.idempotency.keyDigest, historical.idempotency.keyDigest);
  assert.notEqual(campaign.idempotency.payloadHash, historical.idempotency.payloadHash);
  assert.equal(compareLeadEventIdempotencyV1(campaign.idempotency, campaign), 'REPLAY');
  assert.equal(compareLeadEventIdempotencyV1(historical.idempotency, campaign), 'CONFLICT');
  const next = createLeadSubmittedEventV1({ ...input, source: { ...input.source, submissionId: 'SECOND-REQUEST' },
    payload: { ...input.payload, campaignCode: 'AUTUNNO-26', message: 'A distinct request from the same person.' } });
  assert.equal(compareLeadEventIdempotencyV1(campaign.idempotency, next), 'NEW');
});

test('M3 optional attribution accepts bounded codes, rejects URLs, query strings and contact fields', () => {
  const input = syntheticLeadEventInputV1();
  for (const key of ['campaignCode', 'adCode']) {
    for (const value of ['https://example.invalid', 'email@example.invalid', 'utm=x&email=y', 'a'.repeat(81), 'two words']) {
      assert.throws(() => createLeadSubmittedEventV1({ ...input, payload: { ...input.payload, [key]: value } }), /LEAD_EVENT_FIELD_INVALID/);
    }
    assert.equal(createLeadSubmittedEventV1({ ...input, payload: { ...input.payload, [key]: 'a'.repeat(80) } }).payload[key as 'adCode'], 'a'.repeat(80));
  }
});

test('M3 receipts fail closed on body, hash, row identity, time or oversize corruption', () => {
  const event = createLeadSubmittedEventV1(syntheticLeadEventInputV1());
  const id = '00000000-0000-4000-8000-000000000303';
  const createdAt = new Date('2026-09-26T10:00:00.000Z');
  const row = { id, createdAt, envelopeJson: JSON.stringify(event), recordHash: calculateBusinessInboxRecordHash(id, event, createdAt) };
  assert.deepEqual(verifiedAcquisitionEvent(row), event);
  for (const changed of [
    { recordHash: '0'.repeat(64) }, { id: '00000000-0000-4000-8000-000000000304' },
    { createdAt: new Date(createdAt.getTime() + 1) }, { envelopeJson: '{' }, { envelopeJson: 'x'.repeat(16_385) },
    { envelopeJson: JSON.stringify({ ...event, payload: { ...event.payload, campaignCode: 'FORGED' } }) },
  ]) assert.equal(verifiedAcquisitionEvent({ ...row, ...changed }), null);
});

test('M3 display distinguishes receipt, retry, ambiguity, successful recovery and unresolved terminal states', () => {
  assert.equal(acquisitionState('AVAILABLE', 0, null), 'RECEIVED');
  assert.equal(acquisitionState('AVAILABLE', 1, null), 'RETRY');
  assert.equal(acquisitionState('LEASED', 2, null), 'PROCESSING');
  assert.equal(acquisitionState('DEAD_LETTER', 5, null), 'ERROR');
  assert.equal(acquisitionState('PROCESSED', 2, 'PROJECTED_NEW'), 'LINKED');
  assert.equal(acquisitionState('PROCESSED', 1, 'REVIEW_REQUIRED'), 'AMBIGUOUS');
  assert.equal(acquisitionState('PROCESSED', 1, 'RESOLVED_EXISTING'), 'LINKED');
  assert.equal(acquisitionState('PROCESSED', 1, null), 'ERROR');
});
