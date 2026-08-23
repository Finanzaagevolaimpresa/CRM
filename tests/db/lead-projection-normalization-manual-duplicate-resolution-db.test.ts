import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { Prisma, PrismaClient, type RoleCode } from '@prisma/client';
import {
  admitBusinessInboxEvent,
  BusinessEventBackboneError,
  claimBusinessQueueEvent,
  type BusinessQueueLease,
} from '../../src/lib/business-event-backbone';
import {
  calculateLeadIdentityKeyDigest,
  digestLeadIdentitySignals,
  discoverLeadIdentityCandidates,
  hasStrongRawLeadIdentityDuplicate,
  LEAD_NORMALIZATION_VERSION,
  normalizeLeadIdentitySignals,
} from '../../src/lib/lead-identity';
import {
  LeadDuplicateResolutionError,
  resolveLeadDuplicateCase,
} from '../../src/lib/lead-duplicate-resolution';
import {
  LeadProjectionError,
  projectClaimedLeadInboxEvent,
  type LeadProjectionFaultPoint,
} from '../../src/lib/lead-projection';
import {
  createLeadSubmittedEventV1,
  type LeadEventPayloadV1,
} from '../../src/lib/lead-event-contract';
import { createBusinessLeadPrivacyEvidence } from '../../src/lib/privacy-evidence';
import {
  N13_SYNTHETIC_KEY_SECRET,
  N13_SYNTHETIC_KEY_VERSION,
} from '../fixtures/n13-lead-projection-v1';
import { syntheticLeadEventInputV1 } from '../fixtures/n10-lead-event-v1';
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
const rootDb = runDbTests ? new PrismaClient() : null;
const execFileAsync = promisify(execFile);
const migrationName = '20260821160000_lead_projection_normalization_manual_duplicate_resolution_v1';
const migrationPath = `prisma/migrations/${migrationName}/migration.sql`;
const correctiveMigrationName = '20260822150000_n13_c2_nfc_utc_corrective_v1';
const correctiveMigrationPath = `prisma/migrations/${correctiveMigrationName}/migration.sql`;
const migration40Sha256 = '234f574703ec81f7ab0b43c0854a1dab3264c8462e6ccb1f0d0b92f288415c78';
const suiteSchema = `n13_contract_${process.pid}`;
const originalSessionMode = process.env.INTERNAL_SESSION_MODE;

let schemaUrl = '';
let db: PrismaClient | null = null;
let secretRoot = '';
let secretPath = '';
let primaryUserId = '';
let primarySessionId = '';

function rootClient() {
  if (!rootDb) throw new Error('N13_ROOT_DB_UNAVAILABLE');
  return rootDb;
}

function client() {
  if (!db) throw new Error('N13_SCHEMA_DB_UNAVAILABLE');
  return db;
}

function uuid(ordinal: number) {
  return `00000000-0000-4000-8000-${ordinal.toString().padStart(12, '0')}`;
}

function deploy(databaseUrl: string, schemaPath = 'prisma/schema.prisma') {
  execFileSync(
    resolve('node_modules/.bin/prisma'),
    ['migrate', 'deploy', '--schema', schemaPath],
    {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
      timeout: 180_000,
    },
  );
}

function syntheticEvent(
  ordinal: number,
  payload: Partial<LeadEventPayloadV1> = {},
  occurredAt?: string,
) {
  const base = syntheticLeadEventInputV1();
  const ordinalText = ordinal.toString().padStart(6, '0');
  return createLeadSubmittedEventV1({
    ...base,
    eventId: uuid(130_000 + ordinal * 2),
    businessCorrelationId: uuid(130_001 + ordinal * 2),
    occurredAt: occurredAt ?? base.occurredAt,
    source: {
      ...base.source,
      formCode: 'N13_DB_SYNTHETIC_FORM',
      submissionId: `N13-DB-${ordinalText}`,
    },
    payload: {
      ...base.payload,
      firstName: `Synthetic${ordinalText}`,
      lastName: `Lead${ordinalText}`,
      companyName: `Synthetic Company ${ordinalText}`,
      email: `synthetic-${ordinalText}@n13-db.invalid`,
      phone: `+390000${ordinalText}`,
      message: `Synthetic-only N13 database event ${ordinalText}.`,
      ...payload,
    },
  });
}

async function seedSyntheticPrivacyNotices(database: PrismaClient) {
  await database.privacyNoticeVersion.createMany({
    data: [
      {
        noticeCode: 'SYNTHETIC_PRIVACY_NOTICE',
        noticeVersion: 'v1',
        purposeCode: 'SERVICE_REQUEST_FOLLOW_UP',
        legalBasisCode: 'PRE_CONTRACTUAL_MEASURES',
        evidenceKind: 'NOTICE_ACKNOWLEDGEMENT',
        contentHash: '1'.repeat(64),
      },
      {
        noticeCode: 'SYNTHETIC_MARKETING_NOTICE',
        noticeVersion: 'v1',
        purposeCode: 'DIRECT_MARKETING',
        legalBasisCode: 'CONSENT',
        evidenceKind: 'CONSENT',
        contentHash: '2'.repeat(64),
      },
    ],
  });
  await database.privacyNoticeVersion.updateMany({
    where: { status: 'DRAFT' },
    data: {
      status: 'ACTIVE',
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
    },
  });
}

async function createSession(role: RoleCode, ordinal: number) {
  const user = await client().user.create({
    data: {
      email: `synthetic-${role}-${ordinal}@n13-db.invalid`,
      name: `Synthetic N13 ${role} ${ordinal}`,
      passwordHash: 'synthetic-not-a-real-password-hash',
      role,
      active: true,
    },
  });
  const session = await client().internalSession.create({
    data: {
      id: uuid(180_000 + ordinal),
      userId: user.id,
      tokenDigest: Buffer.alloc(32, ordinal % 255 || 1),
      expiresAt: new Date('2099-01-01T00:00:00.000Z'),
    },
  });
  return { userId: user.id, sessionId: session.id };
}

async function admitAndClaim(ordinal: number, payload: Partial<LeadEventPayloadV1> = {}) {
  const event = syntheticEvent(ordinal, payload);
  const admitted = await admitBusinessInboxEvent(client(), event);
  const lease = await claimBusinessQueueEvent(client(), {
    queueKind: 'INBOX',
    leaseOwnerId: uuid(160_000 + ordinal),
  });
  assert.ok(lease);
  assert.equal(lease.eventRowId, admitted.inboxEventId);
  return { event, admitted, lease };
}

function projectionOptions() {
  return { keyFilePath: secretPath, allowedSecretRoot: secretRoot } as const;
}

function resolutionActor(actor = { userId: primaryUserId, sessionId: primarySessionId }) {
  return {
    actorUserId: actor.userId,
    actorSessionId: actor.sessionId,
  } as const;
}

async function createReviewCase(ordinal: number, candidateCount = 1) {
  const event = syntheticEvent(ordinal);
  const email = event.payload.email!;
  const candidates = await Promise.all(Array.from({ length: candidateCount }, (_, index) => (
    client().lead.create({
      data: {
        firstName: `Existing${index}`,
        lastName: `Candidate${ordinal}`,
        email,
        source: 'N13_DB_SYNTHETIC_CANDIDATE',
      },
    })
  )));
  const admitted = await admitBusinessInboxEvent(client(), event);
  const lease = await claimBusinessQueueEvent(client(), {
    queueKind: 'INBOX',
    leaseOwnerId: uuid(160_000 + ordinal),
  });
  assert.ok(lease);
  assert.equal(lease.eventRowId, admitted.inboxEventId);
  const projected = await projectClaimedLeadInboxEvent(client(), lease, projectionOptions());
  assert.equal(projected.result.state, 'REVIEW_REQUIRED');
  const duplicateCase = await client().leadDuplicateCase.findUniqueOrThrow({
    where: { projectionLedgerId: projected.result.ledgerId },
  });
  return { event, lease, projected, duplicateCase, candidates };
}

async function forceAvailableNow(eventRowId: string) {
  await client().$executeRawUnsafe(
    'ALTER TABLE "BusinessInboxEvent" DISABLE TRIGGER "BusinessInboxEvent_guard_v1"',
  );
  try {
    await client().$executeRaw(Prisma.sql`
      UPDATE "BusinessInboxEvent"
      SET "availableAt" = clock_timestamp() - interval '1 second'
      WHERE "id" = ${eventRowId}::UUID
    `);
  } finally {
    await client().$executeRawUnsafe(
      'ALTER TABLE "BusinessInboxEvent" ENABLE TRIGGER "BusinessInboxEvent_guard_v1"',
    );
  }
}

