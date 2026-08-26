import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  assertAiOrchestratorEphemeralDatabaseIdentity,
  assertAiOrchestratorEphemeralDbTestConfiguration,
} from './ai-orchestrator-db-test-guard';

const migration42Name = '20260823160000_commercial_lead_inbox_attribution_sla_v1';
const migration43Name = '20260826150000_n13_n14_projection_attribution_corrective_v1';
const migration42Path = `prisma/migrations/${migration42Name}/migration.sql`;
const migration43Path = `prisma/migrations/${migration43Name}/migration.sql`;
const migration42Sha256 = 'fc94e1bf2c659b68baf708d38cf7f3aa4c6b9e653a89330be5ca754bcfeab7aa';
const guard42ProsrcSha256 = 'ec8384f54c0deb94f08e8744b504738a9eb2a43f72577e2447874b98390e52a9';
const guard43ProsrcSha256 = 'a581369986e132bdc7de8698d6cd18047b6cb1e8867c12182ed8c46eeaefc743';

const runDbTests = assertAiOrchestratorEphemeralDbTestConfiguration({
  requested: process.env.RUN_DB_TESTS === '1',
  destructiveConfirmed: process.env.AI_ORCHESTRATOR_DB_TESTS_CONFIRMED === '1',
  databaseUrl: process.env.DATABASE_URL,
  sentinel: process.env.AI_ORCHESTRATOR_DB_TEST_SENTINEL,
  appEnvironment: process.env.APP_ENV,
  nodeEnvironment: process.env.NODE_ENV,
});
const rootDb = runDbTests ? new PrismaClient() : null;
let fixtureOrdinal = 0;

interface MigrationFixture {
  readonly schema: string;
  readonly databaseUrl: string;
  readonly temporaryRoot: string;
  readonly schemaPath: string;
  readonly migrationsDirectory: string;
}

interface ColumnState {
  readonly name: string;
  readonly type: string;
  readonly notNull: boolean;
}

interface ConstraintState {
  readonly validated: boolean;
  readonly treeHash: string;
}

interface TriggerState {
  readonly enabled: string;
  readonly triggerType: number;
  readonly argumentCount: number;
  readonly columnNumbers: string;
  readonly argumentBytes: number;
  readonly hasWhen: boolean;
  readonly constraintOid: bigint;
  readonly deferrable: boolean;
  readonly initiallyDeferred: boolean;
  readonly oldTable: string | null;
  readonly newTable: string | null;
  readonly parentOid: bigint;
  readonly functionName: string;
}

interface PhysicalState {
  readonly columns: readonly ColumnState[];
  readonly constraints: readonly ConstraintState[];
  readonly guardHashes: readonly string[];
  readonly triggers: readonly TriggerState[];
  readonly probeCount: number;
}

function rootClient() {
  if (!rootDb) throw new Error('N13_N14_CORRECTIVE_ROOT_DB_UNAVAILABLE');
  return rootDb;
}

function migrationNames() {
  return readdirSync('prisma/migrations').filter((name) => /^\d/u.test(name)).sort();
}

function deploy(databaseUrl: string, schemaPath: string) {
  execFileSync(
    resolve('node_modules/.bin/prisma'),
    ['migrate', 'deploy', '--schema', schemaPath],
    {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
      timeout: 240_000,
    },
  );
}

function executeMigrationScript(databaseUrl: string, schemaPath: string) {
  execFileSync(
    resolve('node_modules/.bin/prisma'),
    [
      'db',
      'execute',
      '--file',
      resolve(migration43Path),
      '--schema',
      schemaPath,
    ],
    {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
      timeout: 240_000,
    },
  );
}

function copyMigration(fixture: MigrationFixture, name: string) {
  cpSync(
    join('prisma/migrations', name),
    join(fixture.migrationsDirectory, name),
    { recursive: true },
  );
}

