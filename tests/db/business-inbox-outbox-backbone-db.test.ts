import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test, { after, before, beforeEach } from 'node:test';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  BusinessEventBackboneError,
  admitBusinessInboxEvent,
  calculateBusinessQueueAttemptHash,
  claimBusinessQueueEvent,
  completeBusinessQueueEvent,
  enqueueBusinessOutboxEvent,
  failBusinessQueueEvent,
  heartbeatBusinessQueueLease,
  recoverExpiredBusinessQueueLeases,
  type BusinessEventBackboneErrorCode,
  type BusinessQueueKind,
  type BusinessQueueLease,
} from '../../src/lib/business-event-backbone';
import { createLeadSubmittedEventV1 } from '../../src/lib/lead-event-contract';
import { syntheticLeadEventInputV1 } from '../fixtures/n10-lead-event-v1';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from './ai-orchestrator-db-test-guard';

const runDbTests = process.env.RUN_DB_TESTS === '1';
const db = new PrismaClient();
const execFileAsync = promisify(execFile);
const migrationPath = 'prisma/migrations/20260820120000_durable_business_inbox_outbox_backbone_v1/migration.sql';

function uuid(ordinal: number) {
  return `00000000-0000-4000-8000-${ordinal.toString().padStart(12, '0')}`;
}

function syntheticEvent(
  ordinal: number,
  overrides: {
    readonly eventId?: string;
    readonly businessCorrelationId?: string;
    readonly submissionId?: string;
    readonly message?: string;
    readonly email?: string;
  } = {},
) {
  const input = syntheticLeadEventInputV1();
  return createLeadSubmittedEventV1({
    ...input,
    eventId: overrides.eventId ?? uuid(10_000 + ordinal * 2),
    businessCorrelationId: overrides.businessCorrelationId ?? uuid(10_001 + ordinal * 2),
    source: {
      ...input.source,
      submissionId: overrides.submissionId ?? `N11-DB-${ordinal}`,
    },
    payload: {
      ...input.payload,
      email: overrides.email ?? `synthetic-${ordinal}@n11.invalid`,
      message: overrides.message ?? `Synthetic N11 database event ${ordinal}.`,
    },
  });
}

async function assertBound() {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
}

async function cleanN11Tables() {
  await assertBound();
  const tables = [
    'SecureLeadGatewayRequest',
    'SecureLeadGatewayReceipt',
    'SecureLeadGatewayRateLimitBucket',
    'SecureLeadGatewayKeyVersion',
    'BusinessQueueAttempt',
    'BusinessOutboxEvent',
    'BusinessInboxEvent',
  ];
  for (const table of tables) {
    await db.$executeRawUnsafe(`ALTER TABLE "${table}" DISABLE TRIGGER USER`);
  }
  try {
    await db.$executeRawUnsafe(
      `TRUNCATE TABLE ${tables.map((table) => `"${table}"`).join(', ')}`,
    );
  } finally {
    for (const table of [...tables].reverse()) {
      await db.$executeRawUnsafe(`ALTER TABLE "${table}" ENABLE TRIGGER USER`);
    }
  }
}

before(async () => {
  if (!runDbTests) return;
  await assertBound();
});

beforeEach(async () => {
  if (!runDbTests) return;
  await cleanN11Tables();
  await assertBound();
});

after(async () => {
  if (runDbTests) await cleanN11Tables();
  await db.$disconnect();
});

async function expectBackboneRejection(
  code: BusinessEventBackboneErrorCode,
  operation: () => Promise<unknown>,
) {
  await assert.rejects(
    operation,
    (error: unknown) => error instanceof BusinessEventBackboneError
      && error.code === code
      && error.message === code,
  );
}

async function counts() {
  const [inbox, outbox, attempts] = await Promise.all([
    db.businessInboxEvent.count(),
    db.businessOutboxEvent.count(),
    db.businessQueueAttempt.count(),
  ]);
  return { inbox, outbox, attempts };
}

