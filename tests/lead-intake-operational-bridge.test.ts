import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { BusinessQueueLease } from '../src/lib/business-event-backbone';
import {
  LEAD_INTAKE_CONSUMER_MANIFEST,
  LeadIntakeConsumerConfigurationError,
  readLeadIntakeConsumerConfig,
  runLeadIntakeConsumer,
  safeLeadIntakeConsumerFailureCode,
  type LeadIntakeConsumerLogRecord,
  type LeadIntakeConsumerOperations,
} from '../src/lib/lead-intake-consumer';
import { visibleNavItemsForTest } from '../src/components/nav-links';
import { syntheticN13LeadEvent } from './fixtures/n13-lead-projection-v1';

const ownerId = '00000000-0000-4000-8000-000000090001';

function enabledEnvironment(overrides: Record<string, string | undefined> = {}) {
  return {
    VNX01_LEAD_INTAKE_CONSUMER_ENABLED: '1',
    VNX01_LEAD_INTAKE_LEASE_OWNER_ID: ownerId,
    VNX01_LEAD_INTAKE_BATCH_SIZE: '3',
    VNX01_LEAD_INTAKE_RECOVERY_BATCH_SIZE: '2',
    LEAD_IDENTITY_KEY_FILE: '/run/secrets/vnx01-synthetic-key.json',
    WEBSITE_LEAD_MODE: 'disabled',
    ...overrides,
  };
}

function lease(ordinal: number): BusinessQueueLease {
  return Object.freeze({
    queueKind: 'INBOX',
    eventRowId: `00000000-0000-4000-8000-${(91_000 + ordinal).toString().padStart(12, '0')}`,
    attemptId: `00000000-0000-4000-8000-${(92_000 + ordinal).toString().padStart(12, '0')}`,
    attemptSequence: 1,
    fencingToken: 1n,
    leaseOwnerId: ownerId,
    leaseToken: '1'.repeat(64),
    leaseExpiresAt: new Date('2099-01-01T00:01:00.000Z'),
    leaseMaxExpiresAt: new Date('2099-01-01T00:05:00.000Z'),
    envelope: syntheticN13LeadEvent(),
  });
}

function fakeProjection(state: 'PROJECTED_NEW' | 'REVIEW_REQUIRED') {
  return {
    state: 'PROCESSED',
    completionHash: '2'.repeat(64),
    result: { state },
  } as never;
}

function operations(overrides: Partial<LeadIntakeConsumerOperations> = {}) {
  const base: LeadIntakeConsumerOperations = {
    async assertReady() {},
    async recover() { return { recovered: 0, retried: 0, deadLettered: 0 }; },
    async claim() { return null; },
    async project() { return fakeProjection('PROJECTED_NEW'); },
  };
  return { ...base, ...overrides } satisfies LeadIntakeConsumerOperations;
}

test('VNX-01 manifest is default-off, finite, bounded and does not activate N14', () => {
  assert.equal(LEAD_INTAKE_CONSUMER_MANIFEST.dormantByDefault, true);
  assert.equal(LEAD_INTAKE_CONSUMER_MANIFEST.enabledValue, '1');
  assert.equal(LEAD_INTAKE_CONSUMER_MANIFEST.runMode, 'BOUNDED_ONE_SHOT');
  assert.equal(LEAD_INTAKE_CONSUMER_MANIFEST.maximumBatchSize, 100);
  assert.equal(LEAD_INTAKE_CONSUMER_MANIFEST.maximumRecoveryBatchSize, 100);
  assert.equal(LEAD_INTAKE_CONSUMER_MANIFEST.n14Activation, 'UNCHANGED');
});

test('disabled gate performs no readiness, recovery, claim or projection work', async () => {
  const calls: string[] = [];
  const logs: LeadIntakeConsumerLogRecord[] = [];
  const summary = await runLeadIntakeConsumer(operations({
    async assertReady() { calls.push('ready'); },
    async recover() { calls.push('recover'); return { recovered: 0, retried: 0, deadLettered: 0 }; },
    async claim() { calls.push('claim'); return null; },
    async project() { calls.push('project'); return fakeProjection('PROJECTED_NEW'); },
  }), { environment: {}, logger: (record) => logs.push(record) });
  assert.deepEqual(summary, {
    status: 'DISABLED', recovered: 0, retried: 0, deadLettered: 0,
    claimed: 0, projectedNew: 0, reviewRequired: 0, failed: 0,
  });
  assert.deepEqual(calls, []);
  assert.deepEqual(logs, [{ event: 'VNX01_CONSUMER_DISABLED', status: 'DISABLED' }]);
});

