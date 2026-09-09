import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { PrismaClient } from '@prisma/client';
import { createDisabledCommunicationGateSnapshotV1 } from '../../src/lib/communication-backbone-contract';
import {
  CommunicationPersistenceError,
  createCommunicationPersistenceAuthorityV1,
  recordCommunicationIntentHeldV1,
  type RecordCommunicationIntentHeldInputV1,
} from '../../src/lib/communication-intent-persistence';
import {
  assertAiOrchestratorEphemeralDatabaseIdentity,
  assertAiOrchestratorEphemeralDbTestConfiguration,
} from './ai-orchestrator-db-test-guard';

const run = assertAiOrchestratorEphemeralDbTestConfiguration({
  requested: process.env.RUN_DB_TESTS === '1',
  destructiveConfirmed: process.env.AI_ORCHESTRATOR_DB_TESTS_CONFIRMED === '1',
  databaseUrl: process.env.DATABASE_URL,
  sentinel: process.env.AI_ORCHESTRATOR_DB_TEST_SENTINEL,
  appEnvironment: process.env.APP_ENV,
  nodeEnvironment: process.env.NODE_ENV,
});
const root = run ? new PrismaClient() : null;
const schema = `n15_persistence_${process.pid}`;
let db: PrismaClient | null = null;
const migrationName = '20260909120000_n15_dedicated_communication_persistence_v1';
const authority = createCommunicationPersistenceAuthorityV1({
  producerCode: 'N15_SYNTHETIC_FIXTURE',
  now: () => new Date('2026-09-09T12:00:00.000Z'),
});

function client() {
  if (!db) throw new Error('N15_TEST_DB_UNAVAILABLE');
  return db;
}

function input(ordinal: number, overrides: Partial<RecordCommunicationIntentHeldInputV1> = {}): RecordCommunicationIntentHeldInputV1 {
  return {
    intentId: `00000000-0000-4000-8000-${ordinal.toString().padStart(12, '0')}`,
    businessCorrelationId: '00000000-0000-4000-8000-000000150001',
    callerIdempotencyKey: `N15:SYNTHETIC:${ordinal}`,
    recipient: { authorityCode: 'CRM', entityType: 'LEAD', entityId: 'c000000000000000000000015' },
    message: {
      messageClass: 'SERVICE', reasonCode: 'SYNTHETIC_STATUS',
      templateReference: { templateCode: 'SYNTHETIC_STATUS', templateVersion: 'fixture-v1', templateHash: '1'.repeat(64) },
    },
    gateSnapshot: createDisabledCommunicationGateSnapshotV1(),
    ...overrides,
  };
}

test.before(async () => {
  if (!run || !root) return;
  await assertAiOrchestratorEphemeralDatabaseIdentity(root);
  const url = new URL(process.env.DATABASE_URL!);
  url.searchParams.set('schema', schema);
  await root.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  execFileSync(resolve('node_modules/.bin/prisma'), ['migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: url.toString() }, stdio: 'pipe', timeout: 180_000,
  });
  db = new PrismaClient({ datasources: { db: { url: url.toString() } } });
});

test.after(async () => {
  await db?.$disconnect();
  if (run && root) await root.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
  await root?.$disconnect();
});

test('N15 fresh install applies 44 migrations, creates empty dedicated storage and leaves N11 untouched', { skip: !run }, async () => {
  const migrations = await client().$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*)::bigint AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
  assert.equal(Number(migrations[0]?.count), 44);
  assert.deepEqual(await Promise.all([
    client().communicationIntentRecord.count(), client().communicationHeldDecision.count(), client().communicationIntentAudit.count(),
  ]), [0, 0, 0]);
  const before = await Promise.all([
    client().businessInboxEvent.count(), client().businessOutboxEvent.count(), client().businessQueueAttempt.count(),
    client().practiceCommunication.count(), client().auditLog.count(),
  ]);
  const result = await client().$transaction((tx) => recordCommunicationIntentHeldV1(tx, authority, input(1)));
  assert.equal(result.outcome, 'RECORDED');
  assert.deepEqual(await Promise.all([
    client().communicationIntentRecord.count(), client().communicationHeldDecision.count(), client().communicationIntentAudit.count(),
  ]), [1, 1, 1]);
  assert.deepEqual(await Promise.all([
    client().businessInboxEvent.count(), client().businessOutboxEvent.count(), client().businessQueueAttempt.count(),
    client().practiceCommunication.count(), client().auditLog.count(),
  ]), before);
});

