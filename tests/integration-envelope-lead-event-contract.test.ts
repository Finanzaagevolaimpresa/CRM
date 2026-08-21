import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import {
  compareLeadEventIdempotencyV1,
  createLeadSubmittedEventV1,
  LeadEventContractError,
  LEAD_EVENT_CANONICALIZATION_VERSION,
  LEAD_EVENT_SCHEMA_VERSION,
  LEAD_EVENT_TYPE,
  LEAD_EVENT_VERSION,
  MAX_LEAD_EVENT_BYTES,
  parseLeadSubmittedEventV1,
  type LeadEventContractErrorCode,
} from '../src/lib/lead-event-contract';
import {
  SYNTHETIC_LEAD_EVENT_V1,
  syntheticLeadEventInputV1,
} from './fixtures/n10-lead-event-v1';

function expectContractError(code: LeadEventContractErrorCode, operation: () => unknown) {
  assert.throws(
    operation,
    (error: unknown) => error instanceof LeadEventContractError
      && error.code === code
      && error.message === code,
  );
}

test('N10 creates one strict, classified and bounded LEAD_SUBMITTED business envelope', () => {
  const event = SYNTHETIC_LEAD_EVENT_V1;
  assert.equal(event.schemaVersion, LEAD_EVENT_SCHEMA_VERSION);
  assert.equal(event.eventType, LEAD_EVENT_TYPE);
  assert.equal(event.eventVersion, LEAD_EVENT_VERSION);
  assert.equal(event.idempotency.canonicalizationVersion, LEAD_EVENT_CANONICALIZATION_VERSION);
  assert.match(event.idempotency.keyDigest, /^[0-9a-f]{64}$/);
  assert.match(event.idempotency.payloadHash, /^[0-9a-f]{64}$/);
  assert.ok(Buffer.byteLength(JSON.stringify(event), 'utf8') <= MAX_LEAD_EVENT_BYTES);
  assert.equal(Object.isFrozen(event), true);
  assert.equal(Object.isFrozen(event.payload), true);
  assert.deepEqual(parseLeadSubmittedEventV1(event), event);
});

test('N10 keeps marketing explicit and permits an absent catalog reference without inference', () => {
  const input = syntheticLeadEventInputV1();
  const granted = createLeadSubmittedEventV1({
    ...input,
    catalogReference: null,
    privacy: {
      ...input.privacy,
      marketing: { ...input.privacy.marketing, decision: 'GRANTED' },
    },
  });
  assert.equal(granted.privacy.marketing.decision, 'GRANTED');
  assert.equal(granted.catalogReference, null);
  assert.equal(granted.payload.serviceInterestText, 'Synthetic service request');
});

test('N10 canonicalization is deterministic across UTC offsets, Unicode and normalized contact data', () => {
  const firstInput = syntheticLeadEventInputV1();
  const first = createLeadSubmittedEventV1({
    ...firstInput,
    eventId: firstInput.eventId.toUpperCase(),
    occurredAt: '2026-08-19T14:00:00+02:00',
    payload: {
      ...firstInput.payload,
      companyName: 'Cafe\u0301 Synthetic',
      email: '  SYNTHETIC.LEAD@N10.INVALID  ',
      phone: '+39 333 000 0010',
    },
  });
  const secondInput = syntheticLeadEventInputV1();
  const second = createLeadSubmittedEventV1({
    ...secondInput,
    payload: {
      ...secondInput.payload,
      companyName: 'Caf\u00e9 Synthetic',
      email: 'synthetic.lead@n10.invalid',
      phone: '+393330000010',
    },
  });
  assert.equal(first.eventId, firstInput.eventId);
  assert.equal(first.occurredAt, '2026-08-19T12:00:00.000Z');
  assert.equal(first.idempotency.keyDigest, second.idempotency.keyDigest);
  assert.equal(first.idempotency.payloadHash, second.idempotency.payloadHash);
  assert.deepEqual(first, second);
});

