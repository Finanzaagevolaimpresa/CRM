import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { canonicalJson } from '../src/lib/canonical-json';
import {
  BUSINESS_EVENT_BACKBONE_ERROR_CODES,
  BUSINESS_EVENT_BACKBONE_MANIFEST,
  BusinessEventBackboneError,
  calculateBusinessInboxRecordHash,
  calculateBusinessOutboxRecordHash,
  calculateBusinessQueueAttemptHash,
  calculateBusinessQueueCompletionHash,
  compareBusinessInboxIdentity,
  createBusinessQueueLeaseToken,
  getBusinessQueueRetryDelaySeconds,
  hashBusinessQueueLeaseToken,
  isBusinessQueueTransitionAllowed,
  normalizeBusinessQueueCode,
  normalizeBusinessQueueFailureCode,
  type BusinessEventBackboneErrorCode,
} from '../src/lib/business-event-backbone';
import { createLeadSubmittedEventV1 } from '../src/lib/lead-event-contract';
import { syntheticLeadEventInputV1 } from './fixtures/n10-lead-event-v1';

function expectBackboneError(
  code: BusinessEventBackboneErrorCode,
  operation: () => unknown,
) {
  assert.throws(
    operation,
    (error: unknown) => error instanceof BusinessEventBackboneError
      && error.code === code
      && error.message === code,
  );
}

function event(overrides: Record<string, unknown> = {}) {
  return createLeadSubmittedEventV1({
    ...syntheticLeadEventInputV1(),
    ...overrides,
  });
}

test('N11 manifest is dormant, bounded and has no runtime producer or consumer', () => {
  assert.equal(BUSINESS_EVENT_BACKBONE_MANIFEST.dormant, true);
  assert.equal(BUSINESS_EVENT_BACKBONE_MANIFEST.activation, 'NONE');
  assert.deepEqual(BUSINESS_EVENT_BACKBONE_MANIFEST.runtimeProducers, []);
  assert.deepEqual(BUSINESS_EVENT_BACKBONE_MANIFEST.runtimeConsumers, []);
  assert.equal(BUSINESS_EVENT_BACKBONE_MANIFEST.maxEnvelopeBytes, 16 * 1024);
  assert.equal(BUSINESS_EVENT_BACKBONE_MANIFEST.maxAttempts, 5);
  assert.equal(BUSINESS_EVENT_BACKBONE_MANIFEST.initialLeaseSeconds, 60);
  assert.equal(BUSINESS_EVENT_BACKBONE_MANIFEST.maximumLeaseSeconds, 300);
  assert.equal(BUSINESS_EVENT_BACKBONE_MANIFEST.maximumRecoveryBatch, 100);
  assert.equal(Object.isFrozen(BUSINESS_EVENT_BACKBONE_MANIFEST), true);
  assert.equal(Object.isFrozen(BUSINESS_EVENT_BACKBONE_MANIFEST.hashDomains), true);
});

test('N11 delegates strict parsing to N10 and preserves canonical envelope bytes', () => {
  const candidate = event();
  const canonical = canonicalJson(candidate);
  assert.equal(Buffer.byteLength(canonical, 'utf8') <= 16 * 1024, true);
  assert.equal(compareBusinessInboxIdentity({ stored: null, candidate }), 'NEW');
  assert.equal(compareBusinessInboxIdentity({
    stored: {
      keyDigest: candidate.idempotency.keyDigest,
      eventId: candidate.eventId,
      payloadHash: candidate.idempotency.payloadHash,
      envelopeJson: canonical,
    },
    candidate,
  }), 'REPLAY');
  expectBackboneError('BUSINESS_INBOX_HASH_INVALID', () => compareBusinessInboxIdentity({
    stored: null,
    candidate: {
      ...candidate,
      idempotency: { ...candidate.idempotency, payloadHash: '0'.repeat(64) },
    },
  }));
});

test('N11 pure idempotency semantics distinguish replay, conflict and independent identity', () => {
  const original = event();
  const canonical = canonicalJson(original);
  const changedPayload = event({
    payload: { ...syntheticLeadEventInputV1().payload, message: 'Synthetic changed request.' },
  });
  const independent = event({
    eventId: '00000000-0000-4000-8000-000000000020',
    source: {
      ...syntheticLeadEventInputV1().source,
      submissionId: 'SYNTHETIC-000020',
    },
  });
  const stored = {
    keyDigest: original.idempotency.keyDigest,
    eventId: original.eventId,
    payloadHash: original.idempotency.payloadHash,
    envelopeJson: canonical,
  };
  assert.equal(compareBusinessInboxIdentity({ stored, candidate: original }), 'REPLAY');
  assert.equal(compareBusinessInboxIdentity({ stored, candidate: changedPayload }), 'CONFLICT');
  assert.equal(compareBusinessInboxIdentity({ stored, candidate: independent }), 'NEW');
});