test('N15 replay returns the original aggregate; conflicts and intentId collisions write nothing', { skip: !run }, async () => {
  const original = await client().$transaction((tx) => recordCommunicationIntentHeldV1(tx, authority, input(2)));
  const replay = await client().$transaction((tx) => recordCommunicationIntentHeldV1(tx, authority, {
    ...input(2), intentId: '00000000-0000-4000-8000-000000159999',
  }));
  assert.equal(replay.outcome, 'REPLAYED');
  assert.deepEqual(replay.intent, original.intent);
  const count = await client().communicationIntentRecord.count();
  await assert.rejects(
    client().$transaction((tx) => recordCommunicationIntentHeldV1(tx, authority, input(2, {
      message: { ...input(2).message, reasonCode: 'DIVERGENT_SYNTHETIC' },
    }))),
    (error: unknown) => error instanceof CommunicationPersistenceError && error.code === 'N15_IDEMPOTENCY_CONFLICT',
  );
  await assert.rejects(
    client().$transaction((tx) => recordCommunicationIntentHeldV1(tx, authority, input(3, {
      intentId: original.intent.intentId, message: { ...input(3).message, reasonCode: 'COLLIDING_SYNTHETIC' },
    }))),
    (error: unknown) => error instanceof CommunicationPersistenceError && error.code === 'N15_IDEMPOTENCY_CONFLICT',
  );
  assert.equal(await client().communicationIntentRecord.count(), count);
  const sameSemantic = await client().$transaction((tx) => recordCommunicationIntentHeldV1(tx, authority, input(4)));
  assert.equal(sameSemantic.outcome, 'RECORDED');
  assert.equal(sameSemantic.intent.idempotency.semanticHash, original.intent.idempotency.semanticHash);
});

test('N15 fault injection and caller rollback atomically remove intent, HELD, audit and caller cause', { skip: !run }, async () => {
  const before = await client().communicationIntentRecord.count();
  for (const [ordinal, point] of [[5, 'AFTER_INTENT'], [6, 'AFTER_DECISION']] as const) {
    await assert.rejects(client().$transaction((tx) => recordCommunicationIntentHeldV1(tx, authority, input(ordinal), (at) => {
      if (at === point) throw new Error(`SYNTHETIC_FAULT_${point}`);
    })));
  }
  await assert.rejects(client().$transaction(async (tx) => {
    await tx.$executeRaw`CREATE TEMP TABLE n15_synthetic_cause(value TEXT) ON COMMIT DROP`;
    await tx.$executeRaw`INSERT INTO n15_synthetic_cause(value) VALUES ('synthetic')`;
    await recordCommunicationIntentHeldV1(tx, authority, input(7));
    throw new Error('SYNTHETIC_CALLER_ROLLBACK');
  }));
  assert.equal(await client().communicationIntentRecord.count(), before);
  assert.equal(await client().communicationHeldDecision.count(), before);
  assert.equal(await client().communicationIntentAudit.count(), before);
});

test('N15 concurrent same-key writers produce one aggregate and one original identity', { skip: !run }, async () => {
  const results = await Promise.all(Array.from({ length: 8 }, () =>
    client().$transaction((tx) => recordCommunicationIntentHeldV1(tx, authority, input(8)))));
  assert.equal(results.filter((result) => result.outcome === 'RECORDED').length, 1);
  assert.equal(results.filter((result) => result.outcome === 'REPLAYED').length, 7);
  assert.equal(new Set(results.map((result) => result.intent.intentId)).size, 1);
});