function serializableLease(lease: BusinessQueueLease) {
  return {
    queueKind: lease.queueKind,
    eventRowId: lease.eventRowId,
    attemptId: lease.attemptId,
    fencingToken: lease.fencingToken.toString(),
    leaseOwnerId: lease.leaseOwnerId,
    leaseToken: lease.leaseToken,
  };
}

function encodedFixtureInput(input: unknown) {
  return Buffer.from(JSON.stringify(input), 'utf8').toString('base64url');
}

async function runFixture(operation: 'project' | 'resolve' | 'manual-create', input: unknown) {
  const fixture = resolve(
    'tests/db/lead-projection-normalization-manual-duplicate-resolution-multiprocess-fixture.ts',
  );
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--import', 'tsx', fixture, operation, encodedFixtureInput(input)],
    {
      env: {
        ...process.env,
        INTERNAL_SESSION_MODE: 'registry',
        N13_DB_TEST_SCHEMA_URL: schemaUrl,
      },
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    },
  );
  return JSON.parse(stdout) as { outcome: string };
}

function aggregateOutcomes(results: readonly { outcome: string }[]) {
  const aggregate: Record<string, number> = {};
  for (const { outcome } of results) aggregate[outcome] = (aggregate[outcome] ?? 0) + 1;
  return aggregate;
}

test.before(async () => {
  if (!runDbTests) return;
  await assertAiOrchestratorEphemeralDatabaseIdentity(rootClient());
  const url = new URL(process.env.DATABASE_URL!);
  url.searchParams.set('schema', suiteSchema);
  schemaUrl = url.toString();
  await rootClient().$executeRawUnsafe(`CREATE SCHEMA "${suiteSchema}"`);
  deploy(schemaUrl);
  db = new PrismaClient({ datasources: { db: { url: schemaUrl } } });
  process.env.INTERNAL_SESSION_MODE = 'registry';
  secretRoot = mkdtempSync(join(tmpdir(), 'n13-db-identity-'));
  secretPath = join(secretRoot, 'synthetic-lead-identity.json');
  writeFileSync(secretPath, JSON.stringify({
    version: N13_SYNTHETIC_KEY_VERSION,
    secretBase64: N13_SYNTHETIC_KEY_SECRET.toString('base64'),
  }), { mode: 0o600 });

  await seedSyntheticPrivacyNotices(client());
  const actor = await createSession('admin', 1);
  primaryUserId = actor.userId;
  primarySessionId = actor.sessionId;
  const keyVersion = await client().leadIdentityKeyVersion.create({
    data: {
      normalizationVersion: LEAD_NORMALIZATION_VERSION,
      version: N13_SYNTHETIC_KEY_VERSION,
      keyDigest: calculateLeadIdentityKeyDigest(N13_SYNTHETIC_KEY_SECRET),
      createdById: primaryUserId,
    },
  });
  await client().leadIdentityKeyVersion.update({
    where: { id: keyVersion.id },
    data: { status: 'ACTIVE', activatedAt: new Date() },
  });
});

test.after(async () => {
  if (originalSessionMode === undefined) delete process.env.INTERNAL_SESSION_MODE;
  else process.env.INTERNAL_SESSION_MODE = originalSessionMode;
  await db?.$disconnect();
  if (runDbTests) {
    await assertAiOrchestratorEphemeralDatabaseIdentity(rootClient());
    await rootClient().$executeRawUnsafe(`DROP SCHEMA "${suiteSchema}" CASCADE`);
  }
  await rootDb?.$disconnect();
  if (secretRoot) rmSync(secretRoot, { recursive: true, force: true });
});

test('N13 migration 40 source is one additive, empty and activation-free transaction', () => {
  const sql = readFileSync(migrationPath, 'utf8');
  const executableSql = sql.replace(/^--.*$/gmu, '');
  assert.equal((sql.match(/^BEGIN;$/gmu) ?? []).length, 1);
  assert.equal((sql.match(/^COMMIT;$/gmu) ?? []).length, 1);
  assert.doesNotMatch(executableSql, /\b(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?"Lead"/iu);
  assert.doesNotMatch(executableSql, /\b(?:seed|backfill|feature[_ ]?gate|activation|consumer)\b/iu);
  assert.match(sql, /CREATE TABLE "LeadIdentityKeyVersion"/u);
  assert.match(sql, /ALTER TABLE "PrivacyEvidenceReceipt"/u);
  assert.match(sql, /NULLS NOT DISTINCT/u);
  assert.equal(createHash('sha256').update(sql).digest('hex'), migration40Sha256);
});

test('N13-C2 migration 41 aligns timestamptz fail-closed and uses one UTC canonicalization', () => {
  const sql = readFileSync(correctiveMigrationPath, 'utf8');
  const executableSql = sql.replace(/^--.*$/gmu, '');
  const receiptLock = 'LOCK TABLE ONLY "PrivacyEvidenceReceipt" IN ACCESS EXCLUSIVE MODE;';
  assert.equal((sql.match(/^BEGIN;$/gmu) ?? []).length, 1);
  assert.equal((sql.match(/^COMMIT;$/gmu) ?? []).length, 1);
  assert.equal((sql.match(/^LOCK TABLE ONLY "PrivacyEvidenceReceipt" IN ACCESS EXCLUSIVE MODE;$/gmu) ?? []).length, 1);
  assert.ok(sql.indexOf(receiptLock) < sql.indexOf('N13_C2_SOURCE_TIMESTAMP_TYPE_DRIFT'));
  assert.ok(sql.indexOf(receiptLock) < sql.indexOf('N13_C2_SOURCE_TIMESTAMP_ROWS_PRESENT'));
  assert.ok(sql.indexOf(receiptLock) < sql.indexOf('ALTER TABLE "PrivacyEvidenceReceipt"'));
  assert.equal((sql.match(/AT TIME ZONE 'UTC'/gu) ?? []).length, 2);
  assert.equal((sql.match(/ALTER COLUMN "sourceSubmittedAt" TYPE TIMESTAMPTZ\(3\)/gu) ?? []).length, 1);
  assert.equal((sql.match(/source_submitted_at_utc := NEW\."sourceSubmittedAt" AT TIME ZONE 'UTC'/gu) ?? []).length, 1);
  assert.equal((sql.match(/TO_CHAR\(\s*source_submitted_at_utc/gu) ?? []).length, 3);
  assert.doesNotMatch(sql, /TO_CHAR\(\s*NEW\."sourceSubmittedAt"/u);
  assert.doesNotMatch(sql, /notice_row\."(?:effectiveFrom|retiredAt)"[^\n]*NEW\."sourceSubmittedAt"/u);
  assert.match(sql, /N13_C2_SOURCE_TIMESTAMP_TYPE_DRIFT/u);
  assert.match(sql, /N13_C2_SOURCE_TIMESTAMP_ROWS_PRESENT/u);
  assert.match(sql, /N13_C2_SOURCE_TIMESTAMP_POSTCONDITION_FAILED/u);
  assert.equal((sql.match(/^CREATE INDEX "Lead_active_.*_n13_nfc_idx"/gmu) ?? []).length, 3);
  assert.match(sql, /CREATE OR REPLACE FUNCTION "privacy_evidence_receipt_validate_v1"/u);
  assert.doesNotMatch(executableSql, /\b(?:DROP|TRUNCATE|INSERT|UPDATE|DELETE)\b/iu);
  assert.doesNotMatch(executableSql, /\b(?:seed|backfill|activation|consumer|worker)\b/iu);
});

async function qualifyMigration(upgrade: boolean) {
  await assertAiOrchestratorEphemeralDatabaseIdentity(rootClient());
  const qualificationSchema = `n13_${upgrade ? 'upgrade' : 'fresh'}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const root = mkdtempSync(join(tmpdir(), 'n13-migrations-'));
  const prismaDir = join(root, 'prisma');
  const migrationsDir = join(prismaDir, 'migrations');
  mkdirSync(migrationsDir, { recursive: true });
  cpSync('prisma/schema.prisma', join(prismaDir, 'schema.prisma'));
  const allNames = readdirSync('prisma/migrations').filter((name) => /^\d/u.test(name)).sort();
  assert.equal(allNames.length, 41);
  const names = allNames.slice(0, 40);
  assert.equal(names[39], migrationName);
  const url = new URL(process.env.DATABASE_URL!);
  url.searchParams.set('schema', qualificationSchema);
  await rootClient().$executeRawUnsafe(`CREATE SCHEMA "${qualificationSchema}"`);
  try {
    for (const name of upgrade ? names.slice(0, 39) : names) {
      cpSync(join('prisma/migrations', name), join(migrationsDir, name), { recursive: true });
    }
    deploy(url.toString(), join(prismaDir, 'schema.prisma'));
    let historicalLeadId: string | null = null;
    const historicalKeyId = uuid(199_001);
    if (upgrade) {
      const before = new PrismaClient({ datasources: { db: { url: url.toString() } } });
      try {
        historicalLeadId = (await before.lead.create({
          data: {
            firstName: 'Historical',
            lastName: 'N12',
            email: 'historical@n13-upgrade.invalid',
          },
        })).id;
        await before.secureLeadGatewayKeyVersion.create({
          data: {
            id: historicalKeyId,
            producerCode: 'N13_HISTORICAL_N12',
            keyId: 'n13-historical-n12-key',
            version: 1,
            secretDigest: '3'.repeat(64),
            acceptFrom: new Date('2026-01-01T00:00:00.000Z'),
          },
        });
      } finally {
        await before.$disconnect();
      }
      cpSync(join('prisma/migrations', migrationName), join(migrationsDir, migrationName), {
        recursive: true,
      });
      deploy(url.toString(), join(prismaDir, 'schema.prisma'));
    }
    const qualification = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    try {
      const [migrations, tables, n13Rows, migrationRow, historical] = await Promise.all([
        qualification.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
          SELECT COUNT(*)::BIGINT AS "count" FROM "_prisma_migrations"
          WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
        `),
        qualification.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
          SELECT COUNT(*)::BIGINT AS "count" FROM information_schema.tables
          WHERE table_schema = ${qualificationSchema}
            AND table_name IN (
              'LeadIdentityKeyVersion', 'LeadIdentityKey', 'LeadProjectionLedger',
              'LeadDuplicateCase', 'LeadDuplicateCandidate', 'LeadDuplicateDecision'
            )
        `),
        qualification.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
          SELECT (
            (SELECT COUNT(*) FROM "LeadIdentityKeyVersion")
            + (SELECT COUNT(*) FROM "LeadIdentityKey")
            + (SELECT COUNT(*) FROM "LeadProjectionLedger")
            + (SELECT COUNT(*) FROM "LeadDuplicateCase")
            + (SELECT COUNT(*) FROM "LeadDuplicateCandidate")
            + (SELECT COUNT(*) FROM "LeadDuplicateDecision")
          )::BIGINT AS "count"
        `),
        qualification.$queryRaw<Array<{ checksum: string }>>(Prisma.sql`
          SELECT checksum FROM "_prisma_migrations" WHERE migration_name = ${migrationName}
        `),
        qualification.$queryRaw<Array<{ leads: bigint; keys: bigint }>>(Prisma.sql`
          SELECT
            (SELECT COUNT(*) FROM "Lead" WHERE "id" = ${historicalLeadId})::BIGINT AS "leads",
            (SELECT COUNT(*) FROM "SecureLeadGatewayKeyVersion"
              WHERE "id" = ${upgrade ? historicalKeyId : null}::UUID)::BIGINT AS "keys"
        `),
      ]);
      return {
        migrations: Number(migrations[0]?.count),
        tables: Number(tables[0]?.count),
        n13Rows: Number(n13Rows[0]?.count),
        checksum: migrationRow[0]?.checksum,
        historicalLeads: Number(historical[0]?.leads),
        historicalN12Keys: Number(historical[0]?.keys),
      };
    } finally {
      await qualification.$disconnect();
    }
  } finally {
    await rootClient().$executeRawUnsafe(`DROP SCHEMA "${qualificationSchema}" CASCADE`);
    rmSync(root, { recursive: true, force: true });
  }
}

