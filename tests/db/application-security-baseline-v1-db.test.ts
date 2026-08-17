import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { after, before, beforeEach } from 'node:test';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  applicationFeatureGateCodes,
} from '../../src/lib/application-security-policy';
import {
  isApplicationFeatureEnabled,
} from '../../src/lib/application-feature-gates';
import {
  loadActivePrivilegedStepUpKey,
  PRIVILEGED_STEP_UP_KEY_PURPOSE,
  rotatePrivilegedStepUpKeyVersion,
} from '../../src/lib/application-key-registry';
import {
  clearLoginThrottle,
  loginAttemptAllowed,
  loginThrottleKeyDigest,
  recordLoginFailure,
} from '../../src/lib/login-throttle';
import {
  createPrivilegedStepUpToken,
  privilegedStepUpKeyDigest,
  verifyPrivilegedStepUpToken,
} from '../../src/lib/privileged-step-up-token';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from './ai-orchestrator-db-test-guard';

const run = process.env.RUN_DB_TESTS === '1';
const db = new PrismaClient();
const syntheticUserId = 'n03-security-test-admin';
const syntheticEmail = 'n03-security-test@ci.invalid';
const throttleSecret = 'n03-throttle-test-secret'.padEnd(32, '!');
const throttleDigests = [
  loginThrottleKeyDigest('concurrent@ci.invalid', throttleSecret),
  loginThrottleKeyDigest('reset@ci.invalid', throttleSecret),
];

async function clean() {
  await db.applicationFeatureGate.updateMany({
    where: { code: { in: [...applicationFeatureGateCodes] } },
    data: { enabled: false, updatedById: null },
  });
  await db.loginThrottleBucket.deleteMany({ where: { keyDigest: { in: throttleDigests } } });
  const keys = await db.applicationKeyVersion.findMany({
    where: { purpose: PRIVILEGED_STEP_UP_KEY_PURPOSE, createdById: syntheticUserId },
    select: { id: true },
  });
  await db.auditLog.deleteMany({
    where: {
      event: 'application_key_version_rotated',
      OR: [
        { actorId: syntheticUserId },
        { entityId: { in: keys.map(({ id }) => id) } },
      ],
    },
  });
  await db.applicationKeyVersion.deleteMany({ where: { createdById: syntheticUserId } });
  await db.user.deleteMany({ where: { id: syntheticUserId } });
}

before(async () => {
  if (!run) return;
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
});
beforeEach(async () => { if (run) await clean(); });
after(async () => { if (run) await clean(); await db.$disconnect(); });

async function migrationQualification(upgrade: boolean) {
  const schema = `n03_${upgrade ? 'upgrade' : 'fresh'}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const root = mkdtempSync(join(tmpdir(), 'n03-migrations-'));
  const prismaDir = join(root, 'prisma');
  const migrationsDir = join(prismaDir, 'migrations');
  mkdirSync(migrationsDir, { recursive: true });
  cpSync('prisma/schema.prisma', join(prismaDir, 'schema.prisma'));
  const names = readdirSync('prisma/migrations').filter((name) => /^\d/.test(name)).sort();
  assert.equal(names.length, 34);
  const databaseUrl = new URL(process.env.DATABASE_URL!);
  databaseUrl.searchParams.set('schema', schema);
  await db.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  const deploy = () => execFileSync(
    resolve('node_modules/.bin/prisma'),
    ['migrate', 'deploy', '--schema', join(prismaDir, 'schema.prisma')],
    { env: { ...process.env, DATABASE_URL: databaseUrl.toString() }, stdio: 'pipe' },
  );
  try {
    const initial = upgrade ? names.slice(0, 33) : names;
    for (const name of initial) cpSync(join('prisma/migrations', name), join(migrationsDir, name), { recursive: true });
    deploy();
    if (upgrade) {
      cpSync(join('prisma/migrations', names[33]), join(migrationsDir, names[33]), { recursive: true });
      deploy();
    }
    const client = new PrismaClient({ datasources: { db: { url: databaseUrl.toString() } } });
    try {
      const applied = await client.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*)::bigint AS count FROM "_prisma_migrations"
        WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
      `;
      const catalog = await client.$queryRaw<Array<{
        tables: bigint; constraints: bigint; indexes: bigint; gates: bigint; enabled: bigint;
      }>>(Prisma.sql`
        SELECT
          (SELECT COUNT(*)::bigint FROM information_schema.tables
            WHERE table_schema = ${schema} AND table_name IN ('ApplicationFeatureGate','ApplicationKeyVersion','LoginThrottleBucket')) AS tables,
          (SELECT COUNT(*)::bigint FROM information_schema.table_constraints
            WHERE table_schema = ${schema} AND constraint_name IN (
              'ApplicationFeatureGate_pkey','ApplicationFeatureGate_code_check','ApplicationFeatureGate_version_check','ApplicationFeatureGate_updatedById_fkey',
              'ApplicationKeyVersion_pkey','ApplicationKeyVersion_purpose_check','ApplicationKeyVersion_version_check','ApplicationKeyVersion_digest_length_check','ApplicationKeyVersion_status_check','ApplicationKeyVersion_lifecycle_check','ApplicationKeyVersion_createdById_fkey',
              'LoginThrottleBucket_pkey','LoginThrottleBucket_key_digest_check','LoginThrottleBucket_failed_count_check','LoginThrottleBucket_blocked_until_check'
            )) AS constraints,
          (SELECT COUNT(*)::bigint FROM pg_indexes
            WHERE schemaname = ${schema} AND indexname IN (
              'ApplicationFeatureGate_pkey','ApplicationFeatureGate_enabled_code_idx','ApplicationFeatureGate_updatedById_idx',
              'ApplicationKeyVersion_pkey','ApplicationKeyVersion_purpose_version_key','ApplicationKeyVersion_one_active_per_purpose_idx','ApplicationKeyVersion_purpose_status_idx','ApplicationKeyVersion_createdById_idx',
              'LoginThrottleBucket_pkey','LoginThrottleBucket_blockedUntil_idx'
            )) AS indexes,
          (SELECT COUNT(*)::bigint FROM ${Prisma.raw(`"${schema}"."ApplicationFeatureGate"`)}) AS gates,
          (SELECT COUNT(*)::bigint FROM ${Prisma.raw(`"${schema}"."ApplicationFeatureGate"`)} WHERE "enabled") AS enabled
      `);
      return {
        applied: Number(applied[0]?.count),
        tables: Number(catalog[0]?.tables),
        constraints: Number(catalog[0]?.constraints),
        indexes: Number(catalog[0]?.indexes),
        gates: Number(catalog[0]?.gates),
        enabled: Number(catalog[0]?.enabled),
      };
    } finally { await client.$disconnect(); }
  } finally {
    await db.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    rmSync(root, { recursive: true, force: true });
  }
}