test('N15 rows are immutable and replay fails closed for incomplete and hash-manipulated aggregates', { skip: !run }, async () => {
  const incompleteInput = input(9);
  const incomplete = await client().$transaction((tx) => recordCommunicationIntentHeldV1(tx, authority, incompleteInput));
  const incompleteRow = await client().communicationIntentRecord.findUniqueOrThrow({ where: { intentId: incomplete.intent.intentId } });
  await assert.rejects(client().communicationIntentAudit.delete({ where: { intentRecordId: incompleteRow.id } }));
  await client().$executeRawUnsafe('ALTER TABLE "CommunicationIntentAudit" DISABLE TRIGGER "CommunicationIntentAudit_append_only"');
  await client().communicationIntentAudit.delete({ where: { intentRecordId: incompleteRow.id } });
  await client().$executeRawUnsafe('ALTER TABLE "CommunicationIntentAudit" ENABLE TRIGGER "CommunicationIntentAudit_append_only"');
  await assert.rejects(client().$transaction((tx) => recordCommunicationIntentHeldV1(tx, authority, input(9))),
    (error: unknown) => error instanceof CommunicationPersistenceError && error.code === 'N15_AGGREGATE_INCOMPLETE');

  const created = await client().$transaction((tx) => recordCommunicationIntentHeldV1(tx, authority, input(10)));
  await assert.rejects(client().communicationIntentRecord.update({ where: { intentId: created.intent.intentId }, data: { envelopeHash: 'f'.repeat(64) } }));
  await client().$executeRawUnsafe('ALTER TABLE "CommunicationIntentRecord" DISABLE TRIGGER "CommunicationIntentRecord_append_only"');
  await client().communicationIntentRecord.update({ where: { intentId: created.intent.intentId }, data: { envelopeHash: 'f'.repeat(64) } });
  await client().$executeRawUnsafe('ALTER TABLE "CommunicationIntentRecord" ENABLE TRIGGER "CommunicationIntentRecord_append_only"');
  await assert.rejects(client().$transaction((tx) => recordCommunicationIntentHeldV1(tx, authority, input(10))),
    (error: unknown) => error instanceof CommunicationPersistenceError && error.code === 'N15_AGGREGATE_INCOHERENT');
});

test('N15 upgrades 43 to 44 and fails explicitly without schema; N-1 remains compatible with dormant schema', { skip: !run, timeout: 180_000 }, async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'n15-upgrade-'));
  const prismaDirectory = join(temporary, 'prisma');
  const migrationsDirectory = join(prismaDirectory, 'migrations');
  mkdirSync(migrationsDirectory, { recursive: true });
  cpSync('prisma/schema.prisma', join(prismaDirectory, 'schema.prisma'));
  const names = readdirSync('prisma/migrations').filter((name) => /^\d/u.test(name)).sort();
  assert.equal(names.length, 44);
  for (const name of names.slice(0, 43)) cpSync(join('prisma/migrations', name), join(migrationsDirectory, name), { recursive: true });
  const oldSchema = `${schema}_old`;
  const url = new URL(process.env.DATABASE_URL!); url.searchParams.set('schema', oldSchema);
  await root!.$executeRawUnsafe(`CREATE SCHEMA "${oldSchema}"`);
  const oldClient = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  try {
    execFileSync(resolve('node_modules/.bin/prisma'), ['migrate', 'deploy', '--schema', join(prismaDirectory, 'schema.prisma')], { env: { ...process.env, DATABASE_URL: url.toString() }, stdio: 'pipe', timeout: 180_000 });
    assert.equal(Number((await oldClient.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*)::bigint AS count FROM "_prisma_migrations"`)[0]?.count), 43);
    await assert.rejects(oldClient.$transaction((tx) => recordCommunicationIntentHeldV1(tx, authority, input(11))),
      (error: unknown) => error instanceof CommunicationPersistenceError && error.code === 'N15_SCHEMA_UNAVAILABLE');
    cpSync(join('prisma/migrations', migrationName), join(migrationsDirectory, migrationName), { recursive: true });
    execFileSync(resolve('node_modules/.bin/prisma'), ['migrate', 'deploy', '--schema', join(prismaDirectory, 'schema.prisma')], { env: { ...process.env, DATABASE_URL: url.toString() }, stdio: 'pipe', timeout: 180_000 });
    assert.equal(Number((await oldClient.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*)::bigint AS count FROM "_prisma_migrations"`)[0]?.count), 44);
    assert.deepEqual(await Promise.all([oldClient.communicationIntentRecord.count(), oldClient.communicationHeldDecision.count(), oldClient.communicationIntentAudit.count()]), [0, 0, 0]);
    // An N-1 application performs no N15 call, so the additive dormant tables are inert.
    assert.equal(await oldClient.businessInboxEvent.count(), 0);
  } finally {
    await oldClient.$disconnect();
    await root!.$executeRawUnsafe(`DROP SCHEMA "${oldSchema}" CASCADE`);
    rmSync(temporary, { recursive: true, force: true });
  }
});