test('N13 migration qualifies fresh 40 and exact additive 39 to 40 upgrade', {
  skip: !runDbTests,
  timeout: 360_000,
}, async () => {
  const checksum = createHash('sha256').update(readFileSync(migrationPath)).digest('hex');
  assert.deepEqual(await qualifyMigration(false), {
    migrations: 40,
    tables: 6,
    n13Rows: 0,
    checksum,
    historicalLeads: 0,
    historicalN12Keys: 0,
  });
  assert.deepEqual(await qualifyMigration(true), {
    migrations: 40,
    tables: 6,
    n13Rows: 0,
    checksum,
    historicalLeads: 1,
    historicalN12Keys: 1,
  });
});

async function qualifyCorrectiveMigration(upgrade: boolean) {
  await assertAiOrchestratorEphemeralDatabaseIdentity(rootClient());
  const qualificationSchema = `n13_c2_${upgrade ? 'upgrade' : 'fresh'}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const root = mkdtempSync(join(tmpdir(), 'n13-c2-migrations-'));
  const prismaDir = join(root, 'prisma');
  const migrationsDir = join(prismaDir, 'migrations');
  mkdirSync(migrationsDir, { recursive: true });
  cpSync('prisma/schema.prisma', join(prismaDir, 'schema.prisma'));
  const names = readdirSync('prisma/migrations').filter((name) => /^\d/u.test(name)).sort();
  assert.equal(names.length, 41);
  assert.equal(names[39], migrationName);
  assert.equal(names[40], correctiveMigrationName);
  const url = new URL(process.env.DATABASE_URL!);
  url.searchParams.set('schema', qualificationSchema);
  await rootClient().$executeRawUnsafe(`CREATE SCHEMA "${qualificationSchema}"`);
  let historicalLeadId: string | null = null;
  try {
    for (const name of upgrade ? names.slice(0, 40) : names) {
      cpSync(join('prisma/migrations', name), join(migrationsDir, name), { recursive: true });
    }
    deploy(url.toString(), join(prismaDir, 'schema.prisma'));
    if (upgrade) {
      const before = new PrismaClient({ datasources: { db: { url: url.toString() } } });
      try {
        historicalLeadId = (await before.lead.create({
          data: {
            firstName: 'Jose\u0301',
            lastName: 'N13-C2',
            companyName: 'Cafe\u0301 Synthetic',
            email: 'u\u0308pgrade@n13-c2.invalid',
            source: 'N13_C2_UPGRADE_SENTINEL',
          },
        })).id;
      } finally {
        await before.$disconnect();
      }
      cpSync(
        join('prisma/migrations', correctiveMigrationName),
        join(migrationsDir, correctiveMigrationName),
        { recursive: true },
      );
      deploy(url.toString(), join(prismaDir, 'schema.prisma'));
    }
    const qualification = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    try {
      const [
        migrations,
        migrationRow,
        indexes,
        functionRows,
        triggerRows,
        encodingRows,
        sourceColumnRows,
        historical,
      ] = await Promise.all([
        qualification.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
          SELECT COUNT(*)::BIGINT AS "count" FROM "_prisma_migrations"
          WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
        `),
        qualification.$queryRaw<Array<{ checksum: string }>>(Prisma.sql`
          SELECT checksum FROM "_prisma_migrations" WHERE migration_name = ${correctiveMigrationName}
        `),
        qualification.$queryRaw<Array<{ name: string; definition: string }>>(Prisma.sql`
          SELECT indexname AS "name", indexdef AS "definition" FROM pg_indexes
          WHERE schemaname = ${qualificationSchema}
            AND indexname IN (
              'Lead_active_email_n13_nfc_idx',
              'Lead_active_person_name_n13_nfc_idx',
              'Lead_active_company_name_n13_nfc_idx'
            ) ORDER BY indexname
        `),
        qualification.$queryRaw<Array<{ definition: string }>>(Prisma.sql`
          SELECT pg_get_functiondef(function_row.oid) AS "definition"
          FROM pg_proc function_row
          JOIN pg_namespace namespace_row ON namespace_row.oid = function_row.pronamespace
          WHERE namespace_row.nspname = ${qualificationSchema}
            AND function_row.proname = 'privacy_evidence_receipt_validate_v1'
        `),
        qualification.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
          SELECT COUNT(*)::BIGINT AS "count"
          FROM pg_trigger trigger_row
          JOIN pg_class table_row ON table_row.oid = trigger_row.tgrelid
          JOIN pg_proc function_row ON function_row.oid = trigger_row.tgfoid
          WHERE table_row.relnamespace = ${qualificationSchema}::regnamespace
            AND trigger_row.tgname = 'PrivacyEvidenceReceipt_validate_v1'
            AND function_row.proname = 'privacy_evidence_receipt_validate_v1'
        `),
        qualification.$queryRawUnsafe<Array<{ server_encoding: string }>>('SHOW server_encoding'),
        qualification.$queryRaw<Array<{
          data_type: string;
          datetime_precision: number;
          is_nullable: string;
        }>>(Prisma.sql`
          SELECT data_type, datetime_precision, is_nullable
          FROM information_schema.columns
          WHERE table_schema = ${qualificationSchema}
            AND table_name = 'PrivacyEvidenceReceipt'
            AND column_name = 'sourceSubmittedAt'
        `),
        qualification.$queryRaw<Array<{ leads: bigint }>>(Prisma.sql`
          SELECT COUNT(*)::BIGINT AS "leads" FROM "Lead" WHERE "id" = ${historicalLeadId}
        `),
      ]);
      const functionDefinition = functionRows[0]?.definition ?? '';
      return {
        migrations: Number(migrations[0]?.count),
        checksum: migrationRow[0]?.checksum,
        indexes: indexes.map(({ name }) => name),
        allIndexesUseNfc: indexes.every(({ definition }) => /normalize\(/iu.test(definition)),
        utcConversions: (functionDefinition.match(/AT TIME ZONE 'UTC'/gu) ?? []).length,
        utcRenderings: (functionDefinition.match(/TO_CHAR\(\s*source_submitted_at_utc/giu) ?? []).length,
        directSourceReferences: (functionDefinition.match(/NEW\."sourceSubmittedAt"/gu) ?? []).length,
        triggerBindings: Number(triggerRows[0]?.count),
        serverEncoding: encodingRows[0]?.server_encoding,
        sourceColumn: sourceColumnRows[0],
        historicalLeads: Number(historical[0]?.leads),
      };
    } finally {
      await qualification.$disconnect();
    }
  } finally {
    await rootClient().$executeRawUnsafe(`DROP SCHEMA "${qualificationSchema}" CASCADE`);
    rmSync(root, { recursive: true, force: true });
  }
}

test('N13-C2 qualifies fresh 41 and exact business-preserving 40 to 41 upgrade', {
  skip: !runDbTests,
  timeout: 360_000,
}, async () => {
  const checksum = createHash('sha256').update(readFileSync(correctiveMigrationPath)).digest('hex');
  const expectedCatalog = {
    migrations: 41,
    checksum,
    indexes: [
      'Lead_active_company_name_n13_nfc_idx',
      'Lead_active_email_n13_nfc_idx',
      'Lead_active_person_name_n13_nfc_idx',
    ],
    allIndexesUseNfc: true,
    utcConversions: 1,
    utcRenderings: 3,
    directSourceReferences: 1,
    triggerBindings: 1,
    serverEncoding: 'UTF8',
    sourceColumn: {
      data_type: 'timestamp with time zone',
      datetime_precision: 3,
      is_nullable: 'NO',
    },
  };
  assert.deepEqual(await qualifyCorrectiveMigration(false), {
    ...expectedCatalog,
    historicalLeads: 0,
  });
  assert.deepEqual(await qualifyCorrectiveMigration(true), {
    ...expectedCatalog,
    historicalLeads: 1,
  });
});

async function qualifyCorrectiveExistingRowsFailClosed() {
  await assertAiOrchestratorEphemeralDatabaseIdentity(rootClient());
  const qualificationSchema = `n13_c2_rows_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const root = mkdtempSync(join(tmpdir(), 'n13-c2-existing-rows-'));
  const prismaDir = join(root, 'prisma');
  const migrationsDir = join(prismaDir, 'migrations');
  mkdirSync(migrationsDir, { recursive: true });
  cpSync('prisma/schema.prisma', join(prismaDir, 'schema.prisma'));
  const names = readdirSync('prisma/migrations').filter((name) => /^\d/u.test(name)).sort();
  assert.equal(names.length, 41);
  assert.equal(names[40], correctiveMigrationName);
  for (const name of names.slice(0, 40)) {
    cpSync(join('prisma/migrations', name), join(migrationsDir, name), { recursive: true });
  }
  const url = new URL(process.env.DATABASE_URL!);
  url.searchParams.set('schema', qualificationSchema);
  await rootClient().$executeRawUnsafe(`CREATE SCHEMA "${qualificationSchema}"`);
  try {
    deploy(url.toString(), join(prismaDir, 'schema.prisma'));
    const before = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    const migrationGate = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    const observer = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    try {
      await seedSyntheticPrivacyNotices(before);
      const event = syntheticEvent(390, {}, '2026-03-29T00:59:59.999Z');
      const admitted = await admitBusinessInboxEvent(before, event);
      let releaseWriter = () => {};
      let writerReadyResolve = () => {};
      let writerReadyReject: (error: unknown) => void = () => {};
      const writerRelease = new Promise<void>((resolveWriter) => {
        releaseWriter = resolveWriter;
      });
      const writerReady = new Promise<void>((resolveWriter, rejectWriter) => {
        writerReadyResolve = resolveWriter;
        writerReadyReject = rejectWriter;
      });
      const writer = before.$transaction(async (tx) => {
        try {
          await tx.$queryRaw(Prisma.sql`SELECT set_config('TimeZone', 'UTC', true)`);
          const created = await createBusinessLeadPrivacyEvidence(tx, {
            businessInboxEventId: admitted.inboxEventId,
            event,
          });
          assert.equal(created.count, 2);
          writerReadyResolve();
          await writerRelease;
        } catch (error) {
          writerReadyReject(error);
          throw error;
        }
      }, { timeout: 30_000 });
      void writer.catch(() => undefined);
      await writerReady;

      const migrationSql = readFileSync(correctiveMigrationPath, 'utf8');
      const receiptLock = migrationSql.match(
        /^LOCK TABLE ONLY "PrivacyEvidenceReceipt" IN ACCESS EXCLUSIVE MODE;$/mu,
      )?.[0];
      const failClosedGuard = migrationSql.match(
        /DO \$\$\nDECLARE[\s\S]*?N13_C2_SOURCE_TIMESTAMP_ROWS_PRESENT[\s\S]*?\nEND \$\$;/u,
      )?.[0];
      assert.ok(receiptLock);
      assert.ok(failClosedGuard);
      let gateSettled = false;
      let gateFailure: unknown;
      const gate = migrationGate.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(receiptLock);
        await tx.$executeRawUnsafe(failClosedGuard);
      }, { timeout: 30_000 }).catch((error: unknown) => {
        gateFailure = error;
        throw error;
      }).finally(() => {
        gateSettled = true;
      });
      void gate.catch(() => undefined);

      let waitingLocks = 0;
      try {
        for (let attempt = 0; attempt < 200 && waitingLocks === 0; attempt += 1) {
          if (gateSettled) throw gateFailure ?? new Error('N13_C2_LOCK_GATE_SETTLED_EARLY');
          const lockRows = await observer.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
            SELECT COUNT(*)::BIGINT AS "count"
            FROM pg_locks lock_row
            JOIN pg_class table_row ON table_row.oid = lock_row.relation
            JOIN pg_namespace namespace_row ON namespace_row.oid = table_row.relnamespace
            WHERE namespace_row.nspname = ${qualificationSchema}
              AND table_row.relname = 'PrivacyEvidenceReceipt'
              AND lock_row.mode = 'AccessExclusiveLock'
              AND NOT lock_row.granted
          `);
          waitingLocks = Number(lockRows[0]?.count);
          if (waitingLocks === 0) {
            await new Promise((resolveWait) => setTimeout(resolveWait, 25));
          }
        }
        assert.equal(waitingLocks, 1);
        assert.equal(gateSettled, false);
      } finally {
        releaseWriter();
      }

      await writer;
      await assert.rejects(gate, (error: unknown) => {
        const directFailure = error as { message?: unknown; meta?: { message?: unknown } };
        return [directFailure.message, directFailure.meta?.message].some(
          (value) => typeof value === 'string'
            && /N13_C2_SOURCE_TIMESTAMP_ROWS_PRESENT/u.test(value),
        );
      });
    } finally {
      await observer.$disconnect();
      await migrationGate.$disconnect();
      await before.$disconnect();
    }

    cpSync(
      join('prisma/migrations', correctiveMigrationName),
      join(migrationsDir, correctiveMigrationName),
      { recursive: true },
    );
    assert.throws(() => {
      deploy(url.toString(), join(prismaDir, 'schema.prisma'));
    });

    const qualification = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    try {
      const [migrationRows, sourceColumnRows, receipts, indexes, functionRows] = await Promise.all([
        qualification.$queryRaw<Array<{ finished: bigint; unfinished: bigint }>>(Prisma.sql`
          SELECT
            COUNT(*) FILTER (
              WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
            )::BIGINT AS "finished",
            COUNT(*) FILTER (
              WHERE finished_at IS NULL AND rolled_back_at IS NULL
            )::BIGINT AS "unfinished"
          FROM "_prisma_migrations"
          WHERE migration_name = ${correctiveMigrationName}
        `),
        qualification.$queryRaw<Array<{ source_type: string; source_not_null: boolean }>>(Prisma.sql`
          SELECT FORMAT_TYPE(attribute_row.atttypid, attribute_row.atttypmod) AS "source_type",
                 attribute_row.attnotnull AS "source_not_null"
          FROM pg_attribute attribute_row
          JOIN pg_class table_row ON table_row.oid = attribute_row.attrelid
          WHERE table_row.relnamespace = ${qualificationSchema}::regnamespace
            AND table_row.relname = 'PrivacyEvidenceReceipt'
            AND attribute_row.attname = 'sourceSubmittedAt'
            AND attribute_row.attnum > 0
            AND NOT attribute_row.attisdropped
        `),
        qualification.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
          SELECT COUNT(*)::BIGINT AS "count" FROM "PrivacyEvidenceReceipt"
        `),
        qualification.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
          SELECT COUNT(*)::BIGINT AS "count" FROM pg_indexes
          WHERE schemaname = ${qualificationSchema}
            AND indexname LIKE 'Lead_active_%_n13_nfc_idx'
        `),
        qualification.$queryRaw<Array<{ definition: string }>>(Prisma.sql`
          SELECT PG_GET_FUNCTIONDEF(function_row.oid) AS "definition"
          FROM pg_proc function_row
          WHERE function_row.pronamespace = ${qualificationSchema}::regnamespace
            AND function_row.proname = 'privacy_evidence_receipt_validate_v1'
        `),
      ]);
      return {
        finished: Number(migrationRows[0]?.finished),
        unfinished: Number(migrationRows[0]?.unfinished),
        sourceType: sourceColumnRows[0]?.source_type,
        sourceNotNull: sourceColumnRows[0]?.source_not_null,
        receipts: Number(receipts[0]?.count),
        nfcIndexes: Number(indexes[0]?.count),
        utcConversions: (
          functionRows[0]?.definition.match(/AT TIME ZONE 'UTC'/gu) ?? []
        ).length,
      };
    } finally {
      await qualification.$disconnect();
    }
  } finally {
    await rootClient().$executeRawUnsafe(`DROP SCHEMA "${qualificationSchema}" CASCADE`);
    rmSync(root, { recursive: true, force: true });
  }
}

test('N13-C2 migration 41 fails atomically when an evidence receipt exists', {
  skip: !runDbTests,
  timeout: 360_000,
}, async () => {
  assert.deepEqual(await qualifyCorrectiveExistingRowsFailClosed(), {
    finished: 0,
    unfinished: 1,
    sourceType: 'timestamp(3) without time zone',
    sourceNotNull: true,
    receipts: 2,
    nfcIndexes: 0,
    utcConversions: 0,
  });
});

test('N13 catalog exposes six tables, expected indexes and fail-closed guards', {
  skip: !runDbTests,
}, async () => {
  const [tables, indexes, triggers, functions] = await Promise.all([
    client().$queryRaw<Array<{ name: string }>>(Prisma.sql`
      SELECT table_name AS "name" FROM information_schema.tables
      WHERE table_schema = ${suiteSchema}
        AND table_name IN (
          'LeadIdentityKeyVersion', 'LeadIdentityKey', 'LeadProjectionLedger',
          'LeadDuplicateCase', 'LeadDuplicateCandidate', 'LeadDuplicateDecision'
        ) ORDER BY table_name
    `),
    client().$queryRaw<Array<{ name: string }>>(Prisma.sql`
      SELECT indexname AS "name" FROM pg_indexes
      WHERE schemaname = ${suiteSchema}
        AND (tablename LIKE 'LeadIdentity%' OR tablename LIKE 'LeadProjection%'
          OR tablename LIKE 'LeadDuplicate%' OR indexname LIKE 'Lead_active_%')
      ORDER BY indexname
    `),
    client().$queryRaw<Array<{ name: string }>>(Prisma.sql`
      SELECT trigger_row.tgname AS "name"
      FROM pg_trigger trigger_row
      JOIN pg_class table_row ON table_row.oid = trigger_row.tgrelid
      WHERE table_row.relnamespace = ${suiteSchema}::regnamespace
        AND NOT trigger_row.tgisinternal
        AND trigger_row.tgname LIKE '%n13_v1'
      ORDER BY trigger_row.tgname
    `),
    client().$queryRaw<Array<{ name: string }>>(Prisma.sql`
      SELECT proname AS "name" FROM pg_proc
      WHERE pronamespace = ${suiteSchema}::regnamespace
        AND proname LIKE 'fai_lead_%n13_v1'
      ORDER BY proname
    `),
  ]);
  assert.equal(tables.length, 6);
  assert.equal(indexes.length, 39);
  for (const name of [
    'Lead_active_email_normalized_idx',
    'Lead_active_person_name_normalized_idx',
    'Lead_active_company_name_normalized_idx',
    'Lead_active_email_n13_nfc_idx',
    'Lead_active_person_name_n13_nfc_idx',
    'Lead_active_company_name_n13_nfc_idx',
  ]) assert.equal(indexes.some((index) => index.name === name), true, name);
  assert.equal(triggers.length, 12);
  assert.deepEqual(functions.map(({ name }) => name), [
    'fai_lead_append_only_guard_n13_v1',
    'fai_lead_duplicate_case_guard_n13_v1',
    'fai_lead_identity_key_guard_n13_v1',
    'fai_lead_identity_key_version_guard_n13_v1',
    'fai_lead_projection_ledger_guard_n13_v1',
  ]);

  const staged = await client().leadIdentityKeyVersion.create({
    data: {
      normalizationVersion: LEAD_NORMALIZATION_VERSION,
      version: N13_SYNTHETIC_KEY_VERSION + 1,
      keyDigest: '4'.repeat(64),
      createdById: primaryUserId,
    },
  });
  await assert.rejects(client().leadIdentityKeyVersion.update({
    where: { id: staged.id },
    data: { status: 'ACTIVE', activatedAt: new Date() },
  }));
  await assert.rejects(client().leadIdentityKeyVersion.create({
    data: {
      normalizationVersion: LEAD_NORMALIZATION_VERSION,
      version: 99,
      keyDigest: '5'.repeat(64),
      status: 'ACTIVE',
      activatedAt: new Date(),
    },
  }));
});

test('N13-C2 raw candidate and manual-create prefilters are NFC-equivalent in both directions', {
  skip: !runDbTests,
}, async () => {
  const activeKey = await client().leadIdentityKeyVersion.findFirstOrThrow({
    where: { status: 'ACTIVE' },
    select: { id: true, version: true },
  });
  const key = { version: activeKey.version, secret: N13_SYNTHETIC_KEY_SECRET } as const;
  const cases = [
    {
      stored: { email: 'u\u0308ser-one@n13-c2.invalid' },
      incoming: { email: 'üser-one@n13-c2.invalid' },
    },
    {
      stored: { email: 'üser-two@n13-c2.invalid' },
      incoming: { email: 'u\u0308ser-two@n13-c2.invalid' },
    },
    {
      stored: { firstName: 'Jose\u0301', lastName: 'Garci\u0301a' },
      incoming: { firstName: 'José', lastName: 'García' },
    },
    {
      stored: { firstName: 'André', lastName: 'Müller' },
      incoming: { firstName: 'Andre\u0301', lastName: 'Mu\u0308ller' },
    },
    {
      stored: { companyName: 'Cafe\u0301 Synthetic One' },
      incoming: { companyName: 'Café Synthetic One' },
    },
    {
      stored: { companyName: 'Société Synthetic Two' },
      incoming: { companyName: 'Socie\u0301te\u0301 Synthetic Two' },
    },
  ] as const;
  for (const [index, current] of cases.entries()) {
    const lead = await client().lead.create({
      data: {
        firstName: 'N13-C2',
        lastName: `Candidate${index}`,
        source: 'N13_C2_NFC_SYNTHETIC',
        ...current.stored,
      },
    });
    const signals = digestLeadIdentitySignals(
      key,
      normalizeLeadIdentitySignals(current.incoming),
    );
    const candidates = await client().$transaction((tx) => discoverLeadIdentityCandidates(tx, {
      identityKeyVersionId: activeKey.id,
      signals,
    }));
    assert.equal(candidates.some((candidate) => candidate.leadId === lead.id), true, String(index));
  }

  assert.equal(await client().$transaction((tx) => hasStrongRawLeadIdentityDuplicate(tx, {
    email: 'üser-one@n13-c2.invalid',
  })), true);
  assert.equal(await client().$transaction((tx) => hasStrongRawLeadIdentityDuplicate(tx, {
    email: 'u\u0308ser-two@n13-c2.invalid',
  })), true);
});

test('N13-C2 privacy evidence is invariant across session timezones and DST boundaries', {
  skip: !runDbTests,
  timeout: 360_000,
}, async () => {
  await assertAiOrchestratorEphemeralDatabaseIdentity(rootClient());
  const qualificationSchema = `n13_c2_timezone_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const url = new URL(process.env.DATABASE_URL!);
  url.searchParams.set('schema', qualificationSchema);
  await rootClient().$executeRawUnsafe(`CREATE SCHEMA "${qualificationSchema}"`);
  deploy(url.toString());
  const qualification = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  const zones = ['UTC', 'Europe/Rome', 'America/New_York'] as const;
  const instants = [
    '2026-03-08T06:59:59.999Z',
    '2026-03-08T07:00:00.000Z',
    '2026-03-29T00:59:59.999Z',
    '2026-03-29T01:00:00.000Z',
    '2026-10-25T00:59:59.999Z',
    '2026-10-25T01:00:00.000Z',
    '2026-11-01T05:59:59.999Z',
    '2026-11-01T06:00:00.000Z',
  ] as const;
  try {
    await seedSyntheticPrivacyNotices(qualification);
    for (const [index, occurredAt] of instants.entries()) {
      const event = syntheticEvent(420 + index, {}, occurredAt);
      const admitted = await admitBusinessInboxEvent(qualification, event);
      const hashesByZone: string[][] = [];
      const instantsByZone: string[][] = [];
      for (const zone of zones) {
        let evidenceHashes: readonly string[] | undefined;
        let storedInstants: readonly string[] | undefined;
        const rollback = new Error(`N13_C2_TIMEZONE_ROLLBACK_${index}_${zone}`);
        await assert.rejects(qualification.$transaction(async (tx) => {
          await tx.$queryRaw(Prisma.sql`SELECT set_config('TimeZone', ${zone}, true)`);
          evidenceHashes = (await createBusinessLeadPrivacyEvidence(tx, {
            businessInboxEventId: admitted.inboxEventId,
            event,
          })).evidenceHashes;
          storedInstants = (await tx.privacyEvidenceReceipt.findMany({
            where: { businessInboxEventId: admitted.inboxEventId },
            orderBy: { purposeCode: 'asc' },
            select: { sourceSubmittedAt: true },
          })).map(({ sourceSubmittedAt }) => sourceSubmittedAt.toISOString());
          throw rollback;
        }), (error: unknown) => error === rollback);
        assert.ok(evidenceHashes);
        assert.ok(storedInstants);
        hashesByZone.push([...evidenceHashes]);
        instantsByZone.push([...storedInstants]);
      }
      assert.deepEqual(hashesByZone[1], hashesByZone[0]);
      assert.deepEqual(hashesByZone[2], hashesByZone[0]);
      assert.deepEqual(instantsByZone[1], instantsByZone[0]);
      assert.deepEqual(instantsByZone[2], instantsByZone[0]);
      assert.deepEqual(instantsByZone[0], [occurredAt, occurredAt]);
      assert.equal(await qualification.privacyEvidenceReceipt.count({
        where: { businessInboxEventId: admitted.inboxEventId },
      }), 0);

      const alteredEvent = {
        ...event,
        occurredAt: new Date(new Date(event.occurredAt).getTime() + 1).toISOString(),
      };
      await assert.rejects(qualification.$transaction(async (tx) => {
        await tx.$queryRaw(Prisma.sql`SELECT set_config('TimeZone', ${zones[1]}, true)`);
        await createBusinessLeadPrivacyEvidence(tx, {
          businessInboxEventId: admitted.inboxEventId,
          event: alteredEvent,
        });
      }));

      const serviceNotice = await qualification.privacyNoticeVersion.findFirstOrThrow({
        where: {
          noticeCode: event.privacy.service.noticeCode,
          noticeVersion: event.privacy.service.noticeVersion,
        },
        select: { id: true },
      });
      await assert.rejects(qualification.$transaction(async (tx) => {
        await tx.$queryRaw(Prisma.sql`SELECT set_config('TimeZone', ${zones[0]}, true)`);
        await tx.privacyEvidenceReceipt.create({
          data: {
            leadId: null,
            websiteLeadReceiptId: null,
            businessInboxEventId: admitted.inboxEventId,
            noticeVersionId: serviceNotice.id,
            catalogVersion: 'n04-v1',
            purposeCode: event.privacy.service.purposeCode,
            legalBasisCode: event.privacy.service.legalBasisCode,
            evidenceKind: 'NOTICE_ACKNOWLEDGEMENT',
            decision: 'ACKNOWLEDGED',
            sourceSystem: event.source.systemCode,
            formCode: event.source.formCode,
            formVersion: event.source.formVersion,
            sourceSubmittedAt: new Date(event.occurredAt),
            sourceEvidenceDigest: event.idempotency.payloadHash,
            evidenceHash: '0'.repeat(64),
          },
        });
      }));
      assert.equal(await qualification.privacyEvidenceReceipt.count({
        where: { businessInboxEventId: admitted.inboxEventId },
      }), 0);
    }
  } finally {
    await qualification.$disconnect();
    await rootClient().$executeRawUnsafe(`DROP SCHEMA "${qualificationSchema}" CASCADE`);
  }
});