test('N11 hash domains separate inbox, outbox, lease, attempt and completion', () => {
  const candidate = event();
  const createdAt = new Date('2026-08-20T12:00:00.000Z');
  const inboxId = '00000000-0000-4000-8000-000000000101';
  const outboxId = '00000000-0000-4000-8000-000000000102';
  const inboxHash = calculateBusinessInboxRecordHash(inboxId, candidate, createdAt);
  const outboxHash = calculateBusinessOutboxRecordHash({
    id: outboxId,
    sourceInboxEventId: inboxId,
    producerCode: 'N11_SYNTHETIC',
    destinationCode: 'N11_TEST_DESTINATION',
    event: candidate,
    createdAt,
  });
  const leaseToken = 'ab'.repeat(32);
  const leaseTokenHash = hashBusinessQueueLeaseToken(leaseToken);
  const attemptHash = calculateBusinessQueueAttemptHash({
    attemptId: '00000000-0000-4000-8000-000000000103',
    queueKind: 'INBOX',
    eventRowId: inboxId,
    attemptSequence: 1,
    fencingToken: 1n,
    leaseOwnerId: '00000000-0000-4000-8000-000000000104',
    leaseTokenHash,
    claimedAt: createdAt,
    leaseExpiresAt: new Date(createdAt.getTime() + 60_000),
    leaseMaxExpiresAt: new Date(createdAt.getTime() + 300_000),
  });
  const completionHash = calculateBusinessQueueCompletionHash({
    attemptHash,
    finishedAt: new Date(createdAt.getTime() + 10_000),
    outcome: 'PROCESSED',
    failureCode: null,
    retryable: null,
    nextAvailableAt: null,
  });
  const hashes = [inboxHash, outboxHash, leaseTokenHash, attemptHash, completionHash];
  for (const hash of hashes) assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(new Set(hashes).size, hashes.length);
});

test('N11 validates bounded uppercase codes, UUIDs and canonical 16 KiB envelope limit', () => {
  assert.equal(normalizeBusinessQueueCode('N11_TEST.DESTINATION:V1'), 'N11_TEST.DESTINATION:V1');
  assert.equal(normalizeBusinessQueueFailureCode('SYNTHETIC_FAILURE'), 'SYNTHETIC_FAILURE');
  for (const invalid of ['', 'lowercase', `A${'B'.repeat(80)}`, 'A SPACE']) {
    expectBackboneError('BUSINESS_QUEUE_STATE_CONFLICT', () => normalizeBusinessQueueCode(invalid));
  }
  for (const invalid of ['', 'invalid', 'A-', `A${'B'.repeat(64)}`]) {
    expectBackboneError(
      'BUSINESS_QUEUE_STATE_CONFLICT',
      () => normalizeBusinessQueueFailureCode(invalid),
    );
  }
  expectBackboneError('BUSINESS_QUEUE_STATE_CONFLICT', () => calculateBusinessInboxRecordHash(
    'not-a-uuid',
    event(),
    new Date('2026-08-20T12:00:00.000Z'),
  ));
  expectBackboneError('BUSINESS_INBOX_EVENT_INVALID', () => compareBusinessInboxIdentity({
    stored: null,
    candidate: {
      ...event(),
      payload: {
        ...syntheticLeadEventInputV1().payload,
        message: 'S'.repeat(20_000),
      },
    },
  }));
});

test('N11 retry schedule is exactly 5/30/300/1800 with budget five', () => {
  assert.deepEqual(
    [1, 2, 3, 4].map(getBusinessQueueRetryDelaySeconds),
    [5, 30, 300, 1_800],
  );
  for (const exhausted of [0, 5, 6, 1.5]) {
    expectBackboneError(
      'BUSINESS_QUEUE_RETRY_EXHAUSTED',
      () => getBusinessQueueRetryDelaySeconds(exhausted),
    );
  }
});

test('N11 lease token is random 256-bit material returned raw only by token creation', () => {
  const first = createBusinessQueueLeaseToken();
  const second = createBusinessQueueLeaseToken();
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.match(second, /^[0-9a-f]{64}$/);
  assert.notEqual(first, second);
  assert.notEqual(hashBusinessQueueLeaseToken(first), first);
  assert.notEqual(hashBusinessQueueLeaseToken(first), hashBusinessQueueLeaseToken(second));
  expectBackboneError('BUSINESS_QUEUE_LEASE_STALE', () => hashBusinessQueueLeaseToken('raw'));
  assert.equal(BUSINESS_EVENT_BACKBONE_ERROR_CODES.some((code) => code.includes(first)), false);
});

test('N11 state transition matrix rejects terminal resurrection and cross-queue terminal states', () => {
  assert.equal(isBusinessQueueTransitionAllowed('INBOX', 'AVAILABLE', 'LEASED'), true);
  assert.equal(isBusinessQueueTransitionAllowed('INBOX', 'LEASED', 'LEASED'), true);
  assert.equal(isBusinessQueueTransitionAllowed('INBOX', 'LEASED', 'AVAILABLE'), true);
  assert.equal(isBusinessQueueTransitionAllowed('INBOX', 'LEASED', 'PROCESSED'), true);
  assert.equal(isBusinessQueueTransitionAllowed('INBOX', 'LEASED', 'PUBLISHED'), false);
  assert.equal(isBusinessQueueTransitionAllowed('OUTBOX', 'LEASED', 'PUBLISHED'), true);
  assert.equal(isBusinessQueueTransitionAllowed('OUTBOX', 'LEASED', 'PROCESSED'), false);
  assert.equal(isBusinessQueueTransitionAllowed('INBOX', 'PROCESSED', 'AVAILABLE'), false);
  assert.equal(isBusinessQueueTransitionAllowed('OUTBOX', 'DEAD_LETTER', 'AVAILABLE'), false);
});

test('N11 has no route, worker, script, telemetry, network or provider call site', () => {
  let output = '';
  try {
    output = execFileSync('git', [
      'grep',
      '-n',
      'business-event-backbone',
      '--',
      'src/app',
      'src/components',
      'src/instrumentation.ts',
      'src/middleware.ts',
      'scripts',
      'deploy',
    ], { encoding: 'utf8' });
  } catch (error) {
    const status = (error as { status?: number }).status;
    assert.equal(status, 1);
  }
  assert.equal(output, '');
});

test('N11 test data remains explicitly synthetic and uses reserved domains', () => {
  const candidate = event();
  assert.match(candidate.payload.email ?? '', /@n10\.invalid$/);
  assert.match(candidate.payload.message ?? '', /Synthetic/i);
  assert.equal(JSON.stringify(candidate).includes('.com'), false);
});