async function forceExpiredLease(queueKind: BusinessQueueKind, eventRowId: string) {
  await assertBound();
  const table = queueKind === 'INBOX' ? 'BusinessInboxEvent' : 'BusinessOutboxEvent';
  const trigger = `${table}_guard_v1`;
  const [timestamps] = await db.$queryRaw<Array<{
    claimedAt: Date;
    leaseExpiresAt: Date;
    leaseMaxExpiresAt: Date;
  }>>(Prisma.sql`
    SELECT
      DATE_TRUNC('milliseconds', clock_timestamp() - interval '120 seconds') AS "claimedAt",
      DATE_TRUNC('milliseconds', clock_timestamp() - interval '60 seconds') AS "leaseExpiresAt",
      DATE_TRUNC('milliseconds', clock_timestamp() - interval '10 seconds') AS "leaseMaxExpiresAt"
  `);
  assert.ok(timestamps);
  const attempt = await db.businessQueueAttempt.findFirstOrThrow({
    where: {
      queueKind,
      finishedAt: null,
      ...(queueKind === 'INBOX'
        ? { inboxEventId: eventRowId }
        : { outboxEventId: eventRowId }),
    },
  });
  const attemptHash = calculateBusinessQueueAttemptHash({
    attemptId: attempt.id,
    queueKind,
    eventRowId,
    attemptSequence: attempt.attemptSequence,
    fencingToken: attempt.fencingToken,
    leaseOwnerId: attempt.leaseOwnerId,
    leaseTokenHash: attempt.leaseTokenHash,
    claimedAt: timestamps.claimedAt,
    leaseExpiresAt: timestamps.leaseExpiresAt,
    leaseMaxExpiresAt: timestamps.leaseMaxExpiresAt,
  });
  await db.$executeRawUnsafe(`ALTER TABLE "${table}" DISABLE TRIGGER "${trigger}"`);
  await db.$executeRawUnsafe(
    'ALTER TABLE "BusinessQueueAttempt" DISABLE TRIGGER "BusinessQueueAttempt_guard_v1"',
  );
  try {
    await db.$executeRaw(Prisma.sql`
      UPDATE ${Prisma.raw(`"${table}"`)}
      SET "leaseClaimedAt" = ${timestamps.claimedAt},
        "leaseExpiresAt" = ${timestamps.leaseExpiresAt},
        "leaseMaxExpiresAt" = ${timestamps.leaseMaxExpiresAt}
      WHERE "id" = ${eventRowId}::UUID
    `);
    await db.$executeRaw(Prisma.sql`
      UPDATE "BusinessQueueAttempt"
      SET "claimedAt" = ${timestamps.claimedAt},
        "leaseExpiresAt" = ${timestamps.leaseExpiresAt},
        "leaseMaxExpiresAt" = ${timestamps.leaseMaxExpiresAt},
        "attemptHash" = ${attemptHash},
        "createdAt" = ${timestamps.claimedAt}
      WHERE "id" = ${attempt.id}::UUID
    `);
  } finally {
    try {
      await db.$executeRawUnsafe(
        'ALTER TABLE "BusinessQueueAttempt" ENABLE TRIGGER "BusinessQueueAttempt_guard_v1"',
      );
    } finally {
      await db.$executeRawUnsafe(`ALTER TABLE "${table}" ENABLE TRIGGER "${trigger}"`);
    }
  }
}

async function forceAvailableNow(queueKind: BusinessQueueKind, eventRowId: string) {
  await assertBound();
  const table = queueKind === 'INBOX' ? 'BusinessInboxEvent' : 'BusinessOutboxEvent';
  const trigger = `${table}_guard_v1`;
  await db.$executeRawUnsafe(`ALTER TABLE "${table}" DISABLE TRIGGER "${trigger}"`);
  try {
    await db.$executeRawUnsafe(
      `UPDATE "${table}" SET "availableAt" = clock_timestamp() - interval '1 second' WHERE "id" = '${eventRowId}'::uuid`,
    );
  } finally {
    await db.$executeRawUnsafe(`ALTER TABLE "${table}" ENABLE TRIGGER "${trigger}"`);
  }
}

async function createInbox(ordinal: number) {
  return admitBusinessInboxEvent(db, syntheticEvent(ordinal));
}

async function createOutbox(ordinal: number, destinationCode = 'N11_SYNTHETIC_DESTINATION') {
  const inbox = await createInbox(ordinal);
  const outbox = await db.$transaction((tx) => enqueueBusinessOutboxEvent(tx, {
    sourceInboxEventId: inbox.inboxEventId,
    producerCode: 'N11_SYNTHETIC_PRODUCER',
    destinationCode,
  }));
  return { inbox, outbox };
}