test('projection matrix 0/1/N is atomic and binds exactly two privacy receipts', {
  skip: !runDbTests,
}, async () => {
  const zero = await admitAndClaim(10);
  const projected = await projectClaimedLeadInboxEvent(client(), zero.lease, projectionOptions());
  assert.equal(projected.state, 'PROCESSED');
  assert.equal(projected.result.state, 'PROJECTED_NEW');
  assert.equal(projected.result.candidateCount, 0);
  assert.equal(await client().lead.count({ where: { email: zero.event.payload.email } }), 1);
  assert.equal(await client().privacyEvidenceReceipt.count({
    where: { businessInboxEventId: zero.admitted.inboxEventId },
  }), 2);
  assert.ok(await client().leadIdentityKey.count({
    where: { sourceProjectionId: projected.result.ledgerId },
  }) >= 4);

  const one = await createReviewCase(11, 1);
  assert.equal(one.projected.result.candidateCount, 1);
  assert.equal(await client().lead.count({ where: { email: one.event.payload.email } }), 1);
  assert.equal(await client().leadDuplicateCandidate.count({
    where: { duplicateCaseId: one.duplicateCase.id, discoveryRevision: 1 },
  }), 1);
  assert.equal(await client().privacyEvidenceReceipt.count({
    where: { businessInboxEventId: one.lease.eventRowId },
  }), 2);

  const many = await createReviewCase(12, 3);
  assert.equal(many.projected.result.candidateCount, 3);
  assert.equal(await client().lead.count({ where: { email: many.event.payload.email } }), 3);
  const snapshots = await client().leadDuplicateCandidate.findMany({
    where: { duplicateCaseId: many.duplicateCase.id, discoveryRevision: 1 },
    orderBy: { rank: 'asc' },
  });
  assert.deepEqual(snapshots.map(({ rank }) => rank), [1, 2, 3]);
  assert.equal(await client().leadIdentityKey.count({
    where: { sourceProjectionId: many.projected.result.ledgerId },
  }), 0);
});