test('invalid or incomplete activation configuration fails before any queue operation', async () => {
  const invalidEnvironments = [
    enabledEnvironment({ VNX01_LEAD_INTAKE_CONSUMER_ENABLED: 'true' }),
    enabledEnvironment({ VNX01_LEAD_INTAKE_LEASE_OWNER_ID: '' }),
    enabledEnvironment({ VNX01_LEAD_INTAKE_BATCH_SIZE: '0' }),
    enabledEnvironment({ VNX01_LEAD_INTAKE_BATCH_SIZE: '101' }),
    enabledEnvironment({ VNX01_LEAD_INTAKE_RECOVERY_BATCH_SIZE: ' 2' }),
    enabledEnvironment({ LEAD_IDENTITY_KEY_FILE: '' }),
    enabledEnvironment({ WEBSITE_LEAD_MODE: 'legacy' }),
    enabledEnvironment({ WEBSITE_LEAD_MODE: undefined }),
  ];
  let queueCalls = 0;
  const guardedOperations = operations({
    async assertReady() { queueCalls += 1; },
    async recover() { queueCalls += 1; return { recovered: 0, retried: 0, deadLettered: 0 }; },
    async claim() { queueCalls += 1; return null; },
  });
  for (const environment of invalidEnvironments) {
    await assert.rejects(
      runLeadIntakeConsumer(guardedOperations, { environment, logger: () => {} }),
      (error: unknown) => error instanceof LeadIntakeConsumerConfigurationError,
    );
  }
  assert.equal(queueCalls, 0);
});

test('key and database readiness failure blocks recovery and claim', async () => {
  let recoverCalls = 0;
  let claimCalls = 0;
  await assert.rejects(runLeadIntakeConsumer(operations({
    async assertReady() { throw new Error('synthetic key path and secret must never be logged'); },
    async recover() { recoverCalls += 1; return { recovered: 0, retried: 0, deadLettered: 0 }; },
    async claim() { claimCalls += 1; return null; },
  }), { environment: enabledEnvironment(), logger: () => {} }));
  assert.equal(recoverCalls, 0);
  assert.equal(claimCalls, 0);
});

test('one bounded run recovers leases and classifies new, duplicate and failed projections', async () => {
  const leases = [lease(1), lease(2), lease(3)];
  const logs: LeadIntakeConsumerLogRecord[] = [];
  let claimedIndex = 0;
  const summary = await runLeadIntakeConsumer(operations({
    async recover(maximumRows) {
      assert.equal(maximumRows, 2);
      return { recovered: 2, retried: 1, deadLettered: 1 };
    },
    async claim(receivedOwnerId) {
      assert.equal(receivedOwnerId, ownerId);
      return leases[claimedIndex++] ?? null;
    },
    async project(receivedLease) {
      if (receivedLease === leases[0]) return fakeProjection('PROJECTED_NEW');
      if (receivedLease === leases[1]) return fakeProjection('REVIEW_REQUIRED');
      throw new Error('private@example.invalid secret-value payload');
    },
  }), { environment: enabledEnvironment(), logger: (record) => logs.push(record) });
  assert.deepEqual(summary, {
    status: 'COMPLETED', recovered: 2, retried: 1, deadLettered: 1,
    claimed: 3, projectedNew: 1, reviewRequired: 1, failed: 1,
  });
  const serializedLogs = JSON.stringify(logs);
  assert.match(serializedLogs, /VNX01_INTERNAL_FAILURE/u);
  assert.doesNotMatch(serializedLogs, /private@example\.invalid|secret-value|payload/u);
});

test('concurrent runs rely on a single winning claim and produce one effect', async () => {
  let available = true;
  let projected = 0;
  const shared = operations({
    async claim() {
      if (!available) return null;
      available = false;
      return lease(4);
    },
    async project() {
      projected += 1;
      return fakeProjection('PROJECTED_NEW');
    },
  });
  const environment = enabledEnvironment({ VNX01_LEAD_INTAKE_BATCH_SIZE: '1' });
  const summaries = await Promise.all([
    runLeadIntakeConsumer(shared, { environment, logger: () => {} }),
    runLeadIntakeConsumer(shared, { environment, logger: () => {} }),
  ]);
  assert.equal(summaries.reduce((total, summary) => total + summary.claimed, 0), 1);
  assert.equal(projected, 1);
});

test('SIGTERM-style abort finishes the current projection and then stops claiming', async () => {
  const controller = new AbortController();
  let claimCalls = 0;
  let projectionCompleted = false;
  const summary = await runLeadIntakeConsumer(operations({
    async claim() {
      claimCalls += 1;
      return lease(5);
    },
    async project() {
      controller.abort();
      projectionCompleted = true;
      return fakeProjection('PROJECTED_NEW');
    },
  }), {
    environment: enabledEnvironment(),
    signal: controller.signal,
    logger: () => {},
  });
  assert.equal(projectionCompleted, true);
  assert.equal(claimCalls, 1);
  assert.equal(summary.status, 'STOPPED');
  assert.equal(summary.claimed, 1);
  assert.equal(summary.projectedNew, 1);
});

test('failure redaction never serializes arbitrary exception messages', () => {
  const error = new Error('name phone@example.invalid super-secret-key');
  assert.equal(safeLeadIntakeConsumerFailureCode(error), 'VNX01_INTERNAL_FAILURE');
  assert.doesNotMatch(safeLeadIntakeConsumerFailureCode(error), /phone|secret|@/u);
});