async function createFixture(label: string, names: readonly string[]) {
  await assertAiOrchestratorEphemeralDatabaseIdentity(rootClient());
  fixtureOrdinal += 1;
  const schema = `n13_n14_${label}_${process.pid}_${fixtureOrdinal}`;
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'n13-n14-corrective-'));
  const prismaDirectory = join(temporaryRoot, 'prisma');
  const migrationsDirectory = join(prismaDirectory, 'migrations');
  const schemaPath = join(prismaDirectory, 'schema.prisma');
  mkdirSync(migrationsDirectory, { recursive: true });
  cpSync('prisma/schema.prisma', schemaPath);
  const databaseUrl = new URL(process.env.DATABASE_URL!);
  databaseUrl.searchParams.set('schema', schema);
  await rootClient().$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  const fixture: MigrationFixture = {
    schema,
    databaseUrl: databaseUrl.toString(),
    temporaryRoot,
    schemaPath,
    migrationsDirectory,
  };
  for (const name of names) copyMigration(fixture, name);
  return fixture;
}

async function destroyFixture(fixture: MigrationFixture) {
  await assertAiOrchestratorEphemeralDatabaseIdentity(rootClient());
  await rootClient().$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${fixture.schema}" CASCADE`);
  rmSync(fixture.temporaryRoot, { recursive: true, force: true });
}

function commandFailureText(error: unknown) {
  const failure = error as {
    readonly message?: unknown;
    readonly stdout?: unknown;
    readonly stderr?: unknown;
  };
  return [failure?.message, failure?.stdout, failure?.stderr]
    .map((value) => Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? ''))
    .join('\n');
}

async function readFinishedMigrationCount(client: PrismaClient) {
  const rows = await client.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
    SELECT COUNT(*)::BIGINT AS "count"
    FROM "_prisma_migrations"
    WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
  `);
  return Number(rows[0]?.count);
}

async function readMigrationRecord(client: PrismaClient, name: string) {
  const rows = await client.$queryRaw<Array<{
    checksum: string;
    finished: boolean;
    notRolledBack: boolean;
  }>>(Prisma.sql`
    SELECT checksum,
           finished_at IS NOT NULL AS "finished",
           rolled_back_at IS NULL AS "notRolledBack"
    FROM "_prisma_migrations"
    WHERE migration_name = ${name}
    ORDER BY started_at DESC
    LIMIT 1
  `);
  return rows[0] ?? null;
}

async function readTargetFinishedRows(client: PrismaClient) {
  const rows = await client.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
    SELECT COUNT(*)::BIGINT AS "count"
    FROM "_prisma_migrations"
    WHERE migration_name = ${migration43Name}
      AND finished_at IS NOT NULL
      AND rolled_back_at IS NULL
  `);
  return Number(rows[0]?.count);
}

