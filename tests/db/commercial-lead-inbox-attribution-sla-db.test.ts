import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { Prisma, PrismaClient } from '@prisma/client';
import { canonicalSha256 } from '../../src/lib/canonical-json';
import {
  assignCommercialLeadInboxItem,
  claimCommercialLeadInboxItem,
  closeCommercialLeadInboxItem,
  convertCommercialLeadInboxItem,
  initializeCommercialLeadInboxItem,
  recordCommercialLeadFirstResponse,
  reopenCommercialLeadInboxItem,
  unassignCommercialLeadInboxItem,
} from '../../src/lib/commercial-lead-inbox';
import { createWebsiteLeadPrivacyEvidence } from '../../src/lib/privacy-evidence';
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
const actorUserId = '00000000-0000-4000-8000-000000140010';
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

async function withN15SyntheticProfile<T>(action: () => Promise<T>) {
  const environment = process.env as Record<string, string | undefined>;
  const keys = ['APP_ENV', 'NODE_ENV', 'N15_SYNTHETIC_SELF_CLAIM_OPT_IN'] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, environment[key]]));
  environment.APP_ENV = 'test';
  environment.NODE_ENV = 'test';
  environment.N15_SYNTHETIC_SELF_CLAIM_OPT_IN = 'N15_SYNTHETIC_SELF_CLAIM_V1';
  try {
    return await action();
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete environment[key];
      else environment[key] = previous[key];
    }
  }
}

async function n15Counts() {
  return Promise.all([
    client().communicationIntentRecord.count(),
    client().communicationHeldDecision.count(),
    client().communicationIntentAudit.count(),
  ]);
}

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