test('N03 migration qualifies fresh 1-34 and upgrade 1-33 then 34', { skip: !run, timeout: 120_000 }, async () => {
  const expected = { applied: 34, tables: 3, constraints: 15, indexes: 10, gates: 6, enabled: 0 };
  assert.deepEqual(await migrationQualification(false), expected);
  assert.deepEqual(await migrationQualification(true), expected);
});

test('N03 feature gates remain OFF unless ENV and PostgreSQL independently agree', { skip: !run }, async () => {
  assert.equal(await db.applicationFeatureGate.count(), 6);
  assert.equal(await db.applicationFeatureGate.count({ where: { enabled: true } }), 0);
  assert.equal(await isApplicationFeatureEnabled(db, 'INTEGRATIONS', { FEATURE_INTEGRATIONS_ENABLED: 'true' }), false);
  await db.applicationFeatureGate.update({ where: { code: 'INTEGRATIONS' }, data: { enabled: true } });
  assert.equal(await isApplicationFeatureEnabled(db, 'INTEGRATIONS', { FEATURE_INTEGRATIONS_ENABLED: 'false' }), false);
  assert.equal(await isApplicationFeatureEnabled(db, 'INTEGRATIONS', {}), false);
  assert.equal(await isApplicationFeatureEnabled(db, 'INTEGRATIONS', { FEATURE_INTEGRATIONS_ENABLED: 'true' }), true);
});

