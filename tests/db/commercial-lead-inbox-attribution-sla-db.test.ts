import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  assertAiOrchestratorEphemeralDatabaseIdentity,
  assertAiOrchestratorEphemeralDbTestConfiguration,
} from './ai-orchestrator-db-test-guard';

const runDbTests = assertAiOrchestratorEphemeralDbTestConfiguration({
  requested: process.env.RUN_DB_TESTS === '1',
  destructiveConfirmed: process.env.AI_ORCHESTRATOR_DB_TESTS_CONFIRMED === '1',
  databaseUrl: process.env.DATABASE_URL,
  sentinel: process.env.AI_ORCHESTRATOR_DB_TEST_SENTINEL,
  appEnvironment: process.env.APP_ENV,
  nodeEnvironment: process.env.NODE_ENV,
});
const migrationName = '20260823160000_commercial_lead_inbox_attribution_sla_v1';
const migrationPath = `prisma/migrations/${migrationName}/migration.sql`;
const schema = `n14_contract_${process.pid}`;
const rootDb = runDbTests ? new PrismaClient() : null;
let db: PrismaClient | null = null;

function rootClient() {
  if (!rootDb) throw new Error('N14_ROOT_DB_UNAVAILABLE');
  return rootDb;
}

function client() {
  if (!db) throw new Error('N14_SCHEMA_DB_UNAVAILABLE');
  return db;
}

test.before(async () => {
  if (!runDbTests) return;
  await assertAiOrchestratorEphemeralDatabaseIdentity(rootClient());
  const url = new URL(process.env.DATABASE_URL!);
  url.searchParams.set('schema', schema);
  await rootClient().$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  execFileSync(resolve('node_modules/.bin/prisma'), ['migrate', 'deploy', '--schema', 'prisma/schema.prisma'], {
    env: { ...process.env, DATABASE_URL: url.toString() },
    stdio: 'pipe',
    timeout: 180_000,
  });
  db = new PrismaClient({ datasources: { db: { url: url.toString() } } });
});

test.after(async () => {
  await db?.$disconnect();
  if (runDbTests) await rootClient().$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
  await rootDb?.$disconnect();
});

test('N14 migration 42 is transactional, additive and business-empty by construction', () => {
  const sql = readFileSync(migrationPath, 'utf8');
  assert.match(sql, /^BEGIN;/u);
  assert.match(sql, /COMMIT;\s*$/u);
  assert.equal((sql.match(/^CREATE TABLE /gmu) ?? []).length, 4);
  assert.equal((sql.match(/^CREATE FUNCTION /gmu) ?? []).length, 5);
  assert.equal((sql.match(/^CREATE TRIGGER /gmu) ?? []).length, 9);
  assert.doesNotMatch(sql, /^\s*(?:INSERT|UPDATE|DELETE)\s/imu);
  assert.doesNotMatch(sql, /CREATE\s+(?:EXTENSION|EVENT)|\b(?:cron|scheduler|dblink|http)\b/iu);
  assert.match(sql, /N21_UNASSIGNED/u);
  assert.match(sql, /N14_LEAD_WRITER_BYPASS/u);
});

test('N14 fresh42 catalog is exact and contains zero policy, item, cycle or activity rows', {
  skip: !runDbTests,
  timeout: 240_000,
}, async () => {
  const [migrationRows, catalogRows, indexRows, triggerRows, functionRows, businessRows] = await Promise.all([
    client().$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*)::bigint AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`,
    client().$queryRaw<Array<{ name: string }>>(Prisma.sql`
      SELECT table_name AS name FROM information_schema.tables
      WHERE table_schema = ${schema} AND table_name LIKE 'CommercialLead%'
      ORDER BY table_name
    `),
    client().$queryRaw<Array<{ name: string }>>(Prisma.sql`
      SELECT indexname AS name FROM pg_indexes
      WHERE schemaname = ${schema} AND tablename LIKE 'CommercialLead%'
      ORDER BY indexname
    `),
    client().$queryRaw<Array<{ name: string }>>(Prisma.sql`
      SELECT trigger_name AS name FROM information_schema.triggers
      WHERE trigger_schema = ${schema} AND (event_object_table LIKE 'CommercialLead%' OR event_object_table = 'Lead')
      GROUP BY trigger_name ORDER BY trigger_name
    `),
    client().$queryRaw<Array<{ name: string }>>(Prisma.sql`
      SELECT routine_name AS name FROM information_schema.routines
      WHERE routine_schema = ${schema} AND routine_name LIKE 'n14_%'
      ORDER BY routine_name
    `),
    client().$queryRaw<Array<{ policies: bigint; items: bigint; cycles: bigint; activities: bigint }>>`
      SELECT
        (SELECT COUNT(*)::bigint FROM "CommercialLeadSlaPolicyVersion") AS policies,
        (SELECT COUNT(*)::bigint FROM "CommercialLeadInboxItem") AS items,
        (SELECT COUNT(*)::bigint FROM "CommercialLeadSlaCycle") AS cycles,
        (SELECT COUNT(*)::bigint FROM "CommercialLeadActivity") AS activities
    `,
  ]);
  assert.equal(Number(migrationRows[0]?.count), 42);
  assert.deepEqual(catalogRows.map(({ name }) => name), [
    'CommercialLeadActivity',
    'CommercialLeadInboxItem',
    'CommercialLeadSlaCycle',
    'CommercialLeadSlaPolicyVersion',
  ]);
  assert.equal(indexRows.length, 25);
  assert.equal(triggerRows.length, 9);
  assert.equal(functionRows.length, 5);
  assert.deepEqual(businessRows[0], { policies: 0n, items: 0n, cycles: 0n, activities: 0n });
});