test('N11 migration 38 creates exactly three empty tables with approved catalog objects', {
  skip: !runDbTests,
}, async () => {
  const [tables, indexes, triggers, functions, migrations] = await Promise.all([
    db.$queryRaw<Array<{ name: string }>>(Prisma.sql`
      SELECT table_name AS "name" FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('BusinessInboxEvent', 'BusinessOutboxEvent', 'BusinessQueueAttempt')
      ORDER BY table_name
    `),
    db.$queryRaw<Array<{ name: string }>>(Prisma.sql`
      SELECT indexname AS "name" FROM pg_indexes
      WHERE schemaname = 'public' AND indexname LIKE 'Business%'
      ORDER BY indexname
    `),
    db.$queryRaw<Array<{ name: string }>>(Prisma.sql`
      SELECT DISTINCT trigger_row.tgname AS "name"
      FROM pg_trigger trigger_row
      JOIN pg_class table_row ON table_row.oid = trigger_row.tgrelid
      WHERE table_row.relnamespace = 'public'::regnamespace
        AND table_row.relname LIKE 'Business%'
        AND NOT trigger_row.tgisinternal
      ORDER BY trigger_row.tgname
    `),
    db.$queryRaw<Array<{ name: string }>>(Prisma.sql`
      SELECT proname AS "name" FROM pg_proc
      WHERE pronamespace = 'public'::regnamespace
        AND proname IN (
          'fai_business_inbox_event_guard_v1',
          'fai_business_outbox_event_guard_v1',
          'fai_business_queue_attempt_guard_v1'
        ) ORDER BY proname
    `),
    db.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
      SELECT COUNT(*)::BIGINT AS "count" FROM "_prisma_migrations"
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
    `),
  ]);
  assert.deepEqual(tables.map(({ name }) => name), [
    'BusinessInboxEvent',
    'BusinessOutboxEvent',
    'BusinessQueueAttempt',
  ]);
  const indexNames = new Set(indexes.map(({ name }) => name));
  for (const expected of [
    'BusinessInboxEvent_claim_idx',
    'BusinessInboxEvent_recovery_idx',
    'BusinessInboxEvent_correlation_idx',
    'BusinessInboxEvent_retention_idx',
    'BusinessInboxEvent_eventId_key',
    'BusinessInboxEvent_keyDigest_key',
    'BusinessOutboxEvent_dedupe_key',
    'BusinessOutboxEvent_claim_idx',
    'BusinessOutboxEvent_recovery_idx',
    'BusinessOutboxEvent_correlation_idx',
    'BusinessOutboxEvent_retention_idx',
    'BusinessOutboxEvent_source_idx',
    'BusinessQueueAttempt_inbox_sequence_key',
    'BusinessQueueAttempt_inbox_fence_key',
    'BusinessQueueAttempt_outbox_sequence_key',
    'BusinessQueueAttempt_outbox_fence_key',
    'BusinessQueueAttempt_open_idx',
  ]) assert.equal(indexNames.has(expected), true, expected);
  assert.equal(triggers.length, 6);
  assert.equal(functions.length, 3);
  assert.equal(Number(migrations[0]?.count), 40);
  assert.deepEqual(await counts(), { inbox: 0, outbox: 0, attempts: 0 });
});

test('N11 migration is additive and contains no business DML, seed, backfill or gate update', () => {
  const migration = readFileSync(migrationPath, 'utf8');
  const executableSql = migration.replace(/^--.*$/gmu, '');
  assert.match(executableSql, /^\s*BEGIN;\s/u);
  assert.match(executableSql, /COMMIT;\s*$/u);
  assert.match(migration, /CREATE TABLE "BusinessInboxEvent"/);
  assert.match(migration, /CREATE TABLE "BusinessOutboxEvent"/);
  assert.match(migration, /CREATE TABLE "BusinessQueueAttempt"/);
  assert.doesNotMatch(executableSql, /\bINSERT\s+INTO\b/iu);
  assert.doesNotMatch(executableSql, /\bUPDATE\s+"(?:Lead|WebsiteLeadReceipt|ApplicationFeatureGate|Ai)/iu);
  assert.doesNotMatch(executableSql, /\bbackfill\b|\bseed\b|CREATE\s+(?:EXTENSION|EVENT|SCHEDULE)/iu);
  assert.doesNotMatch(executableSql, /ALTER TABLE "(?!Business(?:InboxEvent|OutboxEvent|QueueAttempt))/u);
});

test('N11 admission returns NEW, stable REPLAY and fail-closed conflicts', {
  skip: !runDbTests,
}, async () => {
  const candidate = syntheticEvent(1);
  const first = await admitBusinessInboxEvent(db, candidate);
  const replay = await admitBusinessInboxEvent(db, candidate);
  assert.equal(first.outcome, 'NEW');
  assert.deepEqual(replay, { outcome: 'REPLAY', inboxEventId: first.inboxEventId });

  await expectBackboneRejection('BUSINESS_INBOX_IDEMPOTENCY_CONFLICT', () => (
    admitBusinessInboxEvent(db, syntheticEvent(1, {
      eventId: candidate.eventId,
      businessCorrelationId: candidate.businessCorrelationId,
      submissionId: candidate.source.submissionId,
      message: 'Synthetic divergent payload.',
    }))
  ));
  await expectBackboneRejection('BUSINESS_INBOX_IDEMPOTENCY_CONFLICT', () => (
    admitBusinessInboxEvent(db, syntheticEvent(2, {
      eventId: candidate.eventId,
      submissionId: 'N11-DB-DIFFERENT-KEY',
    }))
  ));
  const independent = await admitBusinessInboxEvent(db, syntheticEvent(3, {
    email: candidate.payload.email,
    message: candidate.payload.message,
  }));
  assert.equal(independent.outcome, 'NEW');
  assert.deepEqual(await counts(), { inbox: 2, outbox: 0, attempts: 0 });
});

test('N11 admission race admits exactly one row and never overwrites divergent payloads', {
  skip: !runDbTests,
  timeout: 30_000,
}, async () => {
  const candidate = syntheticEvent(10);
  const same = await Promise.all(
    Array.from({ length: 32 }, () => admitBusinessInboxEvent(db, candidate)),
  );
  assert.equal(same.filter(({ outcome }) => outcome === 'NEW').length, 1);
  assert.equal(same.filter(({ outcome }) => outcome === 'REPLAY').length, 31);
  assert.equal(new Set(same.map(({ inboxEventId }) => inboxEventId)).size, 1);
  await cleanN11Tables();

  const variants = [
    syntheticEvent(11, {
      eventId: uuid(10_022),
      businessCorrelationId: uuid(10_023),
      submissionId: 'N11-DB-RACE-CONFLICT',
      message: 'Synthetic race variant A.',
    }),
    syntheticEvent(11, {
      eventId: uuid(10_022),
      businessCorrelationId: uuid(10_023),
      submissionId: 'N11-DB-RACE-CONFLICT',
      message: 'Synthetic race variant B.',
    }),
  ];
  const raced = await Promise.allSettled(
    Array.from({ length: 32 }, (_, index) => (
      admitBusinessInboxEvent(db, variants[index % 2])
    )),
  );
  assert.equal(raced.filter(({ status }) => status === 'rejected').length, 16);
  assert.equal(raced.filter(({ status }) => status === 'fulfilled').length, 16);
  assert.equal((await counts()).inbox, 1);
});

test('N11 outbox enqueue is derived, transaction-atomic, deduplicated and multi-destination', {
  skip: !runDbTests,
}, async () => {
  const inbox = await createInbox(20);
  await assert.rejects(
    db.$transaction(async (tx) => {
      await enqueueBusinessOutboxEvent(tx, {
        sourceInboxEventId: inbox.inboxEventId,
        producerCode: 'N11_SYNTHETIC_PRODUCER',
        destinationCode: 'N11_ROLLBACK_DESTINATION',
      });
      throw new Error('SYNTHETIC_ROLLBACK');
    }),
    /SYNTHETIC_ROLLBACK/,
  );
  assert.equal((await counts()).outbox, 0);

  const first = await db.$transaction((tx) => enqueueBusinessOutboxEvent(tx, {
    sourceInboxEventId: inbox.inboxEventId,
    producerCode: 'N11_SYNTHETIC_PRODUCER',
    destinationCode: 'N11_DESTINATION_A',
  }));
  const replay = await db.$transaction((tx) => enqueueBusinessOutboxEvent(tx, {
    sourceInboxEventId: inbox.inboxEventId,
    producerCode: 'N11_SYNTHETIC_PRODUCER',
    destinationCode: 'N11_DESTINATION_A',
  }));
  const secondDestination = await db.$transaction((tx) => enqueueBusinessOutboxEvent(tx, {
    sourceInboxEventId: inbox.inboxEventId,
    producerCode: 'N11_SYNTHETIC_PRODUCER',
    destinationCode: 'N11_DESTINATION_B',
  }));
  assert.deepEqual(replay, { outcome: 'REPLAY', outboxEventId: first.outboxEventId });
  assert.equal(secondDestination.outcome, 'NEW');
  assert.deepEqual(await counts(), { inbox: 1, outbox: 2, attempts: 0 });
  const rows = await db.businessOutboxEvent.findMany({ orderBy: { destinationCode: 'asc' } });
  assert.equal(rows[0].envelopeJson, rows[1].envelopeJson);
  assert.equal(rows[0].sourceInboxEventId, inbox.inboxEventId);
  assert.equal(rows[1].sourceInboxEventId, inbox.inboxEventId);
});

test('N11 claim race issues one fenced lease and persists only the token hash', {
  skip: !runDbTests,
  timeout: 30_000,
}, async () => {
  await createInbox(30);
  const leases = await Promise.all(Array.from({ length: 32 }, (_, index) => (
    claimBusinessQueueEvent(db, { queueKind: 'INBOX', leaseOwnerId: uuid(20_000 + index) })
  )));
  const claimed = leases.filter((lease): lease is BusinessQueueLease => lease !== null);
  assert.equal(claimed.length, 1);
  const lease = claimed[0];
  assert.equal(lease.attemptSequence, 1);
  assert.equal(lease.fencingToken, 1n);
  assert.equal(lease.leaseExpiresAt.getTime() - lease.leaseMaxExpiresAt.getTime(), -240_000);
  const [row, attempt] = await Promise.all([
    db.businessInboxEvent.findUniqueOrThrow({ where: { id: lease.eventRowId } }),
    db.businessQueueAttempt.findUniqueOrThrow({ where: { id: lease.attemptId } }),
  ]);
  assert.notEqual(row.leaseTokenHash, lease.leaseToken);
  assert.notEqual(attempt.leaseTokenHash, lease.leaseToken);
  assert.equal(JSON.stringify({ row, attempt }, (_, value) => (
    typeof value === 'bigint' ? value.toString() : value
  )).includes(lease.leaseToken), false);
});

test('N11 heartbeat is bounded and stale token, fence and owner never mutate a lease', {
  skip: !runDbTests,
}, async () => {
  await createInbox(40);
  const lease = await claimBusinessQueueEvent(db, {
    queueKind: 'INBOX',
    leaseOwnerId: uuid(30_000),
  });
  assert.ok(lease);
  let expiry = lease.leaseExpiresAt;
  for (let extension = 0; extension < 4; extension++) {
    const heartbeat = await heartbeatBusinessQueueLease(db, lease);
    assert.ok(heartbeat.leaseExpiresAt.getTime() > expiry.getTime());
    expiry = heartbeat.leaseExpiresAt;
  }
  assert.equal(expiry.getTime(), lease.leaseMaxExpiresAt.getTime());
  await expectBackboneRejection('BUSINESS_QUEUE_STATE_CONFLICT', () => (
    heartbeatBusinessQueueLease(db, lease)
  ));
  for (const stale of [
    { ...lease, leaseToken: '00'.repeat(32) },
    { ...lease, fencingToken: lease.fencingToken + 1n },
    { ...lease, leaseOwnerId: uuid(30_001) },
  ]) {
    await expectBackboneRejection('BUSINESS_QUEUE_LEASE_STALE', () => (
      heartbeatBusinessQueueLease(db, stale)
    ));
  }
  const row = await db.businessInboxEvent.findUniqueOrThrow({ where: { id: lease.eventRowId } });
  assert.equal(row.leaseExpiresAt?.getTime(), expiry.getTime());
});

test('N11 completion closes inbox/outbox attempts once and rejects stale reuse', {
  skip: !runDbTests,
}, async () => {
  await createInbox(50);
  const inboxLease = await claimBusinessQueueEvent(db, {
    queueKind: 'INBOX',
    leaseOwnerId: uuid(40_000),
  });
  assert.ok(inboxLease);
  const inboxCompletion = await completeBusinessQueueEvent(db, inboxLease);
  assert.equal(inboxCompletion.state, 'PROCESSED');
  assert.match(inboxCompletion.completionHash, /^[0-9a-f]{64}$/);
  await expectBackboneRejection('BUSINESS_QUEUE_LEASE_STALE', () => (
    completeBusinessQueueEvent(db, inboxLease)
  ));

  await cleanN11Tables();
  await createOutbox(51);
  const outboxLease = await claimBusinessQueueEvent(db, {
    queueKind: 'OUTBOX',
    leaseOwnerId: uuid(40_001),
  });
  assert.ok(outboxLease);
  assert.equal((await completeBusinessQueueEvent(db, outboxLease)).state, 'PUBLISHED');
});

test('N11 retry backoff, attempt budget and permanent failure end in bounded dead-letter', {
  skip: !runDbTests,
  timeout: 30_000,
}, async () => {
  const admitted = await createInbox(60);
  for (let sequence = 1; sequence <= 5; sequence++) {
    const lease = await claimBusinessQueueEvent(db, {
      queueKind: 'INBOX',
      leaseOwnerId: uuid(50_000 + sequence),
    });
    assert.ok(lease);
    assert.equal(lease.attemptSequence, sequence);
    const failed = await failBusinessQueueEvent(db, {
      ...lease,
      failureCode: 'SYNTHETIC_RETRYABLE',
      retryable: true,
    });
    if (sequence < 5) {
      assert.equal(failed.state, 'AVAILABLE');
      assert.ok(failed.nextAvailableAt);
      await forceAvailableNow('INBOX', admitted.inboxEventId);
    } else {
      assert.equal(failed.state, 'DEAD_LETTER');
      assert.equal(failed.nextAvailableAt, null);
    }
  }
  const row = await db.businessInboxEvent.findUniqueOrThrow({ where: { id: admitted.inboxEventId } });
  assert.equal(row.attemptCount, 5);
  assert.equal(row.fencingToken, 5n);
  assert.equal(row.state, 'DEAD_LETTER');
  assert.equal(row.lastFailureCode, 'SYNTHETIC_RETRYABLE');
  assert.equal(await db.businessQueueAttempt.count(), 5);

  await cleanN11Tables();
  await createInbox(61);
  const permanentLease = await claimBusinessQueueEvent(db, {
    queueKind: 'INBOX',
    leaseOwnerId: uuid(50_100),
  });
  assert.ok(permanentLease);
  const permanent = await failBusinessQueueEvent(db, {
    ...permanentLease,
    failureCode: 'SYNTHETIC_PERMANENT',
    retryable: false,
  });
  assert.equal(permanent.state, 'DEAD_LETTER');
});

test('N11 recovery uses DB expiry, closes attempt and is bounded to 100 rows', {
  skip: !runDbTests,
  timeout: 120_000,
}, async () => {
  const eventIds: string[] = [];
  for (let index = 0; index < 101; index++) {
    const admitted = await createInbox(100 + index);
    eventIds.push(admitted.inboxEventId);
    const lease = await claimBusinessQueueEvent(db, {
      queueKind: 'INBOX',
      leaseOwnerId: uuid(60_000 + index),
    });
    assert.ok(lease);
    await forceExpiredLease('INBOX', lease.eventRowId);
  }
  const first = await recoverExpiredBusinessQueueLeases(db, {
    queueKind: 'INBOX',
    maximumRows: 100,
  });
  assert.deepEqual(first, { recovered: 100, retried: 100, deadLettered: 0 });
  const leasedAfterFirst = await db.businessInboxEvent.count({ where: { state: 'LEASED' } });
  assert.equal(leasedAfterFirst, 1);
  const second = await recoverExpiredBusinessQueueLeases(db, { queueKind: 'INBOX' });
  assert.deepEqual(second, { recovered: 1, retried: 1, deadLettered: 0 });
  assert.equal(await db.businessQueueAttempt.count({ where: { outcome: 'LEASE_EXPIRED' } }), 101);
  assert.equal(eventIds.length, 101);
});

test('N11 recovery rejects multiple open attempts before mutating the queue', {
  skip: !runDbTests,
}, async () => {
  const admitted = await createInbox(250);
  const lease = await claimBusinessQueueEvent(db, {
    queueKind: 'INBOX',
    leaseOwnerId: uuid(65_000),
  });
  assert.ok(lease);
  await forceExpiredLease('INBOX', lease.eventRowId);
  const attempt = await db.businessQueueAttempt.findUniqueOrThrow({
    where: { id: lease.attemptId },
  });
  const extraAttemptId = uuid(65_001);
  const extraAttemptSequence = attempt.attemptSequence + 1;
  const extraFencingToken = attempt.fencingToken + 1n;
  const extraAttemptHash = calculateBusinessQueueAttemptHash({
    attemptId: extraAttemptId,
    queueKind: 'INBOX',
    eventRowId: admitted.inboxEventId,
    attemptSequence: extraAttemptSequence,
    fencingToken: extraFencingToken,
    leaseOwnerId: attempt.leaseOwnerId,
    leaseTokenHash: attempt.leaseTokenHash,
    claimedAt: attempt.claimedAt,
    leaseExpiresAt: attempt.leaseExpiresAt,
    leaseMaxExpiresAt: attempt.leaseMaxExpiresAt,
  });
  await db.businessQueueAttempt.create({
    data: {
      id: extraAttemptId,
      queueKind: 'INBOX',
      inboxEventId: admitted.inboxEventId,
      attemptSequence: extraAttemptSequence,
      fencingToken: extraFencingToken,
      leaseOwnerId: attempt.leaseOwnerId,
      leaseTokenHash: attempt.leaseTokenHash,
      claimedAt: attempt.claimedAt,
      leaseExpiresAt: attempt.leaseExpiresAt,
      leaseMaxExpiresAt: attempt.leaseMaxExpiresAt,
      attemptHash: extraAttemptHash,
      createdAt: attempt.claimedAt,
    },
  });

  await expectBackboneRejection('BUSINESS_QUEUE_INTEGRITY_FAILURE', () => (
    recoverExpiredBusinessQueueLeases(db, { queueKind: 'INBOX' })
  ));
  assert.equal((await db.businessInboxEvent.findUniqueOrThrow({
    where: { id: admitted.inboxEventId },
  })).state, 'LEASED');
  assert.equal(await db.businessQueueAttempt.count({
    where: { inboxEventId: admitted.inboxEventId, finishedAt: null },
  }), 2);
});

test('N11 recovery verifies the open attempt hash before mutating the queue', {
  skip: !runDbTests,
}, async () => {
  const admitted = await createInbox(251);
  const lease = await claimBusinessQueueEvent(db, {
    queueKind: 'INBOX',
    leaseOwnerId: uuid(65_100),
  });
  assert.ok(lease);
  await forceExpiredLease('INBOX', lease.eventRowId);
  await db.$executeRawUnsafe(
    'ALTER TABLE "BusinessQueueAttempt" DISABLE TRIGGER "BusinessQueueAttempt_guard_v1"',
  );
  try {
    await db.businessQueueAttempt.update({
      where: { id: lease.attemptId },
      data: { attemptHash: '0'.repeat(64) },
    });
  } finally {
    await db.$executeRawUnsafe(
      'ALTER TABLE "BusinessQueueAttempt" ENABLE TRIGGER "BusinessQueueAttempt_guard_v1"',
    );
  }

  await expectBackboneRejection('BUSINESS_QUEUE_INTEGRITY_FAILURE', () => (
    recoverExpiredBusinessQueueLeases(db, { queueKind: 'INBOX' })
  ));
  assert.equal((await db.businessInboxEvent.findUniqueOrThrow({
    where: { id: admitted.inboxEventId },
  })).state, 'LEASED');
  assert.equal((await db.businessQueueAttempt.findUniqueOrThrow({
    where: { id: lease.attemptId },
  })).finishedAt, null);
});

test('N11 DB guards reject immutable mutation, illegal transition, delete, truncate and attempt reopen', {
  skip: !runDbTests,
}, async () => {
  const admitted = await createInbox(300);
  await assert.rejects(
    db.$executeRaw(Prisma.sql`
      UPDATE "BusinessInboxEvent" SET "payloadHash" = ${'0'.repeat(64)}
      WHERE "id" = ${admitted.inboxEventId}::UUID
    `),
  );
  await assert.rejects(
    db.$executeRaw(Prisma.sql`
      UPDATE "BusinessInboxEvent" SET "state" = 'PROCESSED', "terminalAt" = clock_timestamp()
      WHERE "id" = ${admitted.inboxEventId}::UUID
    `),
  );
  await assert.rejects(db.$executeRaw(Prisma.sql`
    DELETE FROM "BusinessInboxEvent" WHERE "id" = ${admitted.inboxEventId}::UUID
  `));
  await assert.rejects(db.$executeRawUnsafe('TRUNCATE TABLE "BusinessInboxEvent"'));

  const lease = await claimBusinessQueueEvent(db, {
    queueKind: 'INBOX',
    leaseOwnerId: uuid(70_000),
  });
  assert.ok(lease);
  await completeBusinessQueueEvent(db, lease);
  await assert.rejects(db.$executeRaw(Prisma.sql`
    UPDATE "BusinessQueueAttempt" SET "finishedAt" = NULL, "outcome" = NULL,
      "completionHash" = NULL WHERE "id" = ${lease.attemptId}::UUID
  `));
});

test('N11 foreign keys and relations remain internal to the three N11 tables', {
  skip: !runDbTests,
}, async () => {
  const relations = await db.$queryRaw<Array<{
    sourceTable: string;
    targetTable: string;
    deleteAction: string;
  }>>(Prisma.sql`
    SELECT source.relname AS "sourceTable", target.relname AS "targetTable",
      constraint_row.confdeltype::TEXT AS "deleteAction"
    FROM pg_constraint constraint_row
    JOIN pg_class source ON source.oid = constraint_row.conrelid
    JOIN pg_class target ON target.oid = constraint_row.confrelid
    WHERE constraint_row.contype = 'f'
      AND source.relnamespace = 'public'::regnamespace
      AND source.relname LIKE 'Business%'
    ORDER BY source.relname, target.relname
  `);
  assert.deepEqual(relations, [
    { sourceTable: 'BusinessOutboxEvent', targetTable: 'BusinessInboxEvent', deleteAction: 'r' },
    { sourceTable: 'BusinessQueueAttempt', targetTable: 'BusinessInboxEvent', deleteAction: 'r' },
    { sourceTable: 'BusinessQueueAttempt', targetTable: 'BusinessOutboxEvent', deleteAction: 'r' },
  ]);
  assert.equal(relations.some(({ targetTable }) => (
    targetTable === 'Lead'
    || targetTable === 'WebsiteLeadReceipt'
    || targetTable.startsWith('Ai')
  )), false);
});

async function runProcesses(scenario: string) {
  const fixture = resolve('tests/db/business-inbox-outbox-backbone-multiprocess-fixture.ts');
  const results = await Promise.all(Array.from({ length: 8 }, (_, worker) => execFileAsync(
    process.execPath,
    ['--import', 'tsx', fixture, scenario, String(worker)],
    { env: process.env, timeout: 20_000, maxBuffer: 1024 * 1024 },
  )));
  const aggregate: Record<string, number> = {};
  for (const { stdout } of results) {
    for (const [key, value] of Object.entries(JSON.parse(stdout) as Record<string, number>)) {
      aggregate[key] = (aggregate[key] ?? 0) + value;
    }
  }
  return aggregate;
}

test('N11 multiprocess races qualify admission and inbox/outbox claims across eight processes', {
  skip: !runDbTests,
  timeout: 120_000,
}, async () => {
  assert.deepEqual(await runProcesses('admit-same'), { NEW: 1, REPLAY: 7 });
  await cleanN11Tables();
  assert.deepEqual(await runProcesses('admit-conflict'), { NEW: 1, REPLAY: 3, CONFLICT: 4 });

  await cleanN11Tables();
  await createInbox(400);
  assert.deepEqual(await runProcesses('claim-inbox'), { LEASED: 1, EMPTY: 7 });

  await cleanN11Tables();
  await createOutbox(401);
  assert.deepEqual(await runProcesses('claim-outbox'), { LEASED: 1, EMPTY: 7 });
});

async function qualifyMigrationChain(upgrade: boolean) {
  await assertBound();
  const sourceUrl = process.env.DATABASE_URL;
  assert.ok(sourceUrl);
  const schema = `n11_${upgrade ? 'upgrade' : 'fresh'}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const root = mkdtempSync(join(tmpdir(), 'fai-n11-migrations-'));
  const prismaDir = join(root, 'prisma');
  const migrationsDir = join(prismaDir, 'migrations');
  mkdirSync(migrationsDir, { recursive: true });
  cpSync('prisma/schema.prisma', join(prismaDir, 'schema.prisma'));
  const allNames = readdirSync('prisma/migrations').filter((name) => /^\d/u.test(name)).sort();
  assert.equal(allNames.length, 40);
  const names = allNames.slice(0, 38);
  const url = new URL(sourceUrl);
  url.searchParams.set('schema', schema);
  await db.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  const deploy = () => execFileSync(
    resolve('node_modules/.bin/prisma'),
    ['migrate', 'deploy', '--schema', join(prismaDir, 'schema.prisma')],
    { env: { ...process.env, DATABASE_URL: url.toString() }, stdio: 'pipe', timeout: 120_000 },
  );
  try {
    for (const name of upgrade ? names.slice(0, 37) : names) {
      cpSync(join('prisma/migrations', name), join(migrationsDir, name), { recursive: true });
    }
    deploy();
    if (upgrade) {
      const last = names[37];
      cpSync(join('prisma/migrations', last), join(migrationsDir, last), { recursive: true });
      deploy();
    }
    const client = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    try {
      const [applied, tables, rows] = await Promise.all([
        client.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
          SELECT COUNT(*)::BIGINT AS "count" FROM "_prisma_migrations"
          WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
        `),
        client.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
          SELECT COUNT(*)::BIGINT AS "count" FROM information_schema.tables
          WHERE table_schema = ${schema}
            AND table_name IN ('BusinessInboxEvent', 'BusinessOutboxEvent', 'BusinessQueueAttempt')
        `),
        client.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
          SELECT (
            (SELECT COUNT(*) FROM "BusinessInboxEvent")
            + (SELECT COUNT(*) FROM "BusinessOutboxEvent")
            + (SELECT COUNT(*) FROM "BusinessQueueAttempt")
          )::BIGINT AS "count"
        `),
      ]);
      return {
        applied: Number(applied[0]?.count),
        tables: Number(tables[0]?.count),
        rows: Number(rows[0]?.count),
      };
    } finally {
      await client.$disconnect();
    }
  } finally {
    await db.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    rmSync(root, { recursive: true, force: true });
  }
}

test('N11 migration chain qualifies fresh 38 and additive 37 to 38 upgrade', {
  skip: !runDbTests,
  timeout: 300_000,
}, async () => {
  const expected = { applied: 38, tables: 3, rows: 0 };
  assert.deepEqual(await qualifyMigrationChain(false), expected);
  assert.deepEqual(await qualifyMigrationChain(true), expected);
});
