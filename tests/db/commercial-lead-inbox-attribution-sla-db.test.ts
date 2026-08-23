import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  claimCommercialLeadInboxItem,
  closeCommercialLeadInboxItem,
  convertCommercialLeadInboxItem,
  initializeCommercialLeadInboxItem,
  recordCommercialLeadFirstResponse,
  reopenCommercialLeadInboxItem,
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
const managerUserId = 'n14-synthetic-manager-user';
const managerSessionId = '00000000-0000-4000-8000-000000140003';

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
  await client().user.create({ data: {
    id: managerUserId,
    email: 'manager@n14-db.invalid',
    name: 'N14 Synthetic Manager',
    passwordHash: 'synthetic-not-a-real-password-hash',
    role: 'direzione',
    active: true,
  } });
  await client().internalSession.create({ data: {
    id: managerSessionId,
    userId: managerUserId,
    tokenDigest: Buffer.alloc(32, 15),
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
const manager = Object.freeze({ userId: managerUserId, sessionId: managerSessionId });

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
  assert.match(sql, /N14_WEBSITE_ATTRIBUTION_INVALID/u);
  assert.doesNotMatch(sql, /CommercialLeadInboxItem_privacyEvidenceReceiptId_fkey/u);
  assert.doesNotMatch(sql, /CommercialLeadInboxItem_projectionLedgerId_fkey/u);
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
      SELECT trigger_row.tgname AS name
      FROM pg_trigger trigger_row
      JOIN pg_class table_row ON table_row.oid = trigger_row.tgrelid
      JOIN pg_namespace namespace_row ON namespace_row.oid = table_row.relnamespace
      WHERE namespace_row.nspname = ${schema}
        AND (table_row.relname LIKE 'CommercialLead%' OR table_row.relname = 'Lead')
        AND NOT trigger_row.tgisinternal
      ORDER BY trigger_row.tgname
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

function claimInIndependentProcess(input: Readonly<{
  ordinal: number;
  databaseUrl: string;
  leadId: string;
  readyDirectory: string;
  releaseFile: string;
}>) {
  const script = `
    import { writeFileSync, existsSync } from 'node:fs';
    import { PrismaClient } from '@prisma/client';
    const commercialModule = await import('./src/lib/commercial-lead-inbox.ts');
    const claimCommercialLeadInboxItem = commercialModule.claimCommercialLeadInboxItem
      ?? commercialModule.default?.claimCommercialLeadInboxItem;
    if (typeof claimCommercialLeadInboxItem !== 'function') throw new Error('N14_CLAIM_EXPORT_UNAVAILABLE');
    writeFileSync(process.env.N14_READY_FILE, 'ready');
    while (!existsSync(process.env.N14_RELEASE_FILE)) await new Promise((resolve) => setTimeout(resolve, 5));
    const db = new PrismaClient();
    try {
      await claimCommercialLeadInboxItem(db, {
        leadId: process.env.N14_LEAD_ID,
        actor: { userId: process.env.N14_ACTOR_USER_ID, sessionId: process.env.N14_ACTOR_SESSION_ID },
        expectedInboxVersion: 1,
      });
      process.stdout.write('FULFILLED');
    } catch (error) {
      process.stdout.write('REJECTED:' + (error && typeof error === 'object' && 'code' in error ? error.code : 'CLOSED'));
    } finally { await db.$disconnect(); }
  `;
  return new Promise<string>((resolveResult, rejectResult) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_URL: input.databaseUrl,
        COMMERCIAL_LEAD_INBOX_MODE: 'enforced',
        INTERNAL_SESSION_MODE: 'registry',
        N14_READY_FILE: join(input.readyDirectory, String(input.ordinal)),
        N14_RELEASE_FILE: input.releaseFile,
        N14_LEAD_ID: input.leadId,
        N14_ACTOR_USER_ID: actor.userId,
        N14_ACTOR_SESSION_ID: actor.sessionId,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', rejectResult);
    child.once('exit', (code) => code === 0
      ? resolveResult(stdout)
      : rejectResult(new Error(`N14_CLAIM_CHILD_${code}:${stderr.slice(0, 200)}`)));
  });
}

test('N14 eight concurrent processes produce exactly one self-claim winner', {
  skip: !runDbTests,
  timeout: 120_000,
}, async () => {
  await ensureActorAndPolicy();
  const lead = await syntheticLead(2);
  await initializeCommercialLeadInboxItem(client(), {
    leadId: lead.id, actor, attribution: { originKind: 'MANUAL_CRM' }, reasonCode: 'MANUAL_INTAKE',
  });
  const processDirectory = mkdtempSync(join(tmpdir(), 'n14-process-claim-'));
  const readyDirectory = join(processDirectory, 'ready');
  const releaseFile = join(processDirectory, 'release');
  mkdirSync(readyDirectory);
  const url = new URL(process.env.DATABASE_URL!);
  url.searchParams.set('schema', schema);
  try {
    const attempts = Array.from({ length: 8 }, (_, ordinal) => claimInIndependentProcess({
      ordinal, databaseUrl: url.toString(), leadId: lead.id, readyDirectory, releaseFile,
    }));
    for (let wait = 0; wait < 800 && readdirSync(readyDirectory).length !== 8; wait += 1) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    assert.equal(readdirSync(readyDirectory).length, 8);
    writeFileSync(releaseFile, 'go');
    const results = await Promise.all(attempts);
    assert.equal(results.filter((result) => result === 'FULFILLED').length, 1);
    assert.equal(results.filter((result) => result === 'REJECTED:N14_VERSION_CONFLICT').length, 7);
  } finally {
    rmSync(processDirectory, { recursive: true, force: true });
  }
  assert.equal((await client().lead.findUniqueOrThrow({ where: { id: lead.id } })).assignedToId, actorUserId);
  assert.equal(await client().commercialLeadActivity.count({ where: { inboxItem: { leadId: lead.id }, activityType: 'CLAIMED' } }), 1);
});

test('N14 response, close and reopen races each produce one winner and one ledger row', {
  skip: !runDbTests,
}, async () => {
  await ensureActorAndPolicy();
  const lead = await syntheticLead(5);
  await initializeCommercialLeadInboxItem(client(), {
    leadId: lead.id, actor, attribution: { originKind: 'MANUAL_CRM' }, reasonCode: 'MANUAL_INTAKE',
  });
  await claimCommercialLeadInboxItem(client(), { leadId: lead.id, actor, expectedInboxVersion: 1 });
  const responses = await Promise.allSettled(Array.from({ length: 2 }, () =>
    recordCommercialLeadFirstResponse(client(), { leadId: lead.id, actor, expectedInboxVersion: 2 })));
  assert.equal(responses.filter(({ status }) => status === 'fulfilled').length, 1);
  const closes = await Promise.allSettled(Array.from({ length: 2 }, () =>
    closeCommercialLeadInboxItem(client(), {
      leadId: lead.id, actor, expectedInboxVersion: 3, reasonCode: 'LOST',
    })));
  assert.equal(closes.filter(({ status }) => status === 'fulfilled').length, 1);
  const reopens = await Promise.allSettled(Array.from({ length: 2 }, () =>
    reopenCommercialLeadInboxItem(client(), { leadId: lead.id, actor: manager, expectedInboxVersion: 4 })));
  assert.equal(reopens.filter(({ status }) => status === 'fulfilled').length, 1);
  const activities = await client().commercialLeadActivity.groupBy({
    by: ['activityType'], where: { inboxItem: { leadId: lead.id } }, _count: { _all: true },
  });
  const counts = new Map(activities.map((row) => [row.activityType, row._count._all]));
  assert.equal(counts.get('FIRST_RESPONSE_RECORDED'), 1);
  assert.equal(counts.get('CLOSED'), 1);
  assert.equal(counts.get('REOPENED'), 1);
  assert.equal((await client().commercialLeadInboxItem.findUniqueOrThrow({ where: { leadId: lead.id } })).version, 5);
});

test('N14 conversion is first-response gated, fault-atomic and single-winner', {
  skip: !runDbTests,
}, async () => {
  await ensureActorAndPolicy();
  const lead = await syntheticLead(6);
  await initializeCommercialLeadInboxItem(client(), {
    leadId: lead.id, actor, attribution: { originKind: 'MANUAL_CRM' }, reasonCode: 'MANUAL_INTAKE',
  });
  await claimCommercialLeadInboxItem(client(), { leadId: lead.id, actor, expectedInboxVersion: 1 });
  await assert.rejects(convertCommercialLeadInboxItem(client(), {
    leadId: lead.id, actor, expectedInboxVersion: 2, clientType: 'societa',
  }), (error: unknown) => error instanceof Error
    && (error as Error & { code?: unknown }).code === 'N14_FIRST_RESPONSE_REQUIRED');
  await recordCommercialLeadFirstResponse(client(), { leadId: lead.id, actor, expectedInboxVersion: 2 });
  await assert.rejects(convertCommercialLeadInboxItem(client(), {
    leadId: lead.id, actor, expectedInboxVersion: 3, clientType: 'societa', faultAt: 'AFTER_CLIENT',
  }), /N14_SYNTHETIC_FAULT_AFTER_CLIENT/u);
  assert.equal(await client().client.count({ where: { leadId: lead.id } }), 0);
  assert.equal((await client().lead.findUniqueOrThrow({ where: { id: lead.id } })).clientId, null);
  assert.equal((await client().commercialLeadInboxItem.findUniqueOrThrow({ where: { leadId: lead.id } })).state, 'OPEN');
  const attempts = await Promise.allSettled(Array.from({ length: 2 }, () =>
    convertCommercialLeadInboxItem(client(), {
      leadId: lead.id, actor, expectedInboxVersion: 3, clientType: 'societa',
    })));
  assert.equal(attempts.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal(await client().client.count({ where: { leadId: lead.id } }), 1);
  const [convertedLead, item, cycle, activity] = await Promise.all([
    client().lead.findUniqueOrThrow({ where: { id: lead.id } }),
    client().commercialLeadInboxItem.findUniqueOrThrow({ where: { leadId: lead.id } }),
    client().commercialLeadSlaCycle.findFirstOrThrow({ where: { inboxItem: { leadId: lead.id } } }),
    client().commercialLeadActivity.findFirstOrThrow({
      where: { inboxItem: { leadId: lead.id }, activityType: 'CLOSED' },
    }),
  ]);
  assert.ok(convertedLead.clientId);
  assert.equal(convertedLead.status, 'vinto');
  assert.equal(item.state, 'CLOSED');
  assert.ok(cycle.closedAt);
  assert.equal(activity.reasonCode, 'CONVERTED');
  const [cycleCountBefore, activityCountBefore] = await Promise.all([
    client().commercialLeadSlaCycle.count({ where: { inboxItemId: item.id } }),
    client().commercialLeadActivity.count({ where: { inboxItemId: item.id } }),
  ]);
  await assert.rejects(reopenCommercialLeadInboxItem(client(), {
    leadId: lead.id, actor: manager, expectedInboxVersion: item.version,
  }), (error: unknown) => error instanceof Error
    && (error as Error & { code?: unknown }).code === 'N14_LEAD_ALREADY_CONVERTED');
  const [rejectedLead, rejectedItem, cycleCountAfter, activityCountAfter] = await Promise.all([
    client().lead.findUniqueOrThrow({ where: { id: lead.id } }),
    client().commercialLeadInboxItem.findUniqueOrThrow({ where: { leadId: lead.id } }),
    client().commercialLeadSlaCycle.count({ where: { inboxItemId: item.id } }),
    client().commercialLeadActivity.count({ where: { inboxItemId: item.id } }),
  ]);
  assert.equal(rejectedLead.clientId, convertedLead.clientId);
  assert.equal(rejectedLead.status, 'vinto');
  assert.equal(rejectedItem.state, 'CLOSED');
  assert.equal(rejectedItem.version, item.version);
  assert.equal(cycleCountAfter, cycleCountBefore);
  assert.equal(activityCountAfter, activityCountBefore);
});

test('N14 SLA arithmetic remains absolute across Europe/Rome DST transitions', {
  skip: !runDbTests,
}, async () => {
  const rows = await client().$queryRaw<Array<{
    springAvailable: Date; springDue: Date; autumnAvailable: Date; autumnDue: Date;
  }>>`
    SELECT
      TIMESTAMPTZ '2026-03-29 00:30:00+00' AS "springAvailable",
      TIMESTAMPTZ '2026-03-29 00:30:00+00' + make_interval(secs => 7200) AS "springDue",
      TIMESTAMPTZ '2026-10-25 00:30:00+00' AS "autumnAvailable",
      TIMESTAMPTZ '2026-10-25 00:30:00+00' + make_interval(secs => 7200) AS "autumnDue"
  `;
  const row = rows[0]!;
  assert.equal(row.springDue.getTime() - row.springAvailable.getTime(), 7_200_000);
  assert.equal(row.autumnDue.getTime() - row.autumnAvailable.getTime(), 7_200_000);
  assert.equal(row.springDue.toISOString(), '2026-03-29T02:30:00.000Z');
  assert.equal(row.autumnDue.toISOString(), '2026-10-25T02:30:00.000Z');
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
  await assert.rejects(client().commercialLeadInboxItem.create({ data: {
    id: '00000000-0000-4000-8000-00000014ffff',
    leadId: lead.id,
    originKind: 'WEBSITE_LEGACY_N01',
    attributionVersion: 'n14-v1',
    sourceSystem: 'N01_DB_TEST',
    formCode: 'SYNTHETIC_LEAD',
    formVersion: 'n14-v1',
    sourceOccurredAt: new Date('2026-08-23T00:00:00.000Z'),
    privacyEvidenceReceiptId: '00000000-0000-4000-8000-00000014fffe',
    state: 'OPEN',
    version: 1,
    initializedAt: new Date('2026-08-23T00:00:00.000Z'),
  } }), /N14_WEBSITE_ATTRIBUTION_INVALID/u);
  await assert.rejects(client().commercialLeadInboxItem.create({ data: {
    id: '00000000-0000-4000-8000-00000014fffd',
    leadId: lead.id,
    originKind: 'BUSINESS_PROJECTION_N13',
    attributionVersion: 'n14-v1',
    sourceSystem: 'N13_DB_TEST',
    formCode: 'SYNTHETIC_LEAD',
    formVersion: 'n14-v1',
    sourceOccurredAt: new Date('2026-08-23T00:00:00.000Z'),
    projectionLedgerId: '00000000-0000-4000-8000-00000014fffc',
    state: 'OPEN',
    version: 1,
    initializedAt: new Date('2026-08-23T00:00:00.000Z'),
  } }), /N14_PROJECTION_ATTRIBUTION_INVALID/u);
  const activity = await client().commercialLeadActivity.findFirstOrThrow({ where: { inboxItemId: item.id } });
  await assert.rejects(client().commercialLeadActivity.update({ where: { id: activity.id }, data: { reasonCode: 'PROJECTED_NEW' } }), /N14_ACTIVITY_APPEND_ONLY/u);
});