test('N10 timestamp profile preserves milliseconds and rejects unsupported boundaries', () => {
  const input = syntheticLeadEventInputV1();
  const event = createLeadSubmittedEventV1({
    ...input,
    occurredAt: '2026-08-19T14:00:00.123+02:00',
  });
  assert.equal(event.occurredAt, '2026-08-19T12:00:00.123Z');
  const lowerBoundary = createLeadSubmittedEventV1({
    ...input,
    occurredAt: '0000-02-29T12:00:00Z',
  });
  const upperBoundary = createLeadSubmittedEventV1({
    ...input,
    occurredAt: '9999-12-31T23:59:59Z',
  });
  assert.equal(lowerBoundary.occurredAt, '0000-02-29T12:00:00.000Z');
  assert.equal(upperBoundary.occurredAt, '9999-12-31T23:59:59.000Z');
  assert.deepEqual(parseLeadSubmittedEventV1(lowerBoundary), lowerBoundary);
  assert.deepEqual(parseLeadSubmittedEventV1(upperBoundary), upperBoundary);
  for (const unsupportedTimestamp of [
    '2026-08-19T12:00:00.1234Z',
    '2026-08-19T12:00:00.123456789Z',
    '2016-12-31T23:59:60Z',
    '9999-12-31T23:59:59-01:00',
    '0000-01-01T00:00:00+01:00',
  ]) {
    expectContractError('LEAD_EVENT_FIELD_INVALID', () => createLeadSubmittedEventV1({
      ...input,
      occurredAt: unsupportedTimestamp,
    }));
  }
});

test('N10 normalizes blank optional contact and source path fields as absent', () => {
  const input = syntheticLeadEventInputV1();
  const phoneOnly = createLeadSubmittedEventV1({
    ...input,
    payload: {
      ...input.payload,
      email: '   ',
      sourcePagePath: '   ',
    },
  });
  assert.equal(Object.hasOwn(phoneOnly.payload, 'email'), false);
  assert.equal(Object.hasOwn(phoneOnly.payload, 'sourcePagePath'), false);
  assert.equal(phoneOnly.payload.phone, '+393330000010');

  const emailOnly = createLeadSubmittedEventV1({
    ...input,
    payload: { ...input.payload, phone: '   ' },
  });
  assert.equal(Object.hasOwn(emailOnly.payload, 'phone'), false);
  assert.equal(emailOnly.payload.email, 'synthetic.lead@n10.invalid');
});

test('N10 hashes use separated identity and payload semantics', () => {
  const input = syntheticLeadEventInputV1();
  const original = createLeadSubmittedEventV1(input);
  const changedPayload = createLeadSubmittedEventV1({
    ...input,
    payload: { ...input.payload, message: 'A materially different synthetic request.' },
  });
  const changedSubmission = createLeadSubmittedEventV1({
    ...input,
    source: { ...input.source, submissionId: 'SYNTHETIC-000002' },
  });
  assert.equal(original.idempotency.keyDigest, changedPayload.idempotency.keyDigest);
  assert.notEqual(original.idempotency.payloadHash, changedPayload.idempotency.payloadHash);
  assert.notEqual(original.idempotency.keyDigest, changedSubmission.idempotency.keyDigest);
  assert.equal(compareLeadEventIdempotencyV1(null, original), 'NEW');
  assert.equal(compareLeadEventIdempotencyV1(original.idempotency, original), 'REPLAY');
  assert.equal(compareLeadEventIdempotencyV1(original.idempotency, changedPayload), 'CONFLICT');
  assert.equal(compareLeadEventIdempotencyV1(original.idempotency, changedSubmission), 'NEW');
});

test('N10 never treats equal email or phone as technical idempotency', () => {
  const input = syntheticLeadEventInputV1();
  const first = createLeadSubmittedEventV1(input);
  const second = createLeadSubmittedEventV1({
    ...input,
    eventId: '00000000-0000-4000-8000-000000000012',
    source: { ...input.source, submissionId: 'SYNTHETIC-000099' },
  });
  assert.equal(first.payload.email, second.payload.email);
  assert.equal(first.payload.phone, second.payload.phone);
  assert.equal(compareLeadEventIdempotencyV1(first.idempotency, second), 'NEW');
});

