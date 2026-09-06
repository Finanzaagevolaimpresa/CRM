import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrismaClient } from '@prisma/client';
import {
  BusinessEventBackboneError,
  claimBusinessQueueEvent,
  freezeBusinessInboxEventIds,
  recoverExpiredBusinessQueueLeases,
  type BusinessQueueLease,
} from '../src/lib/business-event-backbone';
import {
  LeadIntakeConsumerConfigurationError,
  readLeadIntakeConsumerConfig,
  runLeadIntakeConsumer,
  type LeadIntakeConsumerLogRecord,
  type LeadIntakeConsumerOperations,
} from '../src/lib/lead-intake-consumer';

const id = 'abcdef00-0000-4000-8000-000000000001';
const secondId = 'abcdef00-0000-4000-8000-000000000002';
const ids100 = Array.from({ length: 100 }, (_, i) =>
  `abcdef00-0000-4000-8000-${String(i).padStart(12, '0')}`);
const environment = (overrides: Record<string, string | undefined> = {}) => ({
  VNX01_LEAD_INTAKE_CONSUMER_ENABLED: '1',
  VNX01_LEAD_INTAKE_LEASE_OWNER_ID: id,
  VNX01_LEAD_INTAKE_BATCH_SIZE: '3',
  VNX01_LEAD_INTAKE_RECOVERY_BATCH_SIZE: '2',
  VNX05_LEAD_INTAKE_PILOT_ENABLED: '1',
  VNX05_LEAD_INTAKE_INBOX_EVENT_IDS: JSON.stringify([id]),
  WEBSITE_LEAD_MODE: 'disabled',
  LEAD_IDENTITY_KEY_FILE: '/run/secrets/synthetic.json',
  ...overrides,
});

function operations(overrides: Partial<LeadIntakeConsumerOperations> = {}): LeadIntakeConsumerOperations {
  return {
    async assertReady() {},
    async recover() { return { recovered: 0, retried: 0, deadLettered: 0 }; },
    async claim() { return null; },
    async project() { return { result: { state: 'PROJECTED_NEW' } } as never; },
    ...overrides,
  };
}

test('VNX-05 accepts exactly 1..100 distinct canonical N11 UUID v4 row IDs and freezes a copy', () => {
  for (const ids of [[id], ids100]) {
    const copy = freezeBusinessInboxEventIds(ids);
    assert.deepEqual(copy, ids);
    assert.notEqual(copy, ids);
    assert.equal(Object.isFrozen(copy), true);
  }
  const mutable = [id];
  const frozen = freezeBusinessInboxEventIds(mutable);
  mutable[0] = secondId;
  assert.deepEqual(frozen, [id]);
});

test('VNX-05 invalid, ambiguous and oversized selections fail before even opening a transaction', async () => {
  const invalid: unknown[] = [
    null, '', {}, [], [id, id], [id.toUpperCase()], [id + '\n'], [' ' + id],
    [id.replace('-4000-', '-7000-')], [42], [[id]], [null], [undefined],
    [...ids100, secondId], new Array(1), ["' OR TRUE --"],
  ];
  const prisma = { $transaction() { assert.fail('invalid selection opened a transaction'); } } as unknown as PrismaClient;
  for (const value of invalid) {
    assert.throws(() => freezeBusinessInboxEventIds(value), BusinessEventBackboneError);
    const inboxEventIds = value as readonly string[];
    await assert.rejects(claimBusinessQueueEvent(prisma, {
      queueKind: 'INBOX', leaseOwnerId: id, inboxEventIds,
    }), BusinessEventBackboneError);
    await assert.rejects(recoverExpiredBusinessQueueLeases(prisma, {
      queueKind: 'INBOX', inboxEventIds,
    }), BusinessEventBackboneError);
  }
  for (const queueKind of ['OUTBOX'] as const) {
    await assert.rejects(claimBusinessQueueEvent(prisma, {
      queueKind, leaseOwnerId: id, inboxEventIds: [id],
    }), BusinessEventBackboneError);
    await assert.rejects(recoverExpiredBusinessQueueLeases(prisma, {
      queueKind, inboxEventIds: [id],
    }), BusinessEventBackboneError);
  }
});