async function readPhysicalState(client: PrismaClient): Promise<PhysicalState> {
  const [columns, constraints, guardHashes, triggers, probes] = await Promise.all([
    client.$queryRaw<ColumnState[]>(Prisma.sql`
      SELECT attribute_row.attname AS "name",
             FORMAT_TYPE(attribute_row.atttypid, attribute_row.atttypmod) AS "type",
             attribute_row.attnotnull AS "notNull"
      FROM pg_attribute attribute_row
      JOIN pg_class table_row ON table_row.oid = attribute_row.attrelid
      JOIN pg_namespace namespace_row ON namespace_row.oid = table_row.relnamespace
      WHERE namespace_row.nspname = CURRENT_SCHEMA()
        AND table_row.relname = 'CommercialLeadInboxItem'
        AND attribute_row.attname IN ('sourceSystem', 'formCode', 'formVersion')
        AND attribute_row.attnum > 0
        AND NOT attribute_row.attisdropped
      ORDER BY attribute_row.attname
    `),
    client.$queryRaw<ConstraintState[]>(Prisma.sql`
      SELECT constraint_row.convalidated AS "validated",
             ENCODE(SHA256(CONVERT_TO(constraint_row.conbin::TEXT, 'UTF8')), 'hex') AS "treeHash"
      FROM pg_constraint constraint_row
      JOIN pg_class table_row ON table_row.oid = constraint_row.conrelid
      JOIN pg_namespace namespace_row ON namespace_row.oid = table_row.relnamespace
      WHERE namespace_row.nspname = CURRENT_SCHEMA()
        AND table_row.relname = 'CommercialLeadInboxItem'
        AND constraint_row.conname = 'CommercialLeadInboxItem_contract_check'
        AND constraint_row.contype = 'c'
    `),
    client.$queryRaw<Array<{ hash: string }>>(Prisma.sql`
      SELECT ENCODE(SHA256(CONVERT_TO(function_row.prosrc, 'UTF8')), 'hex') AS "hash"
      FROM pg_proc function_row
      JOIN pg_namespace namespace_row ON namespace_row.oid = function_row.pronamespace
      WHERE namespace_row.nspname = CURRENT_SCHEMA()
        AND function_row.proname = 'n14_guard_item'
        AND function_row.pronargs = 0
    `),
    client.$queryRaw<TriggerState[]>(Prisma.sql`
      SELECT trigger_row.tgenabled::TEXT AS "enabled",
             trigger_row.tgtype::INTEGER AS "triggerType",
             trigger_row.tgnargs::INTEGER AS "argumentCount",
             trigger_row.tgattr::TEXT AS "columnNumbers",
             OCTET_LENGTH(trigger_row.tgargs)::INTEGER AS "argumentBytes",
             trigger_row.tgqual IS NOT NULL AS "hasWhen",
             trigger_row.tgconstraint::BIGINT AS "constraintOid",
             trigger_row.tgdeferrable AS "deferrable",
             trigger_row.tginitdeferred AS "initiallyDeferred",
             trigger_row.tgoldtable AS "oldTable",
             trigger_row.tgnewtable AS "newTable",
             trigger_row.tgparentid::BIGINT AS "parentOid",
             function_row.proname AS "functionName"
      FROM pg_trigger trigger_row
      JOIN pg_class table_row ON table_row.oid = trigger_row.tgrelid
      JOIN pg_namespace namespace_row ON namespace_row.oid = table_row.relnamespace
      JOIN pg_proc function_row ON function_row.oid = trigger_row.tgfoid
      WHERE namespace_row.nspname = CURRENT_SCHEMA()
        AND table_row.relname = 'CommercialLeadInboxItem'
        AND trigger_row.tgname = 'CommercialLeadInboxItem_guard_row'
        AND NOT trigger_row.tgisinternal
    `),
    client.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
      SELECT COUNT(*)::BIGINT AS "count"
      FROM pg_constraint constraint_row
      JOIN pg_class table_row ON table_row.oid = constraint_row.conrelid
      JOIN pg_namespace namespace_row ON namespace_row.oid = table_row.relnamespace
      WHERE namespace_row.nspname = CURRENT_SCHEMA()
        AND table_row.relname = 'CommercialLeadInboxItem'
        AND constraint_row.conname IN (
          'CommercialLeadInboxItem_contract_v42_probe',
          'CommercialLeadInboxItem_contract_v43_probe'
        )
    `),
  ]);
  return {
    columns,
    constraints,
    guardHashes: guardHashes.map(({ hash }) => hash),
    triggers,
    probeCount: Number(probes[0]?.count),
  };
}

async function assertMigration43RolledBack(
  client: PrismaClient,
  before: PhysicalState,
) {
  const [after, finishedMigrationCount, targetFinishedRows] = await Promise.all([
    readPhysicalState(client),
    readFinishedMigrationCount(client),
    readTargetFinishedRows(client),
  ]);
  assert.deepEqual(after, before);
  assert.equal(finishedMigrationCount, 42);
  assert.equal(targetFinishedRows, 0);
  assert.equal(after.probeCount, 0);
}

async function readBusinessRows(client: PrismaClient) {
  const rows = await client.$queryRaw<Array<{
    policies: bigint;
    items: bigint;
    cycles: bigint;
    activities: bigint;
  }>>(Prisma.sql`
    SELECT
      (SELECT COUNT(*)::BIGINT FROM "CommercialLeadSlaPolicyVersion") AS "policies",
      (SELECT COUNT(*)::BIGINT FROM "CommercialLeadInboxItem") AS "items",
      (SELECT COUNT(*)::BIGINT FROM "CommercialLeadSlaCycle") AS "cycles",
      (SELECT COUNT(*)::BIGINT FROM "CommercialLeadActivity") AS "activities"
  `);
  return rows[0];
}

test.after(async () => {
  await rootDb?.$disconnect();
});

test('migration 43 source is one forward-only F1+F2 transaction with exact fail-closed gates', () => {
  const migration42 = readFileSync(migration42Path);
  const migration43 = readFileSync(migration43Path, 'utf8');
  const executableSql = migration43.replace(/^--.*$/gmu, '');
  assert.equal(createHash('sha256').update(migration42).digest('hex'), migration42Sha256);
  assert.equal((migration43.match(/^BEGIN;$/gmu) ?? []).length, 1);
  assert.equal((migration43.match(/^COMMIT;$/gmu) ?? []).length, 1);
  assert.equal((migration43.match(/^LOCK TABLE ONLY "CommercialLeadInboxItem" IN ACCESS EXCLUSIVE MODE;$/gmu) ?? []).length, 1);
  assert.match(migration43, /SET LOCAL lock_timeout = '2s'/u);
  assert.match(migration43, new RegExp(migration42Sha256, 'u'));
  assert.match(migration43, new RegExp(guard42ProsrcSha256, 'u'));
  assert.match(migration43, new RegExp(guard43ProsrcSha256, 'u'));
  assert.match(migration43, /CommercialLeadInboxItem_contract_v42_probe/u);
  assert.match(migration43, /CommercialLeadInboxItem_contract_v43_probe/u);
  assert.match(migration43, /VALIDATE CONSTRAINT "CommercialLeadInboxItem_contract_check"/u);
  assert.match(migration43, /ALTER COLUMN "sourceSystem" TYPE VARCHAR\(120\)/u);
  assert.match(migration43, /ALTER COLUMN "formCode" TYPE VARCHAR\(120\)/u);
  assert.match(migration43, /ALTER COLUMN "formVersion" TYPE VARCHAR\(80\)/u);
  assert.equal((migration43.match(/fai\.lead-event\.v1/gu) ?? []).length, 1);
  assert.doesNotMatch(migration43, /fai\.lead-submitted\.v1/u);
  assert.doesNotMatch(executableSql, /^\s*(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/imu);
  assert.doesNotMatch(executableSql, /\b(?:backfill|seed|activation)\b/iu);
});

test('fresh43 has exact provenance types, validated CHECK, corrected guard and zero business rows', {
  skip: !runDbTests,
  timeout: 360_000,
}, async () => {
  const names = migrationNames();
  assert.equal(names.length, 43);
  assert.equal(names[41], migration42Name);
  assert.equal(names[42], migration43Name);
  const fixture = await createFixture('fresh', names);
  let client: PrismaClient | null = null;
  try {
    deploy(fixture.databaseUrl, fixture.schemaPath);
    client = new PrismaClient({ datasources: { db: { url: fixture.databaseUrl } } });
    const [physical, migration42, migration43, businessRows] = await Promise.all([
      readPhysicalState(client),
      readMigrationRecord(client, migration42Name),
      readMigrationRecord(client, migration43Name),
      readBusinessRows(client),
    ]);
    assert.equal(await readFinishedMigrationCount(client), 43);
    assert.deepEqual(physical.columns, [
      { name: 'formCode', type: 'character varying(120)', notNull: true },
      { name: 'formVersion', type: 'character varying(80)', notNull: true },
      { name: 'sourceSystem', type: 'character varying(120)', notNull: true },
    ]);
    assert.equal(physical.constraints.length, 1);
    assert.equal(physical.constraints[0]?.validated, true);
    assert.match(physical.constraints[0]?.treeHash ?? '', /^[0-9a-f]{64}$/u);
    assert.deepEqual(physical.guardHashes, [guard43ProsrcSha256]);
    assert.deepEqual(physical.triggers, [{
      enabled: 'O',
      triggerType: 31,
      argumentCount: 0,
      columnNumbers: '',
      argumentBytes: 0,
      hasWhen: false,
      constraintOid: 0n,
      deferrable: false,
      initiallyDeferred: false,
      oldTable: null,
      newTable: null,
      parentOid: 0n,
      functionName: 'n14_guard_item',
    }]);
    assert.equal(physical.probeCount, 0);
    assert.deepEqual(businessRows, { policies: 0n, items: 0n, cycles: 0n, activities: 0n });
    assert.deepEqual(migration42, {
      checksum: migration42Sha256, finished: true, notRolledBack: true,
    });
    assert.deepEqual(migration43, {
      checksum: createHash('sha256').update(readFileSync(migration43Path)).digest('hex'),
      finished: true,
      notRolledBack: true,
    });
  } finally {
    await client?.$disconnect();
    await destroyFixture(fixture);
  }
});

test('exact 42 to 43 upgrade preserves a sentinel and the immutable finished migration 42 record', {
  skip: !runDbTests,
  timeout: 360_000,
}, async () => {
  const names = migrationNames();
  assert.equal(names.length, 43);
  const fixture = await createFixture('upgrade', names.slice(0, 42));
  const leadId = 'n13-n14-upgrade-sentinel-lead';
  const itemId = '00000000-0000-4000-8000-000000430001';
  let client: PrismaClient | null = null;
  try {
    deploy(fixture.databaseUrl, fixture.schemaPath);
    client = new PrismaClient({ datasources: { db: { url: fixture.databaseUrl } } });
    await client.lead.create({ data: {
      id: leadId,
      firstName: 'Migration',
      lastName: 'Sentinel',
      email: 'migration-sentinel@n13-n14.invalid',
      source: 'CRM',
      leadSource: 'manuale',
    } });
    await client.$executeRaw(Prisma.sql`
      INSERT INTO "CommercialLeadInboxItem" (
        "id", "leadId", "originKind", "sourceSystem", "formCode", "formVersion",
        "sourceOccurredAt", "initializedAt"
      ) VALUES (
        ${itemId}::UUID, ${leadId}, 'MANUAL_CRM', 'CRM', 'LEAD_CREATE_UI', 'n14-v1',
        '2026-08-26T12:00:00.000Z'::TIMESTAMPTZ, '2026-08-26T12:00:00.000Z'::TIMESTAMPTZ
      )
    `);
    const migration42Before = await readMigrationRecord(client, migration42Name);
    assert.deepEqual(migration42Before, {
      checksum: migration42Sha256, finished: true, notRolledBack: true,
    });
    assert.equal(await readFinishedMigrationCount(client), 42);
    await client.$disconnect();
    client = null;

    copyMigration(fixture, migration43Name);
    deploy(fixture.databaseUrl, fixture.schemaPath);
    client = new PrismaClient({ datasources: { db: { url: fixture.databaseUrl } } });
    const [migration42After, sentinelRows, physical] = await Promise.all([
      readMigrationRecord(client, migration42Name),
      client.$queryRaw<Array<{
        id: string;
        leadId: string;
        sourceSystem: string;
        formCode: string;
        formVersion: string;
        sourceOccurredAt: Date;
      }>>(Prisma.sql`
        SELECT "id", "leadId", "sourceSystem", "formCode", "formVersion", "sourceOccurredAt"
        FROM "CommercialLeadInboxItem"
        WHERE "id" = ${itemId}::UUID
      `),
      readPhysicalState(client),
    ]);
    assert.equal(await readFinishedMigrationCount(client), 43);
    assert.deepEqual(migration42After, migration42Before);
    assert.deepEqual(sentinelRows, [{
      id: itemId,
      leadId,
      sourceSystem: 'CRM',
      formCode: 'LEAD_CREATE_UI',
      formVersion: 'n14-v1',
      sourceOccurredAt: new Date('2026-08-26T12:00:00.000Z'),
    }]);
    assert.deepEqual(physical.columns, [
      { name: 'formCode', type: 'character varying(120)', notNull: true },
      { name: 'formVersion', type: 'character varying(80)', notNull: true },
      { name: 'sourceSystem', type: 'character varying(120)', notNull: true },
    ]);
    assert.equal(physical.constraints[0]?.validated, true);
    assert.deepEqual(physical.guardHashes, [guard43ProsrcSha256]);
    assert.equal(physical.probeCount, 0);
  } finally {
    await client?.$disconnect();
    await destroyFixture(fixture);
  }
});

test('a drifted v42 guard blocks migration 43 and rolls back every physical change', {
  skip: !runDbTests,
  timeout: 360_000,
}, async () => {
  const names = migrationNames();
  const fixture = await createFixture('drift', names.slice(0, 42));
  let client: PrismaClient | null = null;
  try {
    deploy(fixture.databaseUrl, fixture.schemaPath);
    client = new PrismaClient({ datasources: { db: { url: fixture.databaseUrl } } });
    await client.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION "n14_guard_item"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM 'fai.lead-submitted.v1';
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END $$
    `);
    const before = await readPhysicalState(client);
    assert.notDeepEqual(before.guardHashes, [guard42ProsrcSha256]);
    await client.$disconnect();
    client = null;

    let scriptFailure: unknown;
    try {
      executeMigrationScript(fixture.databaseUrl, fixture.schemaPath);
    } catch (error) {
      scriptFailure = error;
    }
    assert.ok(scriptFailure);
    assert.match(commandFailureText(scriptFailure), /N13_N14_ATTRIBUTION_GUARD_DRIFT/u);

    client = new PrismaClient({ datasources: { db: { url: fixture.databaseUrl } } });
    await assertMigration43RolledBack(client, before);
    await client.$disconnect();
    client = null;

    copyMigration(fixture, migration43Name);
    let migrationFailure: unknown;
    try {
      deploy(fixture.databaseUrl, fixture.schemaPath);
    } catch (error) {
      migrationFailure = error;
    }
    assert.ok(migrationFailure);

    client = new PrismaClient({ datasources: { db: { url: fixture.databaseUrl } } });
    await assertMigration43RolledBack(client, before);
  } finally {
    await client?.$disconnect();
    await destroyFixture(fixture);
  }
});

