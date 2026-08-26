import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test, { after, before, beforeEach } from 'node:test';
import { NextRequest } from 'next/server';
import { Prisma, PrismaClient } from '@prisma/client';
import { handleSecureLeadGatewayRequest } from '../../src/app/api/integrations/website/leads/v2/route';
import { canonicalJson } from '../../src/lib/canonical-json';
import {
  createLeadSubmittedEventV1,
  type LeadSubmittedEventV1,
} from '../../src/lib/lead-event-contract';
import {
  consumeSecureLeadGatewayRateLimit,
} from '../../src/lib/secure-lead-gateway';
import {
  createSecureLeadGatewaySignature,
  createSecureLeadGatewaySignedBytes,
  digestSecureLeadGatewayKey,
  SECURE_LEAD_GATEWAY_PROTOCOL,
  SecureLeadGatewayDeadline,
} from '../../src/lib/secure-lead-gateway-protocol';
import { syntheticLeadEventInputV1 } from '../fixtures/n10-lead-event-v1';
import {
  N12_SYNTHETIC_KEY_ID,
  N12_SYNTHETIC_NONCE,
  N12_SYNTHETIC_PRODUCER_CODE,
  N12_SYNTHETIC_SECRET,
} from '../fixtures/n12-secure-lead-gateway-v2';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from './ai-orchestrator-db-test-guard';

const runDbTests = process.env.RUN_DB_TESTS === '1';
const db = new PrismaClient();
const migrationName = '20260821120000_secure_lead_gateway_v2';
const migrationPath = `prisma/migrations/${migrationName}/migration.sql`;
const execFileAsync = promisify(execFile);
const environment = Object.freeze({
  SECURE_LEAD_GATEWAY_MODE: 'enforced',
  FEATURE_INTEGRATIONS_ENABLED: 'true',
});

interface TestKey {
  readonly id: string;
  readonly keyId: string;
  readonly producerCode: string;
  readonly version: number;
  readonly secret: Buffer;
}

interface PreparedRequest {
  readonly body: Buffer;
  readonly keyId: string;
  readonly timestamp: string;
  readonly nonce: string;
  readonly signature: string;
  readonly contentType: string;
  readonly contentLength: string;
  readonly path: string;
}

let keyringRoot = '';
let keyringPath = '';
let primaryKey: TestKey;

function uuid(ordinal: number) {
  return `00000000-0000-4000-8000-${ordinal.toString(16).padStart(12, '0')}`;
}

function syntheticEvent(ordinal: number): LeadSubmittedEventV1 {
  const input = syntheticLeadEventInputV1();
  return createLeadSubmittedEventV1({
    ...input,
    eventId: uuid(90_000 + ordinal * 2),
    businessCorrelationId: uuid(90_001 + ordinal * 2),
    source: { ...input.source, submissionId: `N12-DB-${ordinal}` },
    payload: {
      ...input.payload,
      email: `synthetic-${ordinal}@n12.invalid`,
      message: `Synthetic-only N12 DB event ${ordinal}.`,
    },
  });
}

function writeKeyring(keys: readonly TestKey[]) {
  writeFileSync(keyringPath, JSON.stringify({
    version: 1,
    keys: keys.map((key) => ({
      keyId: key.keyId,
      secretBase64: key.secret.toString('base64'),
    })),
  }), { mode: 0o600 });
}

async function provisionKey(input: {
  readonly keyId: string;
  readonly producerCode: string;
  readonly version: number;
  readonly secret: Buffer;
  readonly activate?: boolean;
}) {
  const key: TestKey = Object.freeze({ id: randomUUID(), ...input });
  await db.secureLeadGatewayKeyVersion.create({
    data: {
      id: key.id,
      producerCode: key.producerCode,
      keyId: key.keyId,
      version: key.version,
      secretDigest: digestSecureLeadGatewayKey(key.secret),
      status: 'STAGED',
      acceptFrom: new Date(Date.now() - 60_000),
    },
  });
  if (input.activate !== false) {
    await db.$executeRaw(Prisma.sql`
      UPDATE "SecureLeadGatewayKeyVersion"
      SET "status" = 'ACTIVE'
      WHERE "id" = ${key.id}::UUID
    `);
  }
  return key;
}