test('N10 rejects unknown fields, accessors and non-plain structures without echoing values', () => {
  const input = syntheticLeadEventInputV1();
  expectContractError('LEAD_EVENT_FIELD_UNKNOWN', () => createLeadSubmittedEventV1({
    ...input,
    payload: { ...input.payload, inferredConsent: 'synthetic-private-value' },
  }));
  expectContractError('LEAD_EVENT_ENVELOPE_INVALID', () => createLeadSubmittedEventV1([]));
  const accessor = Object.defineProperty({}, 'eventId', {
    enumerable: true,
    get() { throw new Error('synthetic-private-value'); },
  });
  let caught: unknown;
  try { createLeadSubmittedEventV1(accessor); } catch (error) { caught = error; }
  assert.ok(caught instanceof LeadEventContractError);
  assert.equal(JSON.stringify(caught).includes('synthetic-private-value'), false);

  const nonEnumerable = { ...SYNTHETIC_LEAD_EVENT_V1 };
  Object.defineProperty(nonEnumerable, 'syntheticHiddenField', {
    configurable: true,
    enumerable: false,
    value: 'synthetic-private-value',
  });
  expectContractError('LEAD_EVENT_FIELD_UNKNOWN', () => parseLeadSubmittedEventV1(nonEnumerable));

  const symbolKey = Symbol('synthetic-private-field');
  const symbolBearing = { ...SYNTHETIC_LEAD_EVENT_V1, [symbolKey]: 'synthetic-private-value' };
  expectContractError('LEAD_EVENT_FIELD_UNKNOWN', () => parseLeadSubmittedEventV1(symbolBearing));
});

test('N10 rejects unsupported schema, event type and event version before partial interpretation', () => {
  expectContractError('LEAD_EVENT_SCHEMA_UNSUPPORTED', () => parseLeadSubmittedEventV1({
    ...SYNTHETIC_LEAD_EVENT_V1, schemaVersion: 'fai.lead-event.v2',
  }));
  expectContractError('LEAD_EVENT_SCHEMA_UNSUPPORTED', () => parseLeadSubmittedEventV1({
    schemaVersion: 'fai.lead-event.v2', futureEnvelopeField: true,
  }));
  expectContractError('LEAD_EVENT_TYPE_UNSUPPORTED', () => parseLeadSubmittedEventV1({
    ...SYNTHETIC_LEAD_EVENT_V1, eventType: 'LEAD_PROJECTED',
  }));
  expectContractError('LEAD_EVENT_TYPE_UNSUPPORTED', () => parseLeadSubmittedEventV1({
    schemaVersion: LEAD_EVENT_SCHEMA_VERSION,
    eventType: 'LEAD_PROJECTED',
    futureEventField: true,
  }));
  expectContractError('LEAD_EVENT_VERSION_UNSUPPORTED', () => parseLeadSubmittedEventV1({
    ...SYNTHETIC_LEAD_EVENT_V1, eventVersion: 2,
  }));
  expectContractError('LEAD_EVENT_VERSION_UNSUPPORTED', () => parseLeadSubmittedEventV1({
    schemaVersion: LEAD_EVENT_SCHEMA_VERSION,
    eventType: LEAD_EVENT_TYPE,
    eventVersion: 2,
    futureVersionField: true,
  }));
  expectContractError('LEAD_EVENT_FIELD_UNKNOWN', () => parseLeadSubmittedEventV1({
    ...SYNTHETIC_LEAD_EVENT_V1, unexpectedV1Field: true,
  }));
});

test('N10 validates privacy semantics and catalog references without database or publication claims', () => {
  const input = syntheticLeadEventInputV1();
  expectContractError('LEAD_EVENT_PRIVACY_INVALID', () => createLeadSubmittedEventV1({
    ...input,
    privacy: {
      ...input.privacy,
      service: { ...input.privacy.service, decision: 'GRANTED' },
    },
  }));
  expectContractError('LEAD_EVENT_PRIVACY_INVALID', () => createLeadSubmittedEventV1({
    ...input,
    privacy: { service: input.privacy.service },
  }));
  expectContractError('LEAD_EVENT_CATALOG_REFERENCE_INVALID', () => createLeadSubmittedEventV1({
    ...input,
    catalogReference: {
      catalogVersion: '2026-07-12-v1', serviceCode: 'unknown_service', serviceVersion: 1,
    },
  }));
  expectContractError('LEAD_EVENT_CATALOG_REFERENCE_INVALID', () => createLeadSubmittedEventV1({
    ...input,
    catalogReference: { catalogVersion: '2026-07-12-v1', serviceVersion: 1 },
  }));
});