test('runtime wiring uses N11/N13 primitives and has no automatic startup surface', () => {
  const runtime = readFileSync('src/lib/lead-intake-consumer.ts', 'utf8');
  const script = readFileSync('scripts/vnx01-lead-intake-consumer.ts', 'utf8');
  const packageJson = readFileSync('package.json', 'utf8');
  const compose = readFileSync('docker-compose.prod.example.yml', 'utf8');
  assert.match(runtime, /claimBusinessQueueEvent/u);
  assert.match(runtime, /recoverExpiredBusinessQueueLeases/u);
  assert.match(runtime, /projectClaimedLeadInboxEvent/u);
  assert.match(runtime, /readLeadIdentityKeyFile[\s\S]*assertLeadIdentityKeyConsensus[\s\S]*operations\.recover/u);
  assert.doesNotMatch(runtime, /envelopeJson|eventId|businessCorrelationId|leaseToken|payloadHash|keyDigest|error\.message/u);
  assert.match(script, /SIGINT[\s\S]*SIGTERM[\s\S]*runLeadIntakeConsumer/u);
  assert.match(packageJson, /"vnx01:lead-intake": "tsx scripts\/vnx01-lead-intake-consumer\.ts"/u);
  assert.doesNotMatch(compose, /vnx01-lead-intake-consumer|vnx01:lead-intake/u);
});

test('duplicate queue UI is permission-scoped, bounded and excludes free-text payload', () => {
  const page = readFileSync('src/app/leads/duplicates/page.tsx', 'utf8');
  const review = readFileSync('src/lib/lead-duplicate-review.ts', 'utf8');
  assert.match(page, /requirePermission\('lead\.duplicate\.resolve'\)/u);
  assert.match(page, /internalSessionMode\(\) === 'registry'/u);
  assert.match(page, /decisionsAvailable = readiness\.active && registrySession/u);
  assert.match(page, /expectedCaseVersion/u);
  assert.match(page, /LINK_EXISTING_NO_OVERWRITE/u);
  assert.match(page, /CREATE_NEW/u);
  assert.match(page, /resolveLeadDuplicateCaseAndRefresh/u);
  assert.doesNotMatch(page, /message|notes|reasonNote|payloadHash|keyDigest|envelopeJson/u);
  assert.match(review, /calculateBusinessInboxRecordHash/u);
  assert.match(review, /canonicalJson\(event\)/u);
  assert.match(review, /candidate\.snapshotHash !== canonicalSha256/u);
  assert.match(review, /discoveryRevision[\s\S]*candidateCount/u);
  assert.match(review, /take: input\.take/u);
  assert.match(review, /take: CORE_QUERY_MAX_CANDIDATES/u);
  assert.match(review, /leadDuplicateCandidate\.groupBy/u);
  assert.match(review, /candidatesTruncated/u);
  assert.ok(visibleNavItemsForTest({
    role: 'admin',
    effectivePermissions: ['lead.duplicate.resolve'],
  }).includes('/leads/duplicates'));
  assert.ok(!visibleNavItemsForTest({
    role: 'commerciale',
    effectivePermissions: ['lead.read', 'lead.write'],
  }).includes('/leads/duplicates'));
});

test('all environment examples keep VNX-01 and N14 disabled with no identity key', () => {
  for (const path of ['.env.example', '.env.production.example', '.env.staging.example']) {
    const environment = readFileSync(path, 'utf8');
    assert.match(environment, /VNX01_LEAD_INTAKE_CONSUMER_ENABLED="0"/u);
    assert.match(environment, /VNX01_LEAD_INTAKE_LEASE_OWNER_ID=""/u);
    assert.match(environment, /VNX01_LEAD_INTAKE_BATCH_SIZE=""/u);
    assert.match(environment, /VNX01_LEAD_INTAKE_RECOVERY_BATCH_SIZE=""/u);
    assert.match(environment, /LEAD_IDENTITY_KEY_FILE=""/u);
    assert.match(environment, /COMMERCIAL_LEAD_INBOX_MODE="disabled"/u);
  }
  const restoreDrill = readFileSync('scripts/n05/restore-drill.sh', 'utf8');
  assert.match(restoreDrill, /VNX01_LEAD_INTAKE_CONSUMER_ENABLED=0/u);
  assert.match(restoreDrill, /VNX01_LEAD_INTAKE_LEASE_OWNER_ID=/u);
  assert.match(restoreDrill, /VNX01_LEAD_INTAKE_BATCH_SIZE=/u);
  assert.match(restoreDrill, /VNX01_LEAD_INTAKE_RECOVERY_BATCH_SIZE=/u);
  assert.match(restoreDrill, /COMMERCIAL_LEAD_INBOX_MODE=disabled/u);
  const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
  assert.match(ci, /Verify VNX-01 has exactly 43 migrations and no schema delta/u);
  assert.match(ci, /github\.head_ref == 'codex\/vnx01-lead-intake-operational-bridge-r01'/u);
  assert.match(ci, /test "\$migration_count" = "43"/u);
  assert.equal(readLeadIntakeConsumerConfig({}).enabled, false);
});
