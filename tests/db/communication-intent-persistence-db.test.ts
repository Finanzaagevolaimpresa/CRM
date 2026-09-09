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
  runCommunicationPersistenceTransactionV1,
  type CommunicationPersistenceTransactionV1,
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
  await db.$executeRaw`CREATE TABLE "N15SyntheticCallerCause" ("id" TEXT PRIMARY KEY)`;
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
  const result = await runCommunicationPersistenceTransactionV1(client(), (tx) => recordCommunicationIntentHeldV1(tx, authority, input(1)));
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
  const original = await runCommunicationPersistenceTransactionV1(client(), (tx) => recordCommunicationIntentHeldV1(tx, authority, input(2)));
  const replay = await runCommunicationPersistenceTransactionV1(client(), (tx) => recordCommunicationIntentHeldV1(tx, authority, {
    ...input(2), intentId: '00000000-0000-4000-8000-000000159999',
  }));
  assert.equal(replay.outcome, 'REPLAYED');
  assert.deepEqual(replay.intent, original.intent);
  const count = await client().communicationIntentRecord.count();
  await assert.rejects(
    runCommunicationPersistenceTransactionV1(client(), (tx) => recordCommunicationIntentHeldV1(tx, authority, input(2, {
      message: { ...input(2).message, reasonCode: 'DIVERGENT_SYNTHETIC' },
    }))),
    (error: unknown) => error instanceof CommunicationPersistenceError && error.code === 'N15_IDEMPOTENCY_CONFLICT',
  );
  await assert.rejects(
    runCommunicationPersistenceTransactionV1(client(), (tx) => recordCommunicationIntentHeldV1(tx, authority, input(3, {
      intentId: original.intent.intentId, message: { ...input(3).message, reasonCode: 'COLLIDING_SYNTHETIC' },
    }))),
    (error: unknown) => error instanceof CommunicationPersistenceError && error.code === 'N15_IDEMPOTENCY_CONFLICT',
  );
  assert.equal(await client().communicationIntentRecord.count(), count);
  const sameSemantic = await runCommunicationPersistenceTransactionV1(client(), (tx) => recordCommunicationIntentHeldV1(tx, authority, input(4)));
  assert.equal(sameSemantic.outcome, 'RECORDED');
  assert.equal(sameSemantic.intent.idempotency.semanticHash, original.intent.idempotency.semanticHash);
});