test('N10 rejects invalid contact, money, source path, control text and oversized envelopes', () => {
  const input = syntheticLeadEventInputV1();
  expectContractError('LEAD_EVENT_FIELD_INVALID', () => createLeadSubmittedEventV1({
    ...input, payload: { firstName: 'No contact' },
  }));
  expectContractError('LEAD_EVENT_FIELD_INVALID', () => createLeadSubmittedEventV1({
    ...input,
    payload: { ...input.payload, email: `${'İ'.repeat(248)}@a.co` },
  }));
  for (const minorUnits of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    expectContractError('LEAD_EVENT_FIELD_INVALID', () => createLeadSubmittedEventV1({
      ...input,
      payload: { ...input.payload, requestedAmount: { currency: 'EUR', minorUnits } },
    }));
  }
  expectContractError('LEAD_EVENT_FIELD_INVALID', () => createLeadSubmittedEventV1({
    ...input, payload: { ...input.payload, sourcePagePath: '/contact/?token=synthetic' },
  }));
  for (const controlWhitespace of ['\t', '\n', '\r']) {
    expectContractError('LEAD_EVENT_FIELD_INVALID', () => createLeadSubmittedEventV1({
      ...input,
      payload: { ...input.payload, sourcePagePath: `/synthetic${controlWhitespace}path` },
    }));
  }
  for (const dotSegmentPath of [
    '/contact/../apply',
    '/./apply',
    '/contact/%2e/apply',
    '/contact/%2e%2e/apply',
    '/contact/.%2E/apply',
    '/contact/%2e./apply',
  ]) {
    expectContractError('LEAD_EVENT_FIELD_INVALID', () => createLeadSubmittedEventV1({
      ...input,
      payload: { ...input.payload, sourcePagePath: dotSegmentPath },
    }));
  }
  expectContractError('LEAD_EVENT_FIELD_INVALID', () => createLeadSubmittedEventV1({
    ...input, payload: { ...input.payload, message: 'synthetic\u202Evalue' },
  }));
  expectContractError('LEAD_EVENT_FIELD_INVALID', () => createLeadSubmittedEventV1({
    ...input, occurredAt: '2026-02-30T12:00:00.000Z',
  }));
  const wide = '\ud83d\ude42';
  expectContractError('LEAD_EVENT_TOO_LARGE', () => createLeadSubmittedEventV1({
    ...input,
    payload: {
      ...input.payload,
      firstName: wide.repeat(500),
      lastName: wide.repeat(500),
      companyName: wide.repeat(500),
      city: wide.repeat(500),
      region: wide.repeat(500),
      interestText: wide.repeat(500),
      serviceInterestText: wide.repeat(500),
      message: wide.repeat(2_000),
    },
  }));
});

test('N10 detects digest tampering and rejects invalid persisted digest state', () => {
  expectContractError('LEAD_EVENT_HASH_INVALID', () => parseLeadSubmittedEventV1({
    ...SYNTHETIC_LEAD_EVENT_V1,
    idempotency: { ...SYNTHETIC_LEAD_EVENT_V1.idempotency, payloadHash: 'a'.repeat(64) },
  }));
  expectContractError('LEAD_EVENT_HASH_INVALID', () => compareLeadEventIdempotencyV1({
    keyDigest: 'invalid', payloadHash: 'b'.repeat(64),
  }, SYNTHETIC_LEAD_EVENT_V1));
  expectContractError('LEAD_EVENT_HASH_INVALID', () => compareLeadEventIdempotencyV1(
    null,
    {
      ...SYNTHETIC_LEAD_EVENT_V1,
      idempotency: { ...SYNTHETIC_LEAD_EVENT_V1.idempotency, keyDigest: 'c'.repeat(64) },
    },
  ));
});

test('N10 remains pure, migration-free, transport-free and distinct from N06', () => {
  const source = readFileSync('src/lib/lead-event-contract.ts', 'utf8');
  for (const forbidden of [
    /operational-telemetry/,
    /@prisma\/client/,
    /next\/server/,
    /process\.env/,
    /\bfetch\s*\(/,
    /from ['"]node:(?:fs|http|https|net|tls)/,
    /service-catalog-publication/,
  ]) assert.doesNotMatch(source, forbidden);
  assert.equal(readdirSync('prisma/migrations').filter((name) => /^\d/.test(name)).length, 39);
});
