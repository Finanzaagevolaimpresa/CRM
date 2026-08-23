import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  claimCommercialLeadInboxItem,
  initializeCommercialLeadInboxItem,
} from '../../src/lib/commercial-lead-inbox';
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
const originalInboxMode = process.env.COMMERCIAL_LEAD_INBOX_MODE;
const originalSessionMode = process.env.INTERNAL_SESSION_MODE;
const actorUserId = 'n14-synthetic-commercial-user';
const actorSessionId = '00000000-0000-4000-8000-000000140001';

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
  process.env.COMMERCIAL_LEAD_INBOX_MODE = 'enforced';
  process.env.INTERNAL_SESSION_MODE = 'registry';
});

async function ensureActorAndPolicy() {
  if (await client().user.count({ where: { id: actorUserId } })) return;
  await client().user.create({ data: {
    id: actorUserId,
    email: 'commercial@n14-db.invalid',
    name: 'N14 Synthetic Commercial',
    passwordHash: 'synthetic-not-a-real-password-hash',
    role: 'commerciale',
    active: true,
  } });
  await client().internalSession.create({ data: {
    id: actorSessionId,
    userId: actorUserId,
    tokenDigest: Buffer.alloc(32, 14),
    expiresAt: new Date('2099-01-01T00:00:00.000Z'),
  } });
  await client().commercialLeadSlaPolicyVersion.create({ data: {
    id: '00000000-0000-4000-8000-000000140002',
    policyCode: 'COMMERCIAL_FIRST_RESPONSE',
    version: 1,
    status: 'ACTIVE',
    calendarCode: 'CONTINUOUS_24X7',
    timezoneCode: 'UTC',
    responseTargetSeconds: 3_600,
    createdById: actorUserId,
  } });
}

test.after(async () => {
  await db?.$disconnect();
  if (originalInboxMode === undefined) delete process.env.COMMERCIAL_LEAD_INBOX_MODE;
  else process.env.COMMERCIAL_LEAD_INBOX_MODE = originalInboxMode;
  if (originalSessionMode === undefined) delete process.env.INTERNAL_SESSION_MODE;
  else process.env.INTERNAL_SESSION_MODE = originalSessionMode;
  if (runDbTests) await rootClient().$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
  await rootDb?.$disconnect();
});

async function syntheticLead(ordinal: number) {
  return client().lead.create({ data: {
    id: `n14-synthetic-lead-${ordinal}`,
    firstName: 'Synthetic',
    lastName: `Lead ${ordinal}`,
    email: `lead-${ordinal}@n14-db.invalid`,
    source: 'CRM',
    leadSource: 'manuale',
  } });
}

const actor = Object.freeze({ userId: actorUserId, sessionId: actorSessionId });

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