test('projection rejects stale token, expired lease and replay without a second effect', {
  skip: !runDbTests,
}, async () => {
  const stale = await admitAndClaim(20);
  await assert.rejects(
    projectClaimedLeadInboxEvent(client(), {
      ...stale.lease,
      leaseToken: '0'.repeat(64),
    }, projectionOptions()),
    (error: unknown) => error instanceof BusinessEventBackboneError
      && error.code === 'BUSINESS_QUEUE_LEASE_STALE',
  );
  const completed = await projectClaimedLeadInboxEvent(client(), stale.lease, projectionOptions());
  await assert.rejects(
    projectClaimedLeadInboxEvent(client(), stale.lease, projectionOptions()),
    (error: unknown) => error instanceof BusinessEventBackboneError
      && error.code === 'BUSINESS_QUEUE_LEASE_STALE',
  );
  assert.equal(await client().leadProjectionLedger.count({
    where: { inboxEventId: stale.lease.eventRowId },
  }), 1);
  assert.equal(await client().lead.count({ where: { id: completed.result.leadId! } }), 1);

  const expired = await admitAndClaim(21);
  await client().$executeRawUnsafe(
    'ALTER TABLE "BusinessInboxEvent" DISABLE TRIGGER "BusinessInboxEvent_guard_v1"',
  );
  try {
    await client().$executeRaw(Prisma.sql`
      UPDATE "BusinessInboxEvent"
      SET "leaseClaimedAt" = clock_timestamp() - interval '2 seconds',
          "leaseExpiresAt" = clock_timestamp() - interval '1 second'
      WHERE "id" = ${expired.lease.eventRowId}::UUID
    `);
  } finally {
    await client().$executeRawUnsafe(
      'ALTER TABLE "BusinessInboxEvent" ENABLE TRIGGER "BusinessInboxEvent_guard_v1"',
    );
  }
  await assert.rejects(
    projectClaimedLeadInboxEvent(client(), expired.lease, projectionOptions()),
    (error: unknown) => error instanceof BusinessEventBackboneError
      && error.code === 'BUSINESS_QUEUE_LEASE_STALE',
  );
  assert.equal(await client().leadProjectionLedger.count({
    where: { inboxEventId: expired.lease.eventRowId },
  }), 0);
});