test('current fresh44 catalog preserves N14 and contains zero policy, item, cycle or activity rows', {
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
  assert.equal(Number(migrationRows[0]?.count), 44);
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

test('N15 qualified synthetic profile composes one held aggregate from the real self-claim cause', {
  skip: !runDbTests,
}, async () => {
  await ensureActorAndPolicy();
  const lead = await syntheticLead(1502);
  const item = await initializeCommercialLeadInboxItem(client(), {
    leadId: lead.id,
    actor,
    attribution: { originKind: 'MANUAL_CRM' },
    reasonCode: 'MANUAL_INTAKE',
  });
  await withN15SyntheticProfile(async () => {
    const updated = await claimCommercialLeadInboxItem(client(), {
      leadId: lead.id, actor, expectedInboxVersion: 1,
    });
    const activity = await client().commercialLeadActivity.findFirstOrThrow({
      where: { inboxItemId: item.id, activityType: 'CLAIMED' },
    });
    const aggregate = await client().communicationIntentRecord.findUniqueOrThrow({
      where: { intentId: activity.id }, include: { heldDecision: true, auditRecord: true },
    });
    const envelope = JSON.parse(aggregate.canonicalEnvelope) as {
      businessCorrelationId: string;
      occurredAt: string;
      recipient: Record<string, string>;
      message: { reasonCode: string; body?: unknown };
    };
    assert.equal(updated.version, 2);
    assert.equal((await client().lead.findUniqueOrThrow({ where: { id: lead.id } })).assignedToId, actor.userId);
    assert.equal(aggregate.state, 'RECORDED');
    assert.equal(aggregate.heldDecision?.state, 'HELD');
    assert.ok(aggregate.auditRecord);
    assert.equal(envelope.businessCorrelationId, item.id);
    assert.equal(envelope.occurredAt, activity.createdAt.toISOString());
    assert.deepEqual(envelope.recipient, { authorityCode: 'CRM', entityType: 'USER', entityId: actor.userId });
    assert.equal(envelope.message.reasonCode, 'CRM_LEAD_SELF_CLAIM_SYNTHETIC');
    assert.equal('body' in envelope.message, false);
    assert.equal(await client().communicationIntentRecord.count({ where: { intentId: activity.id } }), 1);
  });
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

test('N15 admitted claim rolls back every N14/N15 row at faults before, within and after the aggregate', {
  skip: !runDbTests,
}, async () => {
  await ensureActorAndPolicy();
  for (const [ordinal, faultAt] of [
    [1510, 'AFTER_LEAD'], [1511, 'AFTER_AUDIT'], [1512, 'N15_AFTER_INTENT'],
    [1513, 'N15_AFTER_DECISION'], [1514, 'N15_AFTER_AGGREGATE'],
  ] as const) {
    const lead = await syntheticLead(ordinal);
    const item = await initializeCommercialLeadInboxItem(client(), {
      leadId: lead.id, actor, attribution: { originKind: 'MANUAL_CRM' }, reasonCode: 'MANUAL_INTAKE',
    });
    const before = await n15Counts();
    await withN15SyntheticProfile(async () => assert.rejects(claimCommercialLeadInboxItem(client(), {
      leadId: lead.id, actor, expectedInboxVersion: 1, faultAt,
    }), /N14_SYNTHETIC_FAULT/u));
    assert.equal((await client().lead.findUniqueOrThrow({ where: { id: lead.id } })).assignedToId, null);
    assert.equal((await client().commercialLeadInboxItem.findUniqueOrThrow({ where: { id: item.id } })).version, 1);
    assert.equal(await client().commercialLeadActivity.count({
      where: { inboxItemId: item.id, activityType: 'CLAIMED' },
    }), 0);
    assert.equal(await client().auditLog.count({
      where: { entityId: item.id, event: 'commercial_lead_inbox_claimed' },
    }), 0);
    assert.deepEqual(await n15Counts(), before);
  }
});

test('N15 admitted concurrent and repeated claims leave one committed cause and aggregate', {
  skip: !runDbTests,
}, async () => {
  await ensureActorAndPolicy();
  const lead = await syntheticLead(1515);
  const item = await initializeCommercialLeadInboxItem(client(), {
    leadId: lead.id, actor, attribution: { originKind: 'MANUAL_CRM' }, reasonCode: 'MANUAL_INTAKE',
  });
  const before = await n15Counts();
  await withN15SyntheticProfile(async () => {
    const results = await Promise.allSettled(Array.from({ length: 2 }, () =>
      claimCommercialLeadInboxItem(client(), { leadId: lead.id, actor, expectedInboxVersion: 1 })));
    assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
    await assert.rejects(claimCommercialLeadInboxItem(client(), {
      leadId: lead.id, actor, expectedInboxVersion: 1,
    }), (error: unknown) => error instanceof Error
      && (error as Error & { code?: unknown }).code === 'N14_VERSION_CONFLICT');
  });
  assert.equal(await client().commercialLeadActivity.count({
    where: { inboxItemId: item.id, activityType: 'CLAIMED' },
  }), 1);
  assert.deepEqual((await n15Counts()).map((count, index) => count - before[index]), [1, 1, 1]);
});

test('N15 admitted rejection paths preserve N14 state and create no aggregate', {
  skip: !runDbTests,
}, async () => {
  await ensureActorAndPolicy();
  const beforeN15 = await n15Counts();
  const expectedCode = (code: string) => (error: unknown) => error instanceof Error
    && (error as Error & { code?: unknown }).code === code;
  const snapshot = async (leadId: string, itemId: string) => Promise.all([
    client().lead.findUnique({ where: { id: leadId }, select: { assignedToId: true, deletedAt: true } }),
    client().commercialLeadInboxItem.findUnique({
      where: { id: itemId }, select: { state: true, version: true, closedAt: true },
    }),
    client().commercialLeadActivity.count({ where: { inboxItemId: itemId } }),
    client().auditLog.count({ where: { entityId: itemId } }),
  ]);
  const fixture = async (ordinal: number) => {
    const lead = await syntheticLead(ordinal);
    const item = await initializeCommercialLeadInboxItem(client(), {
      leadId: lead.id, actor, attribution: { originKind: 'MANUAL_CRM' }, reasonCode: 'MANUAL_INTAKE',
    });
    return { lead, item };
  };
  await withN15SyntheticProfile(async () => {
    for (const [ordinal, sessionData] of [
      [1516, { revokedAt: new Date('2098-01-01T00:00:00.000Z') }],
      [1517, {
        createdAt: new Date('2020-01-01T00:00:00.000Z'),
        expiresAt: new Date('2020-01-02T00:00:00.000Z'),
      }],
    ] as const) {
      const { lead, item } = await fixture(ordinal);
      const sessionBefore = await client().internalSession.findUniqueOrThrow({ where: { id: actor.sessionId } });
      await client().internalSession.update({ where: { id: actor.sessionId }, data: sessionData });
      const before = await snapshot(lead.id, item.id);
      try {
        await assert.rejects(claimCommercialLeadInboxItem(client(), {
          leadId: lead.id, actor, expectedInboxVersion: 1,
        }), expectedCode('N14_PERMISSION_DENIED'));
        assert.deepEqual(await snapshot(lead.id, item.id), before);
      } finally {
        await client().internalSession.update({ where: { id: actor.sessionId }, data: {
          createdAt: sessionBefore.createdAt,
          expiresAt: sessionBefore.expiresAt,
          revokedAt: sessionBefore.revokedAt,
        } });
      }
    }
    const wrongVersion = await fixture(1518);
    const wrongVersionBefore = await snapshot(wrongVersion.lead.id, wrongVersion.item.id);
    await assert.rejects(claimCommercialLeadInboxItem(client(), {
      leadId: wrongVersion.lead.id, actor, expectedInboxVersion: 99,
    }), expectedCode('N14_VERSION_CONFLICT'));
    assert.deepEqual(await snapshot(wrongVersion.lead.id, wrongVersion.item.id), wrongVersionBefore);

    const closed = await fixture(1529);
    await assignCommercialLeadInboxItem(client(), {
      leadId: closed.lead.id, actor: manager, targetUserId: actor.userId, expectedInboxVersion: 1,
    });
    await closeCommercialLeadInboxItem(client(), {
      leadId: closed.lead.id, actor, expectedInboxVersion: 2, reasonCode: 'LOST',
    });
    const closedBefore = await snapshot(closed.lead.id, closed.item.id);
    await assert.rejects(claimCommercialLeadInboxItem(client(), {
      leadId: closed.lead.id, actor, expectedInboxVersion: 3,
    }), expectedCode('N14_ITEM_NOT_OPEN'));
    assert.deepEqual(await snapshot(closed.lead.id, closed.item.id), closedBefore);

    const owned = await fixture(1530);
    await assignCommercialLeadInboxItem(client(), {
      leadId: owned.lead.id, actor: manager, targetUserId: actor.userId, expectedInboxVersion: 1,
    });
    const ownedBefore = await snapshot(owned.lead.id, owned.item.id);
    await assert.rejects(claimCommercialLeadInboxItem(client(), {
      leadId: owned.lead.id, actor, expectedInboxVersion: 2,
    }), expectedCode('N14_VERSION_CONFLICT'));
    assert.deepEqual(await snapshot(owned.lead.id, owned.item.id), ownedBefore);

    await assert.rejects(claimCommercialLeadInboxItem(client(), {
      leadId: 'n14-synthetic-lead-missing', actor, expectedInboxVersion: 1,
    }), expectedCode('N14_LEAD_NOT_FOUND'));
    const noItemLead = await syntheticLead(1527);
    await assert.rejects(claimCommercialLeadInboxItem(client(), {
      leadId: noItemLead.id, actor, expectedInboxVersion: 1,
    }), expectedCode('N14_ITEM_NOT_FOUND'));
    const deletedLead = await syntheticLead(1528);
    const deletedItem = await initializeCommercialLeadInboxItem(client(), {
      leadId: deletedLead.id, actor, attribution: { originKind: 'MANUAL_CRM' }, reasonCode: 'MANUAL_INTAKE',
    });
    await client().lead.update({ where: { id: deletedLead.id }, data: { deletedAt: new Date() } });
    const deletedBefore = await snapshot(deletedLead.id, deletedItem.id);
    await assert.rejects(claimCommercialLeadInboxItem(client(), {
      leadId: deletedLead.id, actor, expectedInboxVersion: 1,
    }), expectedCode('N14_LEAD_NOT_FOUND'));
    assert.deepEqual(await snapshot(deletedLead.id, deletedItem.id), deletedBefore);
    const deniedUserId = 'n14-synthetic-denied-user';
    const deniedSessionId = '00000000-0000-4000-8000-000000151800';
    await client().user.upsert({ where: { id: deniedUserId }, update: {}, create: {
      id: deniedUserId, email: 'denied@n14-db.invalid', name: 'Denied Synthetic User',
      passwordHash: 'synthetic-not-a-real-password-hash', role: 'consulente', active: true,
    } });
    await client().internalSession.upsert({ where: { id: deniedSessionId }, update: {}, create: {
      id: deniedSessionId, userId: deniedUserId, tokenDigest: Buffer.alloc(32, 18),
      expiresAt: new Date('2099-01-01T00:00:00.000Z'),
    } });
    const deniedLead = await syntheticLead(1524);
    await initializeCommercialLeadInboxItem(client(), {
      leadId: deniedLead.id, actor, attribution: { originKind: 'MANUAL_CRM' }, reasonCode: 'MANUAL_INTAKE',
    });
    await assert.rejects(claimCommercialLeadInboxItem(client(), {
      leadId: deniedLead.id, actor: { userId: deniedUserId, sessionId: deniedSessionId }, expectedInboxVersion: 1,
    }), expectedCode('N14_PERMISSION_DENIED'));
  });
  assert.deepEqual(await n15Counts(), beforeN15);
});

test('N15 stays absent for real claims with off/non-qualified gates and for assign/unassign', {
  skip: !runDbTests,
}, async () => {
  await ensureActorAndPolicy();
  const before = await n15Counts();
  const environment = process.env as Record<string, string | undefined>;
  const previous = { app: environment.APP_ENV, node: environment.NODE_ENV,
    optIn: environment.N15_SYNTHETIC_SELF_CLAIM_OPT_IN, inbox: environment.COMMERCIAL_LEAD_INBOX_MODE };
  try {
  for (const [ordinal, appEnvironment, optIn] of [
    [1519, 'test', undefined], [1520, 'production', 'N15_SYNTHETIC_SELF_CLAIM_V1'],
    [1521, 'staging', 'N15_SYNTHETIC_SELF_CLAIM_V1'], [1522, 'unknown', 'N15_SYNTHETIC_SELF_CLAIM_V1'],
  ] as const) {
    const lead = await syntheticLead(ordinal);
    await initializeCommercialLeadInboxItem(client(), {
      leadId: lead.id, actor, attribution: { originKind: 'MANUAL_CRM' }, reasonCode: 'MANUAL_INTAKE',
    });
    environment.APP_ENV = appEnvironment;
    environment.NODE_ENV = 'test';
    if (optIn === undefined) delete environment.N15_SYNTHETIC_SELF_CLAIM_OPT_IN;
    else environment.N15_SYNTHETIC_SELF_CLAIM_OPT_IN = optIn;
    await claimCommercialLeadInboxItem(client(), { leadId: lead.id, actor, expectedInboxVersion: 1 });
  }
  const assignedLead = await syntheticLead(1523);
  await initializeCommercialLeadInboxItem(client(), {
    leadId: assignedLead.id, actor, attribution: { originKind: 'MANUAL_CRM' }, reasonCode: 'MANUAL_INTAKE',
  });
  await withN15SyntheticProfile(async () => {
    const disabledLead = await syntheticLead(1526);
    environment.COMMERCIAL_LEAD_INBOX_MODE = 'disabled';
    try {
      await assert.rejects(claimCommercialLeadInboxItem(client(), {
        leadId: disabledLead.id, actor, expectedInboxVersion: 1,
      }), (error: unknown) => error instanceof Error
        && (error as Error & { code?: unknown }).code === 'N14_DISABLED');
    } finally {
      environment.COMMERCIAL_LEAD_INBOX_MODE = 'enforced';
    }
    await assignCommercialLeadInboxItem(client(), {
      leadId: assignedLead.id, actor: manager, targetUserId: actor.userId, expectedInboxVersion: 1,
    });
    await assert.rejects(claimCommercialLeadInboxItem(client(), {
      leadId: assignedLead.id, actor, expectedInboxVersion: 2,
    }));
    await unassignCommercialLeadInboxItem(client(), {
      leadId: assignedLead.id, actor: manager, expectedInboxVersion: 2,
    });
  });
  assert.deepEqual(await n15Counts(), before);
  } finally {
    for (const [key, value] of Object.entries({
      APP_ENV: previous.app, NODE_ENV: previous.node, N15_SYNTHETIC_SELF_CLAIM_OPT_IN: previous.optIn,
      COMMERCIAL_LEAD_INBOX_MODE: previous.inbox,
    })) {
      if (value === undefined) delete environment[key]; else environment[key] = value;
    }
  }
});

test('N15 requested profile rejects configuration and database identity before N14 mutation', {
  skip: !runDbTests,
}, async () => {
  await ensureActorAndPolicy();
  const environment = process.env as Record<string, string | undefined>;
  const lead = await syntheticLead(1525);
  const item = await initializeCommercialLeadInboxItem(client(), {
    leadId: lead.id, actor, attribution: { originKind: 'MANUAL_CRM' }, reasonCode: 'MANUAL_INTAKE',
  });
  const before = await n15Counts();
  await withN15SyntheticProfile(async () => {
    const databaseUrl = environment.DATABASE_URL;
    try {
      environment.DATABASE_URL = 'postgresql://remote.invalid/fai_crm_test';
      await assert.rejects(claimCommercialLeadInboxItem(client(), {
        leadId: lead.id, actor, expectedInboxVersion: 1,
      }), /N15_SYNTHETIC_DATABASE_CONFIGURATION_INVALID/u);
    } finally {
      environment.DATABASE_URL = databaseUrl;
    }
    await rootClient().$executeRawUnsafe(`COMMENT ON DATABASE "fai_crm_test" IS 'N15_INCOHERENT_SYNTHETIC_IDENTITY'`);
    try {
      await assert.rejects(claimCommercialLeadInboxItem(client(), {
        leadId: lead.id, actor, expectedInboxVersion: 1,
      }), /N15_SYNTHETIC_DATABASE_IDENTITY_INVALID/u);
    } finally {
      await rootClient().$executeRawUnsafe(`COMMENT ON DATABASE "fai_crm_test" IS 'FAI_CRM_EPHEMERAL_TEST_ONLY_V1'`);
    }
  });
  assert.equal((await client().lead.findUniqueOrThrow({ where: { id: lead.id } })).assignedToId, null);
  assert.equal((await client().commercialLeadInboxItem.findUniqueOrThrow({ where: { id: item.id } })).version, 1);
  assert.equal(await client().commercialLeadActivity.count({ where: { inboxItemId: item.id, activityType: 'CLAIMED' } }), 0);
  assert.deepEqual(await n15Counts(), before);
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
  assert.equal(names.length, 44);
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

test('N14 WEBSITE_LEGACY_N01 preserves maximum 120/120/80 provenance without duplicate enrollment', {
  skip: !runDbTests,
}, async () => {
  await ensureActorAndPolicy();
  const lead = await syntheticLead(7);
  const sourceSystem = 'S'.repeat(120);
  const formCode = 'F'.repeat(120);
  const formVersion = 'V'.repeat(80);
  const sourceSubmittedAt = new Date('2026-08-23T12:34:56.789Z');
  const privacyNoticeCode = 'N14_F2_WEBSITE_PRIVACY';
  const marketingNoticeCode = 'N14_F2_WEBSITE_MARKETING';
  const noticeVersion = 'n14-f2-v1';

  await client().privacyNoticeVersion.createMany({ data: [
    {
      noticeCode: privacyNoticeCode,
      noticeVersion,
      purposeCode: 'SERVICE_REQUEST_FOLLOW_UP',
      legalBasisCode: 'PRE_CONTRACTUAL_MEASURES',
      evidenceKind: 'NOTICE_ACKNOWLEDGEMENT',
      contentHash: canonicalSha256({ noticeCode: privacyNoticeCode, noticeVersion }),
    },
    {
      noticeCode: marketingNoticeCode,
      noticeVersion,
      purposeCode: 'DIRECT_MARKETING',
      legalBasisCode: 'CONSENT',
      evidenceKind: 'CONSENT',
      contentHash: canonicalSha256({ noticeCode: marketingNoticeCode, noticeVersion }),
    },
  ] });
  await client().privacyNoticeVersion.updateMany({
    where: {
      noticeCode: { in: [privacyNoticeCode, marketingNoticeCode] },
      status: 'DRAFT',
    },
    data: { status: 'ACTIVE', effectiveFrom: new Date('2026-01-01T00:00:00.000Z') },
  });

  const websiteReceipt = await client().websiteLeadReceipt.create({ data: {
    namespace: 'n14-f2-website-max-provenance',
    keyDigest: canonicalSha256({ domain: 'n14-f2-website-key', leadId: lead.id }),
    payloadHash: canonicalSha256({
      domain: 'n14-f2-website-payload',
      leadId: lead.id,
      sourceSystem,
      formCode,
      formVersion,
      sourceSubmittedAt: sourceSubmittedAt.toISOString(),
    }),
    status: 'pending',
  } });
  const evidence = await client().$transaction((tx) => createWebsiteLeadPrivacyEvidence(tx, {
    leadId: lead.id,
    websiteLeadReceiptId: websiteReceipt.id,
    sourceEvidenceDigest: websiteReceipt.payloadHash,
    sourceSystem,
    formCode,
    formVersion,
    sourceSubmittedAt,
    privacyAccepted: true,
    privacyNoticeCode,
    privacyNoticeVersion: noticeVersion,
    privacyPurposeCode: 'SERVICE_REQUEST_FOLLOW_UP',
    privacyLegalBasisCode: 'PRE_CONTRACTUAL_MEASURES',
    marketingAccepted: false,
    marketingNoticeCode,
    marketingNoticeVersion: noticeVersion,
    marketingPurposeCode: 'DIRECT_MARKETING',
    marketingLegalBasisCode: 'CONSENT',
  }));
  assert.equal(evidence.count, 2);
  const serviceReceipt = await client().privacyEvidenceReceipt.findUniqueOrThrow({
    where: { websiteLeadReceiptId_purposeCode: {
      websiteLeadReceiptId: websiteReceipt.id,
      purposeCode: 'SERVICE_REQUEST_FOLLOW_UP',
    } },
  });

  const item = await initializeCommercialLeadInboxItem(client(), {
    leadId: lead.id,
    actor,
    attribution: {
      originKind: 'WEBSITE_LEGACY_N01',
      privacyEvidenceReceiptId: serviceReceipt.id,
    },
    reasonCode: 'LEGACY_ENROLLMENT',
  });
  const [cycle, activity, audit] = await Promise.all([
    client().commercialLeadSlaCycle.findFirstOrThrow({ where: { inboxItemId: item.id } }),
    client().commercialLeadActivity.findFirstOrThrow({ where: { inboxItemId: item.id } }),
    client().auditLog.findFirstOrThrow({
      where: {
        entityType: 'CommercialLeadInboxItem',
        entityId: item.id,
        event: 'commercial_lead_inbox_initialized',
      },
    }),
  ]);
  assert.equal(item.originKind, 'WEBSITE_LEGACY_N01');
  assert.equal(item.sourceSystem, sourceSystem);
  assert.equal(item.formCode, formCode);
  assert.equal(item.formVersion, formVersion);
  assert.equal(item.sourceOccurredAt.toISOString(), sourceSubmittedAt.toISOString());
  assert.equal(item.privacyEvidenceReceiptId, serviceReceipt.id);
  assert.equal(item.projectionLedgerId, null);
  assert.equal(cycle.dueAt.getTime() - cycle.availableAt.getTime(), 3_600_000);
  assert.equal(activity.activityType, 'INITIALIZED');
  assert.equal(activity.actorKind, 'USER');
  assert.equal(activity.reasonCode, 'LEGACY_ENROLLMENT');
  assert.equal(audit.actorId, actor.userId);

  await assert.rejects(initializeCommercialLeadInboxItem(client(), {
    leadId: lead.id,
    actor,
    attribution: {
      originKind: 'WEBSITE_LEGACY_N01',
      privacyEvidenceReceiptId: serviceReceipt.id,
    },
    reasonCode: 'LEGACY_ENROLLMENT',
  }), (error: unknown) => error instanceof Error
    && (error as Error & { code?: unknown }).code === 'N14_ITEM_ALREADY_EXISTS');
  const [itemCount, cycleCount, activityCount, auditCount, evidenceCount] = await Promise.all([
    client().commercialLeadInboxItem.count({ where: { leadId: lead.id } }),
    client().commercialLeadSlaCycle.count({ where: { inboxItemId: item.id } }),
    client().commercialLeadActivity.count({ where: { inboxItemId: item.id } }),
    client().auditLog.count({ where: {
      entityType: 'CommercialLeadInboxItem',
      entityId: item.id,
      event: 'commercial_lead_inbox_initialized',
    } }),
    client().privacyEvidenceReceipt.count({ where: { websiteLeadReceiptId: websiteReceipt.id } }),
  ]);
  assert.deepEqual(
    { itemCount, cycleCount, activityCount, auditCount, evidenceCount },
    { itemCount: 1, cycleCount: 1, activityCount: 1, auditCount: 1, evidenceCount: 2 },
  );
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
  await claimCommercialLeadInboxItem(client(), { leadId: lead.id, actor, expectedInboxVersion: 1 });
  await closeCommercialLeadInboxItem(client(), {
    leadId: lead.id, actor, expectedInboxVersion: 2, reasonCode: 'QUALIFIED_OUT',
  });
  assert.equal((await client().lead.findUniqueOrThrow({ where: { id: lead.id } })).status, 'non_qualificato');
  await assert.rejects(client().lead.update({
    where: { id: lead.id }, data: { status: 'da_contattare' },
  }), /N14_LEAD_WRITER_BYPASS/u);
});