test('N14 qualifies the exact additive 41 to 42 upgrade and preserves a legacy Lead', {
  skip: !runDbTests,
  timeout: 240_000,
}, async () => {
  const upgradeSchema = `n14_upgrade_${process.pid}`;
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'n14-upgrade-'));
  const prismaDirectory = join(temporaryRoot, 'prisma');
  const migrationsDirectory = join(prismaDirectory, 'migrations');
  mkdirSync(migrationsDirectory, { recursive: true });
  cpSync('prisma/schema.prisma', join(prismaDirectory, 'schema.prisma'));
  const names = readdirSync('prisma/migrations').filter((name) => /^\d/u.test(name)).sort();
  assert.equal(names.length, 42);
  assert.equal(names[41], migrationName);
  const url = new URL(process.env.DATABASE_URL!);
  url.searchParams.set('schema', upgradeSchema);
  await rootClient().$executeRawUnsafe(`CREATE SCHEMA "${upgradeSchema}"`);
  try {
    for (const name of names.slice(0, 41)) {
      cpSync(join('prisma/migrations', name), join(migrationsDirectory, name), { recursive: true });
    }
    execFileSync(resolve('node_modules/.bin/prisma'), ['migrate', 'deploy', '--schema', join(prismaDirectory, 'schema.prisma')], {
      env: { ...process.env, DATABASE_URL: url.toString() }, stdio: 'pipe', timeout: 180_000,
    });
    const before = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    try {
      await before.lead.create({ data: {
        id: 'n14-upgrade-legacy-lead', firstName: 'Legacy', lastName: 'Synthetic',
        email: 'legacy@n14-upgrade.invalid', source: 'LEGACY', leadSource: 'altro',
      } });
      assert.equal(Number((await before.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*)::bigint AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`)[0]?.count), 41);
    } finally { await before.$disconnect(); }
    cpSync(join('prisma/migrations', migrationName), join(migrationsDirectory, migrationName), { recursive: true });
    execFileSync(resolve('node_modules/.bin/prisma'), ['migrate', 'deploy', '--schema', join(prismaDirectory, 'schema.prisma')], {
      env: { ...process.env, DATABASE_URL: url.toString() }, stdio: 'pipe', timeout: 180_000,
    });
    const after = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    try {
      assert.equal(Number((await after.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*)::bigint AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`)[0]?.count), 42);
      assert.equal(await after.lead.count({ where: { id: 'n14-upgrade-legacy-lead', source: 'LEGACY' } }), 1);
      assert.equal(await after.commercialLeadInboxItem.count(), 0);
      assert.equal(await after.commercialLeadSlaPolicyVersion.count(), 0);
    } finally { await after.$disconnect(); }
  } finally {
    await rootClient().$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${upgradeSchema}" CASCADE`);
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('N14 initialize binds database-clock SLA and writes item, cycle, activity and audit atomically', {
  skip: !runDbTests,
}, async () => {
  await ensureActorAndPolicy();
  const lead = await syntheticLead(1);
  const item = await initializeCommercialLeadInboxItem(client(), {
    leadId: lead.id,
    actor,
    attribution: { originKind: 'MANUAL_CRM' },
    reasonCode: 'MANUAL_INTAKE',
  });
  const [cycle, activity, audit] = await Promise.all([
    client().commercialLeadSlaCycle.findFirstOrThrow({ where: { inboxItemId: item.id } }),
    client().commercialLeadActivity.findFirstOrThrow({ where: { inboxItemId: item.id } }),
    client().auditLog.findFirstOrThrow({ where: { entityType: 'CommercialLeadInboxItem', entityId: item.id } }),
  ]);
  assert.equal(cycle.dueAt.getTime() - cycle.availableAt.getTime(), 3_600_000);
  assert.equal(activity.activityType, 'INITIALIZED');
  assert.equal(audit.event, 'commercial_lead_inbox_initialized');
  assert.equal(item.sourceSystem, 'CRM');
  assert.equal(item.formCode, 'LEAD_CREATE_UI');
});

test('N14 two concurrent self-claims produce exactly one winner', {
  skip: !runDbTests,
}, async () => {
  await ensureActorAndPolicy();
  const lead = await syntheticLead(2);
  await initializeCommercialLeadInboxItem(client(), {
    leadId: lead.id, actor, attribution: { originKind: 'MANUAL_CRM' }, reasonCode: 'MANUAL_INTAKE',
  });
  const attempts = await Promise.allSettled([
    claimCommercialLeadInboxItem(client(), { leadId: lead.id, actor, expectedInboxVersion: 1 }),
    claimCommercialLeadInboxItem(client(), { leadId: lead.id, actor, expectedInboxVersion: 1 }),
  ]);
  assert.equal(attempts.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal(attempts.filter(({ status }) => status === 'rejected').length, 1);
  assert.equal((await client().lead.findUniqueOrThrow({ where: { id: lead.id } })).assignedToId, actorUserId);
  assert.equal(await client().commercialLeadActivity.count({ where: { inboxItem: { leadId: lead.id }, activityType: 'CLAIMED' } }), 1);
});

test('N14 fault injection rolls back item, cycle, activity and audit together', {
  skip: !runDbTests,
}, async () => {
  await ensureActorAndPolicy();
  const lead = await syntheticLead(3);
  const auditBefore = await client().auditLog.count({ where: { entityType: 'CommercialLeadInboxItem' } });
  await assert.rejects(initializeCommercialLeadInboxItem(client(), {
    leadId: lead.id,
    actor,
    attribution: { originKind: 'MANUAL_CRM' },
    reasonCode: 'MANUAL_INTAKE',
    faultAt: 'AFTER_ACTIVITY',
  }), /N14_SYNTHETIC_FAULT_AFTER_ACTIVITY/u);
  assert.equal(await client().commercialLeadInboxItem.count({ where: { leadId: lead.id } }), 0);
  assert.equal(await client().commercialLeadSlaCycle.count({ where: { inboxItem: { leadId: lead.id } } }), 0);
  assert.equal(await client().commercialLeadActivity.count({ where: { inboxItem: { leadId: lead.id } } }), 0);
  assert.equal(await client().auditLog.count({ where: { entityType: 'CommercialLeadInboxItem' } }), auditBefore);
});

test('N14 database guards reject source overwrite, raw owner bypass and activity mutation', {
  skip: !runDbTests,
}, async () => {
  await ensureActorAndPolicy();
  const lead = await syntheticLead(4);
  const item = await initializeCommercialLeadInboxItem(client(), {
    leadId: lead.id, actor, attribution: { originKind: 'MANUAL_CRM' }, reasonCode: 'MANUAL_INTAKE',
  });
  await assert.rejects(client().lead.update({ where: { id: lead.id }, data: { source: 'FORGED' } }), /N14_LEAD_SOURCE_IMMUTABLE/u);
  await assert.rejects(client().lead.update({ where: { id: lead.id }, data: { assignedToId: actorUserId } }), /N14_LEAD_WRITER_BYPASS/u);
  const activity = await client().commercialLeadActivity.findFirstOrThrow({ where: { inboxItemId: item.id } });
  await assert.rejects(client().commercialLeadActivity.update({ where: { id: activity.id }, data: { reasonCode: 'PROJECTED_NEW' } }), /N14_ACTIVITY_APPEND_ONLY/u);
});