test('N15 fault injection and caller rollback atomically remove intent, HELD, audit and caller cause', { skip: !run }, async () => {
  const before = await Promise.all([
    client().communicationIntentRecord.count(), client().communicationHeldDecision.count(),
    client().communicationIntentAudit.count(),
  ]);
  for (const [ordinal, point] of [[5, 'AFTER_INTENT'], [6, 'AFTER_DECISION']] as const) {
    const causeId = `fault-${point}`;
    await assert.rejects(runCommunicationPersistenceTransactionV1(client(), async (tx) => {
      await tx.client.$executeRaw`INSERT INTO "N15SyntheticCallerCause" ("id") VALUES (${causeId})`;
      return recordCommunicationIntentHeldV1(tx, authority, input(ordinal), (at) => {
        if (at === point) throw new Error(`SYNTHETIC_FAULT_${point}`);
      });
    }));
    assert.equal(Number((await client().$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*)::bigint AS count FROM "N15SyntheticCallerCause" WHERE "id" = ${causeId}`)[0]?.count), 0);
  }

  await runCommunicationPersistenceTransactionV1(client(), async (tx) => {
    await tx.client.$executeRaw`INSERT INTO "N15SyntheticCallerCause" ("id") VALUES ('committed-cause')`;
    await recordCommunicationIntentHeldV1(tx, authority, input(7));
  });
  assert.equal(Number((await client().$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*)::bigint AS count FROM "N15SyntheticCallerCause" WHERE "id" = 'committed-cause'`)[0]?.count), 1);
  assert.deepEqual(await Promise.all([
    client().communicationIntentRecord.count(), client().communicationHeldDecision.count(),
    client().communicationIntentAudit.count(),
  ]), before.map((count) => count + 1));

  await assert.rejects(runCommunicationPersistenceTransactionV1(client(), async (tx) => {
    await tx.client.$executeRaw`INSERT INTO "N15SyntheticCallerCause" ("id") VALUES ('rolled-back-cause')`;
    await recordCommunicationIntentHeldV1(tx, authority, input(12));
    throw new Error('SYNTHETIC_CALLER_ROLLBACK');
  }));
  assert.equal(Number((await client().$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*)::bigint AS count FROM "N15SyntheticCallerCause" WHERE "id" = 'rolled-back-cause'`)[0]?.count), 0);
  assert.deepEqual(await Promise.all([
    client().communicationIntentRecord.count(), client().communicationHeldDecision.count(),
    client().communicationIntentAudit.count(),
  ]), before.map((count) => count + 1));
});

test('N15 concurrent same-key writers produce one aggregate and one original identity', { skip: !run }, async () => {
  const results = await Promise.all(Array.from({ length: 8 }, () =>
    runCommunicationPersistenceTransactionV1(client(), (tx) => recordCommunicationIntentHeldV1(tx, authority, input(8)))));
  assert.equal(results.filter((result) => result.outcome === 'RECORDED').length, 1);
  assert.equal(results.filter((result) => result.outcome === 'REPLAYED').length, 7);
  assert.equal(new Set(results.map((result) => result.intent.intentId)).size, 1);
});

test('N15 rows are immutable and replay fails closed for incomplete and hash-manipulated aggregates', { skip: !run }, async () => {
  const incompleteInput = input(9);
  const incomplete = await runCommunicationPersistenceTransactionV1(client(), (tx) => recordCommunicationIntentHeldV1(tx, authority, incompleteInput));
  const incompleteRow = await client().communicationIntentRecord.findUniqueOrThrow({ where: { intentId: incomplete.intent.intentId } });
  await assert.rejects(client().communicationIntentAudit.delete({ where: { intentRecordId: incompleteRow.id } }));
  await client().$executeRawUnsafe('ALTER TABLE "CommunicationIntentAudit" DISABLE TRIGGER "CommunicationIntentAudit_append_only"');
  await client().communicationIntentAudit.delete({ where: { intentRecordId: incompleteRow.id } });
  await client().$executeRawUnsafe('ALTER TABLE "CommunicationIntentAudit" ENABLE TRIGGER "CommunicationIntentAudit_append_only"');
  await assert.rejects(runCommunicationPersistenceTransactionV1(client(), (tx) => recordCommunicationIntentHeldV1(tx, authority, input(9))),
    (error: unknown) => error instanceof CommunicationPersistenceError && error.code === 'N15_AGGREGATE_INCOMPLETE');

  const created = await runCommunicationPersistenceTransactionV1(client(), (tx) => recordCommunicationIntentHeldV1(tx, authority, input(10)));
  await assert.rejects(client().communicationIntentRecord.update({ where: { intentId: created.intent.intentId }, data: { envelopeHash: 'f'.repeat(64) } }));
  await client().$executeRawUnsafe('ALTER TABLE "CommunicationIntentRecord" DISABLE TRIGGER "CommunicationIntentRecord_append_only"');
  await client().communicationIntentRecord.update({ where: { intentId: created.intent.intentId }, data: { envelopeHash: 'f'.repeat(64) } });
  await client().$executeRawUnsafe('ALTER TABLE "CommunicationIntentRecord" ENABLE TRIGGER "CommunicationIntentRecord_append_only"');
  await assert.rejects(runCommunicationPersistenceTransactionV1(client(), (tx) => recordCommunicationIntentHeldV1(tx, authority, input(10))),
    (error: unknown) => error instanceof CommunicationPersistenceError && error.code === 'N15_AGGREGATE_INCOHERENT');
});


test('N15 rejects autocommit and commits with swallowed faults, preserving caller-cause atomicity', { skip: !run }, async () => {
  const counts = () => Promise.all([
    client().communicationIntentRecord.count(), client().communicationHeldDecision.count(), client().communicationIntentAudit.count(),
  ]);
  const before = await counts();
  for (const [ordinal, point] of [[20, 'AFTER_INTENT'], [21, 'AFTER_DECISION']] as const) {
    const causeId = 'caught-' + point;
    let faultCaught = false;
    await assert.rejects(runCommunicationPersistenceTransactionV1(client(), async (tx) => {
      await tx.client.$executeRaw`INSERT INTO "N15SyntheticCallerCause" ("id") VALUES (${causeId})`;
      try {
        await recordCommunicationIntentHeldV1(tx, authority, input(ordinal), (at) => {
          if (at === point) throw new Error('SYNTHETIC_CAUGHT_' + point);
        });
      } catch (error) {
        assert.equal((error as Error).message, 'SYNTHETIC_CAUGHT_' + point);
        faultCaught = true;
      }
      return 'attempt-to-commit';
    }), (error: unknown) => (error as Error).message === 'SYNTHETIC_CAUGHT_' + point);
    assert.equal(faultCaught, true);
    assert.deepEqual(await counts(), before);
    assert.equal(Number((await client().$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*)::bigint AS count FROM "N15SyntheticCallerCause" WHERE "id" = ${causeId}`)[0]?.count), 0);
  }

  // Exercise the native deferred constraint separately from the operation-error latch.
  await assert.rejects(runCommunicationPersistenceTransactionV1(client(), async (scope) => {
    await scope.client.$executeRaw`INSERT INTO "N15SyntheticCallerCause" ("id") VALUES ('native-completeness-cause')`;
    await scope.client.communicationIntentRecord.create({ data: {
      id: '00000000-0000-4000-8000-000000150090',
      intentId: '00000000-0000-4000-8000-000000150091',
      producerCode: 'N15_SYNTHETIC_FIXTURE', keyDigest: '2'.repeat(64), semanticHash: '3'.repeat(64),
      envelopeHash: '4'.repeat(64), canonicalEnvelope: '{}', state: 'RECORDED',
      occurredAt: new Date('2026-09-09T12:00:00.000Z'),
    } });
    return 'attempt-native-partial-commit';
  }), (error: unknown) => String(error).includes('N15_COMMUNICATION_AGGREGATE_INCOMPLETE'));
  assert.deepEqual(await counts(), before);
  assert.equal(Number((await client().$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*)::bigint AS count FROM "N15SyntheticCallerCause" WHERE "id" = 'native-completeness-cause'`)[0]?.count), 0);

  const transactionRequired = (error: unknown) => error instanceof CommunicationPersistenceError && error.code === 'N15_TRANSACTION_REQUIRED';
  await assert.rejects(recordCommunicationIntentHeldV1(client() as unknown as CommunicationPersistenceTransactionV1, authority, input(22)), transactionRequired);
  await client().$transaction(async (tx) => {
    await assert.rejects(recordCommunicationIntentHeldV1(tx as unknown as CommunicationPersistenceTransactionV1, authority, input(22)), transactionRequired);
  });
  assert.deepEqual(await counts(), before);
  let expiredScope: CommunicationPersistenceTransactionV1 | undefined;
  await runCommunicationPersistenceTransactionV1(client(), async (tx) => {
    expiredScope = tx;
    await tx.client.$executeRaw`INSERT INTO "N15SyntheticCallerCause" ("id") VALUES ('complete-after-caught-fault')`;
    await recordCommunicationIntentHeldV1(tx, authority, input(23));
  });
  assert.deepEqual(await counts(), before.map((count) => count + 1));
  assert.equal(Number((await client().$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*)::bigint AS count FROM "N15SyntheticCallerCause" WHERE "id" = 'complete-after-caught-fault'`)[0]?.count), 1);
  assert.ok(expiredScope);
  await assert.rejects(recordCommunicationIntentHeldV1(expiredScope, authority, input(24)), transactionRequired);
  assert.deepEqual(await counts(), before.map((count) => count + 1));
});