test('a v42 trigger neutralized with WHEN false blocks migration 43 without partial DDL', {
  skip: !runDbTests,
  timeout: 360_000,
}, async () => {
  const names = migrationNames();
  const fixture = await createFixture('trigger_drift', names.slice(0, 42));
  let client: PrismaClient | null = null;
  try {
    deploy(fixture.databaseUrl, fixture.schemaPath);
    client = new PrismaClient({ datasources: { db: { url: fixture.databaseUrl } } });
    await client.$executeRawUnsafe(
      'DROP TRIGGER "CommercialLeadInboxItem_guard_row" ON "CommercialLeadInboxItem"',
    );
    await client.$executeRawUnsafe(`
      CREATE TRIGGER "CommercialLeadInboxItem_guard_row"
      BEFORE INSERT OR UPDATE OR DELETE ON "CommercialLeadInboxItem"
      FOR EACH ROW WHEN (FALSE)
      EXECUTE FUNCTION "n14_guard_item"()
    `);
    const before = await readPhysicalState(client);
    assert.equal(before.triggers.length, 1);
    assert.equal(before.triggers[0]?.hasWhen, true);
    assert.equal(before.triggers[0]?.triggerType, 31);
    assert.equal(before.triggers[0]?.functionName, 'n14_guard_item');
    await client.$disconnect();
    client = null;

    let scriptFailure: unknown;
    try {
      executeMigrationScript(fixture.databaseUrl, fixture.schemaPath);
    } catch (error) {
      scriptFailure = error;
    }
    assert.ok(scriptFailure);
    assert.match(commandFailureText(scriptFailure), /N13_N14_ATTRIBUTION_TRIGGER_DRIFT/u);

    client = new PrismaClient({ datasources: { db: { url: fixture.databaseUrl } } });
    await assertMigration43RolledBack(client, before);
    await client.$disconnect();
    client = null;

    copyMigration(fixture, migration43Name);
    let migrationFailure: unknown;
    try {
      deploy(fixture.databaseUrl, fixture.schemaPath);
    } catch (error) {
      migrationFailure = error;
    }
    assert.ok(migrationFailure);

    client = new PrismaClient({ datasources: { db: { url: fixture.databaseUrl } } });
    await assertMigration43RolledBack(client, before);
  } finally {
    await client?.$disconnect();
    await destroyFixture(fixture);
  }
});