test('N03 key rotation is monotonic, serialized, digest-only, and invalidates old tokens', { skip: !run }, async () => {
  await db.user.create({
    data: { id: syntheticUserId, email: syntheticEmail, name: 'N03 Synthetic Admin', passwordHash: 'not-used', role: 'admin' },
  });
  const firstSecret = 'first-n03-step-up-secret'.padEnd(32, '!');
  const secondSecret = 'second-n03-step-up-secret'.padEnd(32, '!');
  const first = await db.$transaction((tx) => rotatePrivilegedStepUpKeyVersion(tx, {
    version: 1, keyDigest: privilegedStepUpKeyDigest(firstSecret), actorUserId: syntheticUserId,
  }));
  const oldToken = createPrivilegedStepUpToken({
    key: { version: 1, secret: firstSecret }, userId: syntheticUserId, sessionToken: 'n03-session', nowSeconds: 5_000,
  });
  const second = await db.$transaction((tx) => rotatePrivilegedStepUpKeyVersion(tx, {
    version: 2, keyDigest: privilegedStepUpKeyDigest(secondSecret), actorUserId: syntheticUserId,
  }));
  assert.equal((await db.applicationKeyVersion.findUniqueOrThrow({ where: { id: first.id } })).status, 'RETIRED');
  assert.equal((await db.applicationKeyVersion.findUniqueOrThrow({ where: { id: second.id } })).status, 'ACTIVE');
  assert.equal(await db.applicationKeyVersion.count({ where: { purpose: PRIVILEGED_STEP_UP_KEY_PURPOSE, status: 'ACTIVE' } }), 1);
  assert.equal(await loadActivePrivilegedStepUpKey(db, {
    PRIVILEGED_STEP_UP_KEY_VERSION: '1', PRIVILEGED_STEP_UP_SECRET: firstSecret,
  }), null);
  const active = await loadActivePrivilegedStepUpKey(db, {
    PRIVILEGED_STEP_UP_KEY_VERSION: '2', PRIVILEGED_STEP_UP_SECRET: secondSecret,
  });
  assert.deepEqual(active, { version: 2, secret: secondSecret });
  assert.equal(verifyPrivilegedStepUpToken({
    token: oldToken, key: active!, expectedUserId: syntheticUserId, sessionToken: 'n03-session', nowSeconds: 5_001,
  }), false);

  const concurrent = await Promise.allSettled(Array.from({ length: 2 }, () => db.$transaction(
    (tx) => rotatePrivilegedStepUpKeyVersion(tx, {
      version: 3, keyDigest: privilegedStepUpKeyDigest('third-n03-step-up-secret'.padEnd(32, '!')), actorUserId: syntheticUserId,
    }),
  )));
  assert.equal(concurrent.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal(concurrent.filter(({ status }) => status === 'rejected').length, 1);
  assert.equal(await db.applicationKeyVersion.count({ where: { purpose: PRIVILEGED_STEP_UP_KEY_PURPOSE, status: 'ACTIVE' } }), 1);
  await db.user.update({ where: { id: syntheticUserId }, data: { role: 'revisore' } });
  await assert.rejects(db.$transaction((tx) => rotatePrivilegedStepUpKeyVersion(tx, {
    version: 4, keyDigest: privilegedStepUpKeyDigest('fourth-n03-step-up-secret'.padEnd(32, '!')), actorUserId: syntheticUserId,
  })), /PRIVILEGED_STEP_UP_KEY_ROTATION_ACTOR_DENIED/);
  assert.equal(await db.applicationKeyVersion.count({ where: { purpose: PRIVILEGED_STEP_UP_KEY_PURPOSE, status: 'ACTIVE' } }), 1);
  const audits = await db.auditLog.findMany({
    where: { actorId: syntheticUserId, event: 'application_key_version_rotated' },
    select: { before: true, after: true, ipAddress: true }, orderBy: { createdAt: 'asc' },
  });
  assert.equal(audits.length, 3);
  for (const audit of audits) {
    assert.equal(audit.before, null);
    assert.equal(audit.ipAddress, null);
    assert.deepEqual(Object.keys(audit.after as object).sort(), ['purpose', 'version']);
  }
  const digests = await db.applicationKeyVersion.findMany({
    where: { createdById: syntheticUserId }, select: { keyDigest: true },
  });
  assert.ok(digests.every(({ keyDigest }) => Buffer.from(keyDigest).length === 32));
});

test('N03 login failure threshold is atomic under concurrency and resets after expiry', { skip: !run }, async () => {
  const keyDigest = throttleDigests[0];
  const configuration = { maxFailures: 5, windowSeconds: 900, blockSeconds: 900 };
  const results = await Promise.all(Array.from({ length: 20 }, () => recordLoginFailure(db, keyDigest, configuration)));
  assert.ok(results.some(({ blocked }) => blocked));
  const row = await db.loginThrottleBucket.findUniqueOrThrow({ where: { keyDigest } });
  assert.equal(row.failedCount, 20);
  assert.ok(row.blockedUntil && row.blockedUntil > new Date());
  assert.equal(await loginAttemptAllowed(db, keyDigest), false);

  await db.loginThrottleBucket.update({
    where: { keyDigest },
    data: { windowStartedAt: new Date(Date.now() - 2_000_000), blockedUntil: new Date(Date.now() - 1_000) },
  });
  const reset = await recordLoginFailure(db, keyDigest, configuration);
  assert.deepEqual(reset, { failedCount: 1, blocked: false });
  assert.equal(await loginAttemptAllowed(db, keyDigest), true);
  await clearLoginThrottle(db, keyDigest);
  assert.equal(await db.loginThrottleBucket.findUnique({ where: { keyDigest } }), null);
});

test('N03 database rejects invalid gates, duplicate active keys, and raw login identifiers', { skip: !run }, async () => {
  await db.user.create({
    data: { id: syntheticUserId, email: syntheticEmail, name: 'N03 Synthetic Admin', passwordHash: 'not-used', role: 'admin' },
  });
  await assert.rejects(db.applicationFeatureGate.create({ data: { code: 'UNKNOWN', enabled: false } }));
  await db.applicationKeyVersion.create({
    data: {
      purpose: PRIVILEGED_STEP_UP_KEY_PURPOSE, version: 10, keyDigest: privilegedStepUpKeyDigest('key-ten'.padEnd(32, '!')),
      status: 'ACTIVE', activatedAt: new Date(), createdById: syntheticUserId,
    },
  });
  await assert.rejects(db.applicationKeyVersion.create({
    data: {
      purpose: PRIVILEGED_STEP_UP_KEY_PURPOSE, version: 11, keyDigest: privilegedStepUpKeyDigest('key-eleven'.padEnd(32, '!')),
      status: 'ACTIVE', activatedAt: new Date(), createdById: syntheticUserId,
    },
  }));
  await assert.rejects(db.loginThrottleBucket.create({
    data: { keyDigest: syntheticEmail, failedCount: 1, windowStartedAt: new Date() },
  }));
});