test('N15 replay rejects each divergent authority/time column and preserves the restored original aggregate', { skip: !run }, async () => {
  for (const [index, field] of ['producerCode', 'occurredAt', 'evaluatedAt'].entries()) {
    const candidateInput = input(30 + index);
    const original = await runCommunicationPersistenceTransactionV1(client(), (tx) => recordCommunicationIntentHeldV1(tx, authority, candidateInput));
    const row = await client().communicationIntentRecord.findUniqueOrThrow({
      where: { intentId: original.intent.intentId }, include: { heldDecision: true },
    });
    const table = field === 'evaluatedAt' ? 'CommunicationHeldDecision' : 'CommunicationIntentRecord';
    const alterProjection = async (restore: boolean) => {
      // Controlled corruption of invented fixture data; restore the guard even if the mutation fails.
      await client().$executeRawUnsafe('ALTER TABLE "' + table + '" DISABLE TRIGGER "' + table + '_append_only"');
      try {
        if (field === 'producerCode') {
          await client().communicationIntentRecord.update({ where: { id: row.id }, data: { producerCode: restore ? row.producerCode : 'DIVERGENT_SYNTHETIC' } });
        } else if (field === 'occurredAt') {
          await client().communicationIntentRecord.update({ where: { id: row.id }, data: { occurredAt: restore ? row.occurredAt : new Date(row.occurredAt.valueOf() + 1) } });
        } else {
          await client().communicationHeldDecision.update({ where: { intentRecordId: row.id }, data: { evaluatedAt: restore ? row.heldDecision!.evaluatedAt : new Date(row.heldDecision!.evaluatedAt.valueOf() + 1) } });
        }
      } finally {
        await client().$executeRawUnsafe('ALTER TABLE "' + table + '" ENABLE TRIGGER "' + table + '_append_only"');
      }
    };
    const counts = () => Promise.all([
      client().communicationIntentRecord.count(), client().communicationHeldDecision.count(), client().communicationIntentAudit.count(),
    ]);
    const before = await counts();
    await alterProjection(false);
    await assert.rejects(runCommunicationPersistenceTransactionV1(client(), (tx) => recordCommunicationIntentHeldV1(tx, authority, candidateInput)),
      (error: unknown) => error instanceof CommunicationPersistenceError && error.code === 'N15_AGGREGATE_INCOHERENT');
    assert.deepEqual(await counts(), before, field);
    await alterProjection(true);
    const replay = await runCommunicationPersistenceTransactionV1(client(), (tx) => recordCommunicationIntentHeldV1(tx, authority, candidateInput));
    assert.equal(replay.outcome, 'REPLAYED');
    assert.deepEqual({ ...replay, outcome: 'RECORDED' }, original, field);
    assert.deepEqual(await counts(), before, field);
  }
});