test('VNX-05 configuration rejects missing selection, invalid gates and selector-without-pilot', async () => {
  const invalid = [
    ...[undefined, '', '[]', 'null', '{}', id, '[', JSON.stringify([id, id]),
      JSON.stringify([id.toUpperCase()]), JSON.stringify([...ids100, secondId]), ' '.repeat(8193),
    ].map((value) => environment({ VNX05_LEAD_INTAKE_INBOX_EVENT_IDS: value })),
    ...[undefined, '', '0', 'true', '01', ' 1', '2'].map((value) =>
      environment({ VNX05_LEAD_INTAKE_PILOT_ENABLED: value })),
  ];
  for (const env of invalid) {
    await assert.rejects(runLeadIntakeConsumer(operations({
      async assertReady() { assert.fail('invalid configuration reached readiness'); },
    }), { environment: env, logger() {} }), LeadIntakeConsumerConfigurationError);
  }
  const ordinary = readLeadIntakeConsumerConfig(environment({
    VNX05_LEAD_INTAKE_PILOT_ENABLED: '0', VNX05_LEAD_INTAKE_INBOX_EVENT_IDS: '',
  }));
  assert.ok(ordinary.enabled);
  assert.equal(ordinary.inboxEventIds, undefined);
  const disabled = await runLeadIntakeConsumer(operations({
    async assertReady() { assert.fail('closed consumer gate reached readiness'); },
  }), { environment: environment({ VNX01_LEAD_INTAKE_CONSUMER_ENABLED: '0' }), logger() {} });
  assert.equal(disabled.status, 'DISABLED');
});

test('VNX-05 freezes configuration before readiness and passes the identical selection to recovery and every claim', async () => {
  const env = environment();
  let selection: readonly string[] | undefined;
  let claims = 0;
  await runLeadIntakeConsumer(operations({
    async assertReady(config) {
      selection = config.inboxEventIds;
      assert.deepEqual(selection, [id]);
      assert.ok(Object.isFrozen(config) && Object.isFrozen(selection));
      env.VNX05_LEAD_INTAKE_PILOT_ENABLED = '0';
      env.VNX05_LEAD_INTAKE_INBOX_EVENT_IDS = JSON.stringify([secondId]);
    },
    async recover(maximumRows, ids) {
      assert.equal(maximumRows, 2);
      assert.equal(ids, selection);
      return { recovered: 0, retried: 0, deadLettered: 0 };
    },
    async claim(_owner, ids) {
      assert.equal(ids, selection);
      claims += 1;
      return { eventRowId: id } as BusinessQueueLease;
    },
  }), { environment: env, logger() {} });
  assert.equal(claims, 3);
});

test('VNX-05 reports previously committed outcomes if a later claim fails without logging selectors', async () => {
  let claims = 0;
  const logs: LeadIntakeConsumerLogRecord[] = [];
  await assert.rejects(runLeadIntakeConsumer(operations({
    async claim() {
      if (++claims === 2) throw new Error('synthetic sensitive detail');
      return { eventRowId: id } as BusinessQueueLease;
    },
  }), { environment: environment(), logger(record) { logs.push(record); } }));
  assert.deepEqual(logs.at(-1), {
    event: 'VNX01_CONSUMER_COMPLETED', status: 'FAILED',
    recovered: 0, retried: 0, deadLettered: 0,
    claimed: 1, projectedNew: 1, reviewRequired: 0, failed: 0,
  });
  assert.doesNotMatch(JSON.stringify(logs), /abcdef|sensitive|inboxEventIds|synthetic\.json/);
});