test('manual link is non-overwriting, reopen preserves history, and create-new is compensating', {
  skip: !runDbTests,
}, async () => {
  const review = await createReviewCase(30, 1);
  const candidateId = review.candidates[0]!.id;
  const before = await client().lead.findUniqueOrThrow({ where: { id: candidateId } });
  const linked = await resolveLeadDuplicateCase(client(), {
    caseId: review.duplicateCase.id,
    expectedCaseVersion: 1,
    outcome: 'LINK_EXISTING_NO_OVERWRITE',
    selectedLeadId: candidateId,
    reasonCode: 'SYNTHETIC_LINK_CONFIRMED',
    reasonNote: 'Synthetic confidential note, excluded from AuditLog.',
    ...resolutionActor(),
  }, projectionOptions());
  assert.equal(linked.state, 'RESOLVED_EXISTING');
  assert.deepEqual(await client().lead.findUniqueOrThrow({ where: { id: candidateId } }), before);
  const linkIdentityRows = await client().leadIdentityKey.findMany({
    where: { sourceDecisionId: linked.decisionId },
  });
  assert.ok(linkIdentityRows.length >= 4);

  const reopened = await resolveLeadDuplicateCase(client(), {
    caseId: review.duplicateCase.id,
    expectedCaseVersion: 2,
    outcome: 'REOPEN',
    reasonCode: 'SYNTHETIC_REVIEW_REOPENED',
    ...resolutionActor(),
  }, projectionOptions());
  assert.equal(reopened.state, 'REVIEW_REQUIRED');
  assert.equal(reopened.discoveryRevision, 2);
  assert.ok((await client().leadIdentityKey.findMany({
    where: { sourceDecisionId: linked.decisionId },
  })).every(({ retiredAt, retiredByDecisionId }) => (
    retiredAt !== null && retiredByDecisionId === reopened.decisionId
  )));

  const created = await resolveLeadDuplicateCase(client(), {
    caseId: review.duplicateCase.id,
    expectedCaseVersion: 3,
    outcome: 'CREATE_NEW',
    reasonCode: 'SYNTHETIC_DISTINCT_LEAD',
    ...resolutionActor(),
  }, projectionOptions());
  assert.equal(created.state, 'RESOLVED_NEW');
  assert.notEqual(created.resultingLeadId, candidateId);
  assert.deepEqual((await client().leadDuplicateDecision.findMany({
    where: { duplicateCaseId: review.duplicateCase.id },
    orderBy: { sequence: 'asc' },
  })).map(({ sequence, outcome }) => ({ sequence, outcome })), [
    { sequence: 1, outcome: 'LINK_EXISTING_NO_OVERWRITE' },
    { sequence: 2, outcome: 'REOPEN' },
    { sequence: 3, outcome: 'CREATE_NEW' },
  ]);
  const audit = await client().auditLog.findFirstOrThrow({
    where: { event: 'lead_duplicate_decision_v1', actorId: primaryUserId },
    orderBy: { createdAt: 'desc' },
  });
  assert.equal(audit.entityId, null);
  assert.doesNotMatch(
    JSON.stringify(audit.after),
    /synthetic confidential|@n13-db\.invalid|decisionId|leadId|caseId|ledgerId|digest|hash/iu,
  );
});

