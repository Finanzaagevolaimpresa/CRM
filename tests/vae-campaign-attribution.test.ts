import assert from 'node:assert/strict';
import test from 'node:test';
import { createLeadSubmittedEventV1, parseLeadSubmittedEventV1, compareLeadEventIdempotencyV1 } from '../src/lib/lead-event-contract';
import { calculateBusinessInboxRecordHash } from '../src/lib/business-event-backbone';
import { verifiedAcquisitionEvent } from '../src/lib/lead-acquisition-contract';
import { syntheticLeadEventInputV1 } from './fixtures/n10-lead-event-v1';

test('VAE platform is separately signed; organic bytes and WordPress identity are preserved', () => {
  const input = syntheticLeadEventInputV1();
  const organic = createLeadSubmittedEventV1(input);
  assert.deepEqual(parseLeadSubmittedEventV1(organic), organic);
  assert.equal(Object.hasOwn(organic.payload, 'campaignPlatform'), false);
  for (const campaignPlatform of ['META', 'CHATGPT'] as const) {
    const event = createLeadSubmittedEventV1({ ...input, payload: { ...input.payload, campaignPlatform, campaignCode: 'VAE-TEST', adCode: 'AD-01' } });
    assert.deepEqual(parseLeadSubmittedEventV1(event), event);
    assert.equal(event.source.systemCode, 'WORDPRESS');
    assert.equal(event.privacy.marketing.decision, 'DENIED');
    assert.equal(event.idempotency.keyDigest, organic.idempotency.keyDigest);
    assert.notEqual(event.idempotency.payloadHash, organic.idempotency.payloadHash);
    assert.equal(compareLeadEventIdempotencyV1(event.idempotency, event), 'REPLAY');
    assert.equal(compareLeadEventIdempotencyV1(organic.idempotency, event), 'CONFLICT');
  }
});

test('VAE rejects unknown platform, retains partial attribution, and detects stored provenance tampering', () => {
  const input = syntheticLeadEventInputV1();
  for (const campaignPlatform of ['OTHER', 'Meta', 'https://example.invalid', 'user@invalid.test', 'META\nFORGED']) {
    assert.throws(() => createLeadSubmittedEventV1({ ...input, payload: { ...input.payload, campaignPlatform } }), /LEAD_EVENT_FIELD_INVALID/);
  }
  const event = createLeadSubmittedEventV1({ ...input, payload: { ...input.payload, campaignPlatform: 'META' } });
  assert.equal(event.payload.campaignCode, undefined);
  const id = '00000000-0000-4000-8000-000000171126';
  const createdAt = new Date('2026-11-17T12:00:00Z');
  const row = { id, createdAt, envelopeJson: JSON.stringify(event), recordHash: calculateBusinessInboxRecordHash(id, event, createdAt) };
  assert.equal(verifiedAcquisitionEvent(row)?.payload.campaignPlatform, 'META');
  assert.equal(verifiedAcquisitionEvent({ ...row, envelopeJson: JSON.stringify({ ...event, payload: { ...event.payload, campaignPlatform: 'CHATGPT' } }) }), null);
});