async function cleanGatewayAndN11() {
  const tables = [
    'LeadIdentityKey',
    'LeadDuplicateDecision',
    'LeadDuplicateCandidate',
    'LeadDuplicateCase',
    'LeadProjectionLedger',
    'LeadIdentityKeyVersion',
    'PrivacyEvidenceReceipt',
    'SecureLeadGatewayRequest',
    'SecureLeadGatewayReceipt',
    'SecureLeadGatewayRateLimitBucket',
    'SecureLeadGatewayKeyVersion',
    'BusinessQueueAttempt',
    'BusinessOutboxEvent',
    'BusinessInboxEvent',
  ];
  for (const table of tables) {
    await db.$executeRawUnsafe(`ALTER TABLE "${table}" DISABLE TRIGGER USER`);
  }
  try {
    await db.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((table) => `"${table}"`).join(', ')}`);
  } finally {
    for (const table of [...tables].reverse()) {
      await db.$executeRawUnsafe(`ALTER TABLE "${table}" ENABLE TRIGGER USER`);
    }
  }
}

async function counts() {
  const [keys, rates, receipts, requests, inbox, outbox, attempts] = await Promise.all([
    db.secureLeadGatewayKeyVersion.count(),
    db.secureLeadGatewayRateLimitBucket.count(),
    db.secureLeadGatewayReceipt.count(),
    db.secureLeadGatewayRequest.count(),
    db.businessInboxEvent.count(),
    db.businessOutboxEvent.count(),
    db.businessQueueAttempt.count(),
  ]);
  return { keys, rates, receipts, requests, inbox, outbox, attempts };
}

function prepareRequest(
  event: LeadSubmittedEventV1,
  nonce: string,
  key: TestKey = primaryKey,
  overrides: Partial<Pick<
    PreparedRequest,
    'body' | 'timestamp' | 'signature' | 'contentType' | 'contentLength' | 'path'
  >> = {},
): PreparedRequest {
  const body = overrides.body ?? Buffer.from(canonicalJson(event), 'utf8');
  const timestamp = overrides.timestamp ?? String(Math.trunc(Date.now() / 1_000));
  const signedBytes = createSecureLeadGatewaySignedBytes({
    keyId: key.keyId,
    timestamp,
    nonce,
  }, body);
  return Object.freeze({
    body,
    keyId: key.keyId,
    timestamp,
    nonce,
    signature: overrides.signature
      ?? createSecureLeadGatewaySignature(key.secret, signedBytes),
    contentType: overrides.contentType ?? SECURE_LEAD_GATEWAY_PROTOCOL.contentType,
    contentLength: overrides.contentLength ?? String(body.byteLength),
    path: overrides.path ?? SECURE_LEAD_GATEWAY_PROTOCOL.path,
  });
}

function requestFrom(prepared: PreparedRequest) {
  return new NextRequest(`http://local${prepared.path}`, {
    method: 'POST',
    headers: {
      'content-type': prepared.contentType,
      'content-length': prepared.contentLength,
      'x-fai-key-id': prepared.keyId,
      'x-fai-timestamp': prepared.timestamp,
      'x-fai-nonce': prepared.nonce,
      'x-fai-signature': prepared.signature,
    },
    body: prepared.body,
    duplex: 'half',
  } as unknown as ConstructorParameters<typeof NextRequest>[1]);
}

function invoke(prepared: PreparedRequest, mode: 'shadow' | 'enforced' = 'enforced') {
  return handleSecureLeadGatewayRequest(requestFrom(prepared), {
    db,
    environment: { ...environment, SECURE_LEAD_GATEWAY_MODE: mode },
    keyringPath,
    allowedKeyringRoot: keyringRoot,
  });
}

before(async () => {
  if (!runDbTests) return;
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  keyringRoot = mkdtempSync(join(tmpdir(), 'n12-db-keyring-'));
  keyringPath = join(keyringRoot, 'synthetic-keyring.json');
  await db.applicationFeatureGate.update({
    where: { code: 'INTEGRATIONS' },
    data: { enabled: true, updatedById: null },
  });
});