test('N15 rejects TRUNCATE of either child and the complete aggregate without changing rows or hashes', { skip: !run }, async () => {
  const snapshot = () => Promise.all([
    client().communicationIntentRecord.findMany({ orderBy: { id: 'asc' } }),
    client().communicationHeldDecision.findMany({ orderBy: { id: 'asc' } }),
    client().communicationIntentAudit.findMany({ orderBy: { id: 'asc' } }),
  ]);
  const before = await snapshot();
  assert.equal(before.every((rows) => rows.length > 0), true);
  for (const statement of [
    'TRUNCATE TABLE "CommunicationHeldDecision"',
    'TRUNCATE TABLE "CommunicationIntentAudit"',
    'TRUNCATE TABLE "CommunicationIntentRecord", "CommunicationHeldDecision", "CommunicationIntentAudit"',
  ]) {
    await assert.rejects(client().$executeRawUnsafe(statement),
      (error: unknown) => String(error).includes('N15_COMMUNICATION_AGGREGATE_APPEND_ONLY'));
    assert.deepEqual(await snapshot(), before);
  }
});

test('N15 upgrades 43 to 44 and the new API fails explicitly without its schema', { skip: !run, timeout: 180_000 }, async () => {
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
    await assert.rejects(runCommunicationPersistenceTransactionV1(oldClient, (tx) => recordCommunicationIntentHeldV1(tx, authority, input(11))),
      (error: unknown) => error instanceof CommunicationPersistenceError && error.code === 'N15_SCHEMA_UNAVAILABLE');
    cpSync(join('prisma/migrations', migrationName), join(migrationsDirectory, migrationName), { recursive: true });
    execFileSync(resolve('node_modules/.bin/prisma'), ['migrate', 'deploy', '--schema', join(prismaDirectory, 'schema.prisma')], { env: { ...process.env, DATABASE_URL: url.toString() }, stdio: 'pipe', timeout: 180_000 });
    assert.equal(Number((await oldClient.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*)::bigint AS count FROM "_prisma_migrations"`)[0]?.count), 44);
    assert.deepEqual(await Promise.all([oldClient.communicationIntentRecord.count(), oldClient.communicationHeldDecision.count(), oldClient.communicationIntentAudit.count()]), [0, 0, 0]);
    // Schema dormancy is checked here; the N05 Docker drill executes the actual N-1 application.
    assert.equal(await oldClient.businessInboxEvent.count(), 0);
  } finally {
    await oldClient.$disconnect();
    await root!.$executeRawUnsafe(`DROP SCHEMA "${oldSchema}" CASCADE`);
    rmSync(temporary, { recursive: true, force: true });
  }
});