test('migration 43 lock contention times out promptly and leaves the canonical v42 state unchanged', {
  skip: !runDbTests,
  timeout: 360_000,
}, async () => {
  const names = migrationNames();
  const fixture = await createFixture('lock', names.slice(0, 42));
  let observer: PrismaClient | null = null;
  let holder: PrismaClient | null = null;
  try {
    deploy(fixture.databaseUrl, fixture.schemaPath);
    observer = new PrismaClient({ datasources: { db: { url: fixture.databaseUrl } } });
    holder = new PrismaClient({ datasources: { db: { url: fixture.databaseUrl } } });
    const before = await readPhysicalState(observer);
    assert.deepEqual(before.guardHashes, [guard42ProsrcSha256]);
    copyMigration(fixture, migration43Name);

    let releaseLock = () => {};
    let lockReadyResolve = () => {};
    let lockReadyReject: (error: unknown) => void = () => {};
    const lockRelease = new Promise<void>((resolveRelease) => {
      releaseLock = resolveRelease;
    });
    const lockReady = new Promise<void>((resolveReady, rejectReady) => {
      lockReadyResolve = resolveReady;
      lockReadyReject = rejectReady;
    });
    const heldLock = holder.$transaction(async (tx) => {
      try {
        await tx.$executeRawUnsafe(
          'LOCK TABLE ONLY "CommercialLeadInboxItem" IN ACCESS SHARE MODE',
        );
        lockReadyResolve();
        await lockRelease;
      } catch (error) {
        lockReadyReject(error);
        throw error;
      }
    }, { timeout: 60_000 });
    void heldLock.catch(() => undefined);
    await lockReady;

    let scriptFailure: unknown;
    let migrationFailure: unknown;
    let scriptElapsedMilliseconds = 0;
    let migrationElapsedMilliseconds = 0;
    try {
      const scriptStartedAt = Date.now();
      try {
        executeMigrationScript(fixture.databaseUrl, fixture.schemaPath);
      } catch (error) {
        scriptFailure = error;
      }
      scriptElapsedMilliseconds = Date.now() - scriptStartedAt;
      assert.ok(scriptFailure);
      assert.match(commandFailureText(scriptFailure), /lock timeout|55P03/iu);
      assert.ok(
        scriptElapsedMilliseconds >= 1_500 && scriptElapsedMilliseconds < 15_000,
        `db execute lock timeout outside bounds: ${scriptElapsedMilliseconds}ms`,
      );
      await assertMigration43RolledBack(observer, before);

      const migrationStartedAt = Date.now();
      try {
        deploy(fixture.databaseUrl, fixture.schemaPath);
      } catch (error) {
        migrationFailure = error;
      }
      migrationElapsedMilliseconds = Date.now() - migrationStartedAt;
    } finally {
      releaseLock();
      await heldLock;
    }
    assert.ok(migrationFailure);
    assert.ok(
      migrationElapsedMilliseconds >= 1_500 && migrationElapsedMilliseconds < 15_000,
      `migrate deploy lock timeout outside bounds: ${migrationElapsedMilliseconds}ms`,
    );

    await assertMigration43RolledBack(observer, before);
  } finally {
    await observer?.$disconnect();
    await holder?.$disconnect();
    await destroyFixture(fixture);
  }
});