test('stale case version and revoked registry session fail without a decision', {
  skip: !runDbTests,
}, async () => {
  const stale = await createReviewCase(31, 1);
  await resolveLeadDuplicateCase(client(), {
    caseId: stale.duplicateCase.id,
    expectedCaseVersion: 1,
    outcome: 'LINK_EXISTING_NO_OVERWRITE',
    selectedLeadId: stale.candidates[0]!.id,
    reasonCode: 'SYNTHETIC_FIRST_WINNER',
    ...resolutionActor(),
  }, projectionOptions());
  await assert.rejects(resolveLeadDuplicateCase(client(), {
    caseId: stale.duplicateCase.id,
    expectedCaseVersion: 1,
    outcome: 'REOPEN',
    reasonCode: 'SYNTHETIC_STALE',
    ...resolutionActor(),
  }, projectionOptions()), (error: unknown) => error instanceof LeadDuplicateResolutionError
    && error.code === 'N13_DUPLICATE_CASE_VERSION_CONFLICT');
  assert.equal(await client().leadDuplicateDecision.count({
    where: { duplicateCaseId: stale.duplicateCase.id },
  }), 1);

  const actor = await createSession('direzione', 2);
  const revoked = await createReviewCase(32, 1);
  let releaseRevocation!: () => void;
  let reportLocked!: () => void;
  const revocationReleased = new Promise<void>((resolveRelease) => {
    releaseRevocation = resolveRelease;
  });
  const sessionLocked = new Promise<void>((resolveLocked) => {
    reportLocked = resolveLocked;
  });
  const revocation = client().$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`
      SELECT "id" FROM "InternalSession" WHERE "id" = ${actor.sessionId}::UUID FOR UPDATE
    `);
    reportLocked();
    await revocationReleased;
    await tx.internalSession.update({
      where: { id: actor.sessionId },
      data: { revokedAt: new Date(), revokedReason: 'INTERNAL_SINGLE' },
    });
  });
  await sessionLocked;
  const pendingDecision = resolveLeadDuplicateCase(client(), {
    caseId: revoked.duplicateCase.id,
    expectedCaseVersion: 1,
    outcome: 'LINK_EXISTING_NO_OVERWRITE',
    selectedLeadId: revoked.candidates[0]!.id,
    reasonCode: 'SYNTHETIC_REVOKED_SESSION',
    ...resolutionActor(actor),
  }, projectionOptions());
  const deniedDecision = assert.rejects(
    pendingDecision,
    (error: unknown) => error instanceof LeadDuplicateResolutionError
      && error.code === 'N13_DUPLICATE_SESSION_DENIED',
  );
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 50));
  releaseRevocation();
  await revocation;
  await deniedDecision;
  assert.equal(await client().leadDuplicateDecision.count({
    where: { duplicateCaseId: revoked.duplicateCase.id },
  }), 0);
});