beforeEach(async () => {
  if (!runDbTests) return;
  await cleanGatewayAndN11();
  primaryKey = await provisionKey({
    keyId: N12_SYNTHETIC_KEY_ID,
    producerCode: N12_SYNTHETIC_PRODUCER_CODE,
    version: 1,
    secret: N12_SYNTHETIC_SECRET,
  });
  writeKeyring([primaryKey]);
});

after(async () => {
  if (runDbTests) {
    await cleanGatewayAndN11();
    await db.applicationFeatureGate.update({
      where: { code: 'INTEGRATIONS' },
      data: { enabled: false, updatedById: null },
    });
    rmSync(keyringRoot, { recursive: true, force: true });
  }
  await db.$disconnect();
});

test('N12 migration 39 is atomic, additive, empty and dedicated', () => {
  const names = readdirSync('prisma/migrations').filter((name) => /^\d/u.test(name)).sort();
  assert.equal(names.length, 43);
  assert.equal(names[38], migrationName);
  const migration = readFileSync(migrationPath, 'utf8');
  const executable = migration.replace(/^--.*$/gmu, '');
  assert.match(executable, /^\s*BEGIN;\s/u);
  assert.match(executable, /COMMIT;\s*$/u);
  for (const table of [
    'SecureLeadGatewayKeyVersion',
    'SecureLeadGatewayRateLimitBucket',
    'SecureLeadGatewayReceipt',
    'SecureLeadGatewayRequest',
  ]) assert.match(migration, new RegExp(`CREATE TABLE "${table}"`));
  assert.doesNotMatch(executable, /^\s*(?:INSERT\s+INTO|DELETE\s+FROM|UPDATE\s+")/gimu);
  assert.doesNotMatch(executable, /WebsiteLeadReceipt|WebsiteLeadRateLimitBucket|ApplicationKeyVersion/);
  assert.doesNotMatch(executable, /ApplicationFeatureGate|\bLead\b|backfill|seed|CREATE\s+(?:EXTENSION|EVENT|SCHEDULE)/iu);
});

async function qualifyMigration(upgrade: boolean) {
  const sourceUrl = process.env.DATABASE_URL;
  assert.ok(sourceUrl);
  const schema = `n12_${upgrade ? 'upgrade' : 'fresh'}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const root = mkdtempSync(join(tmpdir(), 'n12-migrations-'));
  const prismaDir = join(root, 'prisma');
  const migrationsDir = join(prismaDir, 'migrations');
  mkdirSync(migrationsDir, { recursive: true });
  cpSync('prisma/schema.prisma', join(prismaDir, 'schema.prisma'));
  const names = readdirSync('prisma/migrations').filter((name) => /^\d/u.test(name)).sort().slice(0, 39);
  const url = new URL(sourceUrl);
  url.searchParams.set('schema', schema);
  await db.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  const deploy = () => execFileSync(
    resolve('node_modules/.bin/prisma'),
    ['migrate', 'deploy', '--schema', join(prismaDir, 'schema.prisma')],
    { env: { ...process.env, DATABASE_URL: url.toString() }, stdio: 'pipe', timeout: 120_000 },
  );
  try {
    for (const name of upgrade ? names.slice(0, 38) : names) {
      cpSync(join('prisma/migrations', name), join(migrationsDir, name), { recursive: true });
    }
    deploy();
    if (upgrade) {
      cpSync(join('prisma/migrations', names[38]), join(migrationsDir, names[38]), {
        recursive: true,
      });
      deploy();
    }
    const client = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    try {
      const [migrations, catalog, triggers, functions, rows] = await Promise.all([
        client.$queryRaw<Array<{ count: bigint }>>`
          SELECT COUNT(*)::BIGINT AS "count" FROM "_prisma_migrations"
          WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
        `,
        client.$queryRaw<Array<{
          tables: bigint;
          indexes: bigint;
          constraints: bigint;
        }>>(Prisma.sql`
          SELECT
            (SELECT COUNT(*)::BIGINT FROM information_schema.tables
              WHERE table_schema = ${schema} AND table_name LIKE 'SecureLeadGateway%') AS "tables",
            (SELECT COUNT(*)::BIGINT FROM pg_indexes
              WHERE schemaname = ${schema} AND tablename LIKE 'SecureLeadGateway%') AS "indexes",
            (SELECT COUNT(*)::BIGINT FROM information_schema.table_constraints
              WHERE table_schema = ${schema}
                AND table_name LIKE 'SecureLeadGateway%'
                AND constraint_name LIKE 'SecureLeadGateway%') AS "constraints"
        `),
        client.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
          SELECT COUNT(*)::BIGINT AS "count"
          FROM pg_catalog.pg_trigger trigger_row
          JOIN pg_catalog.pg_class relation ON relation.oid = trigger_row.tgrelid
          JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = ${schema}
            AND relation.relname LIKE 'SecureLeadGateway%'
            AND NOT trigger_row.tgisinternal
        `),
        client.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
          SELECT COUNT(*)::BIGINT AS "count"
          FROM pg_catalog.pg_proc function_row
          JOIN pg_catalog.pg_namespace namespace ON namespace.oid = function_row.pronamespace
          WHERE namespace.nspname = ${schema}
            AND function_row.proname LIKE 'fai_secure_lead_gateway_%'
        `),
        client.$queryRaw<Array<{ count: bigint }>>`
          SELECT (
            (SELECT COUNT(*) FROM "SecureLeadGatewayKeyVersion")
            + (SELECT COUNT(*) FROM "SecureLeadGatewayRateLimitBucket")
            + (SELECT COUNT(*) FROM "SecureLeadGatewayReceipt")
            + (SELECT COUNT(*) FROM "SecureLeadGatewayRequest")
          )::BIGINT AS "count"
        `,
      ]);
      return {
        migrations: Number(migrations[0]?.count),
        tables: Number(catalog[0]?.tables),
        indexes: Number(catalog[0]?.indexes),
        constraints: Number(catalog[0]?.constraints),
        triggers: Number(triggers[0]?.count),
        functions: Number(functions[0]?.count),
        rows: Number(rows[0]?.count),
      };
    } finally {
      await client.$disconnect();
    }
  } finally {
    await db.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    rmSync(root, { recursive: true, force: true });
  }
}

test('N12 migration qualifies fresh 39 and additive 38 to 39 upgrade', {
  skip: !runDbTests,
  timeout: 300_000,
}, async () => {
  const expected = {
    migrations: 39,
    tables: 4,
    indexes: 15,
    constraints: 13,
    triggers: 8,
    functions: 4,
    rows: 0,
  };
  assert.deepEqual(await qualifyMigration(false), expected);
  assert.deepEqual(await qualifyMigration(true), expected);
});

test('N12 shadow verifies the protocol but performs no rate, replay or N11 write', {
  skip: !runDbTests,
}, async () => {
  const result = await invoke(
    prepareRequest(syntheticEvent(1), N12_SYNTHETIC_NONCE),
    'shadow',
  );
  assert.equal(result.status, 503);
  assert.deepEqual(await counts(), {
    keys: 1, rates: 0, receipts: 0, requests: 0, inbox: 0, outbox: 0, attempts: 0,
  });
});

test('N12 NEW and exact replay return one opaque receipt without legacy, Lead or N11 worker effects', {
  skip: !runDbTests,
}, async () => {
  const baseline = await Promise.all([
    db.lead.count(),
    db.websiteLeadReceipt.count(),
    db.websiteLeadRateLimitBucket.count(),
    db.auditLog.count(),
  ]);
  const prepared = prepareRequest(syntheticEvent(2), N12_SYNTHETIC_NONCE);
  const first = await invoke(prepared);
  const replay = await invoke(prepared);
  assert.deepEqual([first.status, replay.status], [202, 202]);
  const firstBody = await first.json();
  const replayBody = await replay.json();
  assert.deepEqual(firstBody, replayBody);
  assert.match(firstBody.receipt, /^slg2_[0-9a-f]{32}$/);
  assert.deepEqual(await counts(), {
    keys: 1, rates: 1, receipts: 1, requests: 1, inbox: 1, outbox: 0, attempts: 0,
  });
  assert.deepEqual(await Promise.all([
    db.lead.count(),
    db.websiteLeadReceipt.count(),
    db.websiteLeadRateLimitBucket.count(),
    db.auditLog.count(),
  ]), baseline);
});

test('N12 nonce replay matrix distinguishes same fingerprint and divergent fingerprint', {
  skip: !runDbTests,
}, async () => {
  const timestamp = String(Math.trunc(Date.now() / 1_000));
  const first = prepareRequest(syntheticEvent(3), N12_SYNTHETIC_NONCE, primaryKey, { timestamp });
  const changed = prepareRequest(syntheticEvent(4), N12_SYNTHETIC_NONCE, primaryKey, { timestamp });
  assert.equal((await invoke(first)).status, 202);
  const conflict = await invoke(changed);
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), { ok: false, error: 'CONFLICT' });
  assert.deepEqual(await counts(), {
    keys: 1, rates: 1, receipts: 1, requests: 1, inbox: 1, outbox: 0, attempts: 0,
  });
});

test('N12 different nonces for one N10 event converge on one inbox row and one receipt', {
  skip: !runDbTests,
}, async () => {
  const event = syntheticEvent(5);
  const responses = await Promise.all([
    invoke(prepareRequest(event, '1'.padStart(32, '0'))),
    invoke(prepareRequest(event, '2'.padStart(32, '0'))),
  ]);
  assert.deepEqual(responses.map(({ status }) => status), [202, 202]);
  const bodies = await Promise.all(responses.map((response) => response.json()));
  assert.equal(bodies[0].receipt, bodies[1].receipt);
  assert.deepEqual(await counts(), {
    keys: 1, rates: 1, receipts: 1, requests: 2, inbox: 1, outbox: 0, attempts: 0,
  });
});

test('N12 maps N11 business idempotency conflict to 409 and rolls back candidate security state', {
  skip: !runDbTests,
}, async () => {
  const input = syntheticLeadEventInputV1();
  const source = { ...input.source, submissionId: 'N12-DB-N11-CONFLICT' };
  const original = createLeadSubmittedEventV1({
    ...input,
    eventId: uuid(91_000),
    businessCorrelationId: uuid(91_001),
    source,
    payload: { ...input.payload, email: 'conflict-a@n12.invalid' },
  });
  const divergent = createLeadSubmittedEventV1({
    ...input,
    eventId: uuid(91_002),
    businessCorrelationId: uuid(91_003),
    source,
    payload: {
      ...input.payload,
      email: 'conflict-b@n12.invalid',
      message: 'Synthetic divergent N12 business payload.',
    },
  });
  assert.equal((await invoke(prepareRequest(original, '3'.padStart(32, '0')))).status, 202);
  assert.equal((await invoke(prepareRequest(divergent, '4'.padStart(32, '0')))).status, 409);
  assert.deepEqual(await counts(), {
    keys: 1, rates: 1, receipts: 1, requests: 1, inbox: 1, outbox: 0, attempts: 0,
  });
});

test('N12 authentication/media/body failures are redacted and authenticated invalid N10 consumes quota', {
  skip: !runDbTests,
}, async () => {
  const event = syntheticEvent(6);
  const badMedia = prepareRequest(event, '5'.padStart(32, '0'), primaryKey, {
    contentType: 'application/json',
  });
  const badSignature = prepareRequest(event, '6'.padStart(32, '0'), primaryKey, {
    signature: `v1=${'0'.repeat(64)}`,
  });
  const stale = prepareRequest(event, '7'.padStart(32, '0'), primaryKey, {
    timestamp: String(Math.trunc(Date.now() / 1_000) - 301),
  });
  const oversizedBody = Buffer.alloc(SECURE_LEAD_GATEWAY_PROTOCOL.maximumBodyBytes + 1, 0x61);
  const oversized = prepareRequest(event, '8'.padStart(32, '0'), primaryKey, {
    body: oversizedBody,
  });
  const invalidN10 = prepareRequest(event, '9'.padStart(32, '0'), primaryKey, {
    body: Buffer.from('{}'),
  });
  const responses = [
    await invoke(badMedia),
    await invoke(badSignature),
    await invoke(stale),
    await invoke(oversized),
    await invoke(invalidN10),
  ];
  assert.deepEqual(responses.map(({ status }) => status), [400, 401, 401, 413, 400]);
  const bodies = await Promise.all(responses.map((response) => response.json()));
  assert.deepEqual(bodies, [
    { ok: false, error: 'INVALID_REQUEST' },
    { ok: false, error: 'UNAUTHORIZED' },
    { ok: false, error: 'UNAUTHORIZED' },
    { ok: false, error: 'INVALID_REQUEST' },
    { ok: false, error: 'INVALID_REQUEST' },
  ]);
  for (const response of responses) {
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('pragma'), 'no-cache');
  }
  assert.deepEqual(await counts(), {
    keys: 1, rates: 1, receipts: 0, requests: 0, inbox: 0, outbox: 0, attempts: 0,
  });
});

test('N12 GCRA admits burst ten atomically, denies the eleventh and keeps Retry-After bounded', {
  skip: !runDbTests,
  timeout: 30_000,
}, async () => {
  const results = await Promise.all(Array.from({ length: 11 }, () => (
    consumeSecureLeadGatewayRateLimit(
      db,
      N12_SYNTHETIC_PRODUCER_CODE,
      new SecureLeadGatewayDeadline(),
    )
  )));
  assert.equal(results.filter(({ allowed }) => allowed).length, 10);
  const denied = results.filter(({ allowed }) => !allowed);
  assert.equal(denied.length, 1);
  assert.ok((denied[0].retryAfter ?? 0) >= 1 && (denied[0].retryAfter ?? 61) <= 60);
  assert.equal(await db.secureLeadGatewayRateLimitBucket.count(), 1);
});

test('N12 rotation overlap accepts one ACTIVE plus one RETIRING key with one producer quota', {
  skip: !runDbTests,
}, async () => {
  await db.$executeRaw(Prisma.sql`
    UPDATE "SecureLeadGatewayKeyVersion"
    SET "status" = 'RETIRING',
      "acceptUntil" = DATE_TRUNC('milliseconds', clock_timestamp() + INTERVAL '899 seconds')
    WHERE "id" = ${primaryKey.id}::UUID
  `);
  const secondary = await provisionKey({
    keyId: 'synthetic-wordpress-v2',
    producerCode: primaryKey.producerCode,
    version: 2,
    secret: Buffer.alloc(32, 0x22),
  });
  writeKeyring([primaryKey, secondary]);
  const responses = await Promise.all([
    invoke(prepareRequest(syntheticEvent(20), 'a'.padStart(32, '0'), primaryKey)),
    invoke(prepareRequest(syntheticEvent(21), 'b'.padStart(32, '0'), secondary)),
  ]);
  assert.deepEqual(responses.map(({ status }) => status), [202, 202]);
  assert.deepEqual(await counts(), {
    keys: 2, rates: 1, receipts: 2, requests: 2, inbox: 2, outbox: 0, attempts: 0,
  });
  const statuses = await db.secureLeadGatewayKeyVersion.findMany({
    orderBy: { version: 'asc' },
    select: { status: true },
  });
  assert.deepEqual(statuses.map(({ status }) => status), ['RETIRING', 'ACTIVE']);
});

test('N12 key lifecycle and unique partial indexes reject invalid concurrent ownership', {
  skip: !runDbTests,
}, async () => {
  for (const [ordinal, status] of ['ACTIVE', 'RETIRING'].entries()) {
    await assert.rejects(db.secureLeadGatewayKeyVersion.create({
      data: {
        id: randomUUID(),
        producerCode: `SYNTHETIC_DIRECT_${ordinal}`,
        keyId: `synthetic-direct-${ordinal}`,
        version: 1,
        secretDigest: digestSecureLeadGatewayKey(Buffer.alloc(32, 0x40 + ordinal)),
        status,
        acceptFrom: new Date(Date.now() - 60_000),
        acceptUntil: status === 'RETIRING' ? new Date(Date.now() + 3_600_000) : null,
      },
    }));
  }
  const secondary = await provisionKey({
    keyId: 'synthetic-staged-v2',
    producerCode: primaryKey.producerCode,
    version: 2,
    secret: Buffer.alloc(32, 0x33),
    activate: false,
  });
  await assert.rejects(db.$executeRaw(Prisma.sql`
    UPDATE "SecureLeadGatewayKeyVersion" SET "status" = 'ACTIVE'
    WHERE "id" = ${secondary.id}::UUID
  `));
  await assert.rejects(db.$executeRaw(Prisma.sql`
    UPDATE "SecureLeadGatewayKeyVersion"
    SET "status" = 'RETIRING',
      "acceptUntil" = clock_timestamp() + INTERVAL '901 seconds'
    WHERE "id" = ${primaryKey.id}::UUID
  `));
  await assert.rejects(db.secureLeadGatewayKeyVersion.update({
    where: { id: primaryKey.id },
    data: { keyId: 'mutated-key-id' },
  }));
});

test('N12 immutable receipts/requests and monotonic rate state are database-enforced', {
  skip: !runDbTests,
}, async () => {
  assert.equal((await invoke(prepareRequest(syntheticEvent(30), 'c'.padStart(32, '0')))).status, 202);
  const receipt = await db.secureLeadGatewayReceipt.findFirstOrThrow();
  const request = await db.secureLeadGatewayRequest.findFirstOrThrow();
  const bucket = await db.secureLeadGatewayRateLimitBucket.findFirstOrThrow();
  await assert.rejects(db.secureLeadGatewayReceipt.update({
    where: { id: receipt.id },
    data: { retentionPolicyVersion: 'MUTATED' },
  }));
  await assert.rejects(db.secureLeadGatewayRequest.delete({ where: { id: request.id } }));
  await assert.rejects(db.secureLeadGatewayRateLimitBucket.update({
    where: { producerCode: bucket.producerCode },
    data: { theoreticalArrivalAt: new Date(bucket.theoreticalArrivalAt.getTime() - 1) },
  }));
  await assert.rejects(db.$executeRawUnsafe('TRUNCATE TABLE "SecureLeadGatewayReceipt"'));
});

test('N12 fault after N11 admission rolls back inbox/receipt/request but preserves committed quota', {
  skip: !runDbTests,
}, async () => {
  await db.$executeRawUnsafe(`
    CREATE FUNCTION n12_fail_request_insert() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'N12_SYNTHETIC_REQUEST_FAILURE'; END $$
  `);
  await db.$executeRawUnsafe(`
    CREATE TRIGGER n12_fail_request_insert
    BEFORE INSERT ON "SecureLeadGatewayRequest"
    FOR EACH ROW EXECUTE FUNCTION n12_fail_request_insert()
  `);
  try {
    const response = await invoke(prepareRequest(syntheticEvent(40), 'd'.padStart(32, '0')));
    assert.equal(response.status, 503);
    assert.deepEqual(await counts(), {
      keys: 1, rates: 1, receipts: 0, requests: 0, inbox: 0, outbox: 0, attempts: 0,
    });
  } finally {
    await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS n12_fail_request_insert ON "SecureLeadGatewayRequest"');
    await db.$executeRawUnsafe('DROP FUNCTION IF EXISTS n12_fail_request_insert()');
  }
});

test('N12 final FOR SHARE revalidation fails closed when revocation wins the race', {
  skip: !runDbTests,
  timeout: 30_000,
}, async () => {
  let markLocked!: () => void;
  let releaseLock!: () => void;
  const locked = new Promise<void>((resolveLocked) => { markLocked = resolveLocked; });
  const release = new Promise<void>((resolveRelease) => { releaseLock = resolveRelease; });
  const revocation = db.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`
      SELECT "id" FROM "SecureLeadGatewayKeyVersion"
      WHERE "id" = ${primaryKey.id}::UUID FOR UPDATE
    `);
    markLocked();
    await release;
    await tx.$executeRaw(Prisma.sql`
      UPDATE "SecureLeadGatewayKeyVersion"
      SET "status" = 'REVOKED',
        "revokedAt" = DATE_TRUNC('milliseconds', clock_timestamp())
      WHERE "id" = ${primaryKey.id}::UUID
    `);
  });
  await locked;
  const pending = invoke(prepareRequest(syntheticEvent(50), 'e'.padStart(32, '0')));
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  releaseLock();
  const [, response] = await Promise.all([revocation, pending]);
  assert.equal(response.status, 401);
  assert.deepEqual(await counts(), {
    keys: 1, rates: 1, receipts: 0, requests: 0, inbox: 0, outbox: 0, attempts: 0,
  });
});

test('N12 key digest corruption is configuration failure and never reaches quota or N11', {
  skip: !runDbTests,
}, async () => {
  await db.$executeRawUnsafe(
    'ALTER TABLE "SecureLeadGatewayKeyVersion" DISABLE TRIGGER "SecureLeadGatewayKeyVersion_guard_v1"',
  );
  try {
    await db.secureLeadGatewayKeyVersion.update({
      where: { id: primaryKey.id },
      data: { secretDigest: '0'.repeat(64) },
    });
  } finally {
    await db.$executeRawUnsafe(
      'ALTER TABLE "SecureLeadGatewayKeyVersion" ENABLE TRIGGER "SecureLeadGatewayKeyVersion_guard_v1"',
    );
  }
  const prepared = prepareRequest(syntheticEvent(60), 'f'.padStart(32, '0'));
  assert.equal((await invoke({
    ...prepared,
    signature: `v1=${'0'.repeat(64)}`,
  })).status, 401);
  assert.equal((await invoke(prepared)).status, 503);
  writeKeyring([{
    id: uuid(90_500),
    keyId: 'synthetic-unregistered-v1',
    producerCode: 'SYNTHETIC_UNREGISTERED',
    version: 1,
    secret: Buffer.alloc(32, 2),
  }]);
  assert.equal((await invoke(prepared)).status, 401);
  assert.deepEqual(await counts(), {
    keys: 1, rates: 0, receipts: 0, requests: 0, inbox: 0, outbox: 0, attempts: 0,
  });
});

async function runProcesses(scenario: 'same' | 'conflict' | 'different') {
  const fixture = resolve('tests/db/secure-lead-gateway-v2-multiprocess-fixture.ts');
  const timestamp = String(Math.trunc(Date.now() / 1_000));
  const results = await Promise.all(Array.from({ length: 8 }, (_, worker) => (
    execFileAsync(process.execPath, [
      '--import',
      'tsx',
      fixture,
      scenario,
      String(worker),
      keyringPath,
      keyringRoot,
      timestamp,
    ], {
      env: process.env,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    })
  )));
  const statuses: Record<string, number> = {};
  for (const { stdout } of results) {
    const output = JSON.parse(stdout) as { status: number };
    statuses[String(output.status)] = (statuses[String(output.status)] ?? 0) + 1;
  }
  return statuses;
}

test('N12 replay and N11 convergence remain authoritative across eight isolated processes', {
  skip: !runDbTests,
  timeout: 180_000,
}, async () => {
  assert.deepEqual(await runProcesses('same'), { 202: 8 });
  assert.deepEqual(await counts(), {
    keys: 1, rates: 1, receipts: 1, requests: 1, inbox: 1, outbox: 0, attempts: 0,
  });

  await cleanGatewayAndN11();
  primaryKey = await provisionKey({
    keyId: N12_SYNTHETIC_KEY_ID,
    producerCode: N12_SYNTHETIC_PRODUCER_CODE,
    version: 1,
    secret: N12_SYNTHETIC_SECRET,
  });
  writeKeyring([primaryKey]);
  assert.deepEqual(await runProcesses('conflict'), { 202: 4, 409: 4 });
  assert.deepEqual(await counts(), {
    keys: 1, rates: 1, receipts: 1, requests: 1, inbox: 1, outbox: 0, attempts: 0,
  });

  await cleanGatewayAndN11();
  primaryKey = await provisionKey({
    keyId: N12_SYNTHETIC_KEY_ID,
    producerCode: N12_SYNTHETIC_PRODUCER_CODE,
    version: 1,
    secret: N12_SYNTHETIC_SECRET,
  });
  writeKeyring([primaryKey]);
  assert.deepEqual(await runProcesses('different'), { 202: 8 });
  assert.deepEqual(await counts(), {
    keys: 1, rates: 1, receipts: 1, requests: 8, inbox: 1, outbox: 0, attempts: 0,
  });
});