test('candidate and decision history, ledger transitions and N13 registries reject mutation or truncate', {
  skip: !runDbTests,
}, async () => {
  const review = await createReviewCase(40, 1);
  const candidate = await client().leadDuplicateCandidate.findFirstOrThrow({
    where: { duplicateCaseId: review.duplicateCase.id },
  });
  const resolved = await resolveLeadDuplicateCase(client(), {
    caseId: review.duplicateCase.id,
    expectedCaseVersion: 1,
    outcome: 'LINK_EXISTING_NO_OVERWRITE',
    selectedLeadId: review.candidates[0]!.id,
    reasonCode: 'SYNTHETIC_GUARD_TEST',
    ...resolutionActor(),
  }, projectionOptions());
  await assert.rejects(client().leadDuplicateCandidate.update({
    where: { id: candidate.id },
    data: { rank: 2 },
  }));
  await assert.rejects(client().leadDuplicateDecision.update({
    where: { id: resolved.decisionId },
    data: { reasonCode: 'SYNTHETIC_TAMPERED' },
  }));
  await assert.rejects(client().leadProjectionLedger.update({
    where: { id: review.projected.result.ledgerId },
    data: { resultHash: '0'.repeat(64) },
  }));
  await assert.rejects(client().leadDuplicateCase.delete({
    where: { id: review.duplicateCase.id },
  }));
  await assert.rejects(client().leadDuplicateCandidate.create({
    data: {
      duplicateCaseId: review.duplicateCase.id,
      discoveryRevision: 1,
      leadId: 'missing-synthetic-lead',
      rank: 99,
      strongestSignal: 'STRONG',
      strongSignalCount: 1,
      weakSignalCount: 0,
      matchedSignalCodes: ['EMAIL_EXACT_V1'],
      snapshotHash: '6'.repeat(64),
    },
  }));
  for (const table of [
    'LeadIdentityKeyVersion',
    'LeadIdentityKey',
    'LeadProjectionLedger',
    'LeadDuplicateCase',
    'LeadDuplicateCandidate',
    'LeadDuplicateDecision',
  ]) {
    await assert.rejects(client().$executeRawUnsafe(`TRUNCATE TABLE "${table}"`));
  }
});

test('faults after every projection stage roll back business state and permit a safe retry', {
  skip: !runDbTests,
  timeout: 120_000,
}, async () => {
  const points: readonly LeadProjectionFaultPoint[] = [
    'AFTER_EVIDENCE',
    'AFTER_LEAD',
    'AFTER_LEDGER',
    'AFTER_CASE',
    'BEFORE_COMPLETION',
  ];
  for (const [index, point] of points.entries()) {
    const ordinal = 50 + index;
    const prepared = point === 'AFTER_CASE'
      ? await createReviewCaseFaultInput(ordinal)
      : await admitAndClaim(ordinal);
    await assert.rejects(projectClaimedLeadInboxEvent(client(), prepared.lease, {
      ...projectionOptions(),
      faultInjector: (current) => {
        if (current === point) throw new LeadProjectionError('N13_IDENTITY_KEY_UNAVAILABLE');
      },
    }), (error: unknown) => error instanceof LeadProjectionError
      && error.code === 'N13_IDENTITY_KEY_UNAVAILABLE');
    assert.equal(await client().leadProjectionLedger.count({
      where: { inboxEventId: prepared.lease.eventRowId },
    }), 0, point);
    assert.equal(await client().privacyEvidenceReceipt.count({
      where: { businessInboxEventId: prepared.lease.eventRowId },
    }), 0, point);
    assert.equal(await client().lead.count({
      where: { source: `N10:WORDPRESS:N13_DB_SYNTHETIC_FORM:v1`, email: prepared.event.payload.email },
    }), 0, point);
    await forceAvailableNow(prepared.lease.eventRowId);
    const retryLease = await claimBusinessQueueEvent(client(), {
      queueKind: 'INBOX',
      leaseOwnerId: uuid(170_000 + ordinal),
    });
    assert.ok(retryLease);
    assert.equal(retryLease.eventRowId, prepared.lease.eventRowId);
    const retried = await projectClaimedLeadInboxEvent(client(), retryLease, projectionOptions());
    assert.equal(retried.state, 'PROCESSED');
    assert.equal(await client().leadProjectionLedger.count({
      where: { inboxEventId: prepared.lease.eventRowId },
    }), 1, point);
  }
});

async function createReviewCaseFaultInput(ordinal: number) {
  const event = syntheticEvent(ordinal);
  await client().lead.create({
    data: {
      firstName: 'Synthetic',
      lastName: `FaultCandidate${ordinal}`,
      email: event.payload.email,
      source: 'N13_DB_SYNTHETIC_CANDIDATE',
    },
  });
  const admitted = await admitBusinessInboxEvent(client(), event);
  const lease = await claimBusinessQueueEvent(client(), {
    queueKind: 'INBOX',
    leaseOwnerId: uuid(160_000 + ordinal),
  });
  assert.ok(lease);
  assert.equal(lease.eventRowId, admitted.inboxEventId);
  return { event, admitted, lease };
}

test('multiprocess same-inbox and overlapping-identity races converge without auto-merge', {
  skip: !runDbTests,
  timeout: 180_000,
}, async () => {
  const same = await admitAndClaim(70);
  const sameInput = {
    lease: serializableLease(same.lease),
    keyFilePath: secretPath,
    allowedSecretRoot: secretRoot,
  };
  const sameResults = await Promise.all(Array.from({ length: 4 }, () => (
    runFixture('project', sameInput)
  )));
  assert.deepEqual(aggregateOutcomes(sameResults), {
    PROJECTED_NEW: 1,
    BUSINESS_QUEUE_LEASE_STALE: 3,
  });
  assert.equal(await client().leadProjectionLedger.count({
    where: { inboxEventId: same.lease.eventRowId },
  }), 1);

  const sharedEmail = 'overlap@n13-db.invalid';
  const first = await admitAndClaim(71, { email: sharedEmail });
  const second = await admitAndClaim(72, { email: sharedEmail });
  const overlap = await Promise.all([first, second].map(({ lease }) => runFixture('project', {
    lease: serializableLease(lease),
    keyFilePath: secretPath,
    allowedSecretRoot: secretRoot,
  })));
  assert.deepEqual(aggregateOutcomes(overlap), { PROJECTED_NEW: 1, REVIEW_REQUIRED: 1 });
  assert.equal(await client().lead.count({ where: { email: sharedEmail } }), 1);
});

test('multiprocess manual-create/projection and duplicate decisions serialize on N13 locks', {
  skip: !runDbTests,
  timeout: 180_000,
}, async () => {
  const email = 'manual-projection-race@n13-db.invalid';
  const prepared = await admitAndClaim(80, { email });
  const [projection, manual] = await Promise.all([
    runFixture('project', {
      lease: serializableLease(prepared.lease),
      keyFilePath: secretPath,
      allowedSecretRoot: secretRoot,
    }),
    runFixture('manual-create', { email, phone: null }),
  ]);
  assert.equal(await client().lead.count({ where: { email } }), 1);
  const outcomes = aggregateOutcomes([projection, manual]);
  assert.equal(
    JSON.stringify(outcomes) === JSON.stringify({ PROJECTED_NEW: 1, DUPLICATE: 1 })
      || JSON.stringify(outcomes) === JSON.stringify({ REVIEW_REQUIRED: 1, CREATED: 1 }),
    true,
    JSON.stringify(outcomes),
  );

  const precomposedEmail = 'râce@n13-c2-race.invalid';
  const decomposedEmail = 'ra\u0302ce@n13-c2-race.invalid';
  const unicodePrepared = await admitAndClaim(82, { email: precomposedEmail });
  const [unicodeProjection, unicodeManual] = await Promise.all([
    runFixture('project', {
      lease: serializableLease(unicodePrepared.lease),
      keyFilePath: secretPath,
      allowedSecretRoot: secretRoot,
    }),
    runFixture('manual-create', { email: decomposedEmail, phone: null }),
  ]);
  assert.equal(await client().lead.count({
    where: { email: { in: [precomposedEmail, decomposedEmail] } },
  }), 1);
  const unicodeOutcomes = aggregateOutcomes([unicodeProjection, unicodeManual]);
  assert.equal(
    JSON.stringify(unicodeOutcomes) === JSON.stringify({ PROJECTED_NEW: 1, DUPLICATE: 1 })
      || JSON.stringify(unicodeOutcomes) === JSON.stringify({ REVIEW_REQUIRED: 1, CREATED: 1 }),
    true,
    JSON.stringify(unicodeOutcomes),
  );

  const review = await createReviewCase(81, 1);
  const resolutionInput = {
    caseId: review.duplicateCase.id,
    expectedCaseVersion: 1,
    outcome: 'LINK_EXISTING_NO_OVERWRITE',
    selectedLeadId: review.candidates[0]!.id,
    reasonCode: 'SYNTHETIC_MULTIPROCESS_WINNER',
    actorUserId: primaryUserId,
    actorSessionId: primarySessionId,
    keyFilePath: secretPath,
    allowedSecretRoot: secretRoot,
  };
  const decisions = await Promise.all(Array.from({ length: 2 }, () => (
    runFixture('resolve', resolutionInput)
  )));
  assert.deepEqual(aggregateOutcomes(decisions), {
    RESOLVED_EXISTING: 1,
    N13_DUPLICATE_CASE_VERSION_CONFLICT: 1,
  });
  assert.equal(await client().leadDuplicateDecision.count({
    where: { duplicateCaseId: review.duplicateCase.id },
  }), 1);
});
