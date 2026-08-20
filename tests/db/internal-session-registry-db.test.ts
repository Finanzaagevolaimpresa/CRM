import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after, afterEach, before, beforeEach } from "node:test";
import { Prisma, PrismaClient } from "@prisma/client";
import {
  assertRegistryActivationReady,
  authoritativeInternalSessionLookupQuery,
  countLiveInternalSessions,
  createInternalSession,
  createRegistryLoginSession,
  lockInternalUser,
  logoutInternalSession,
  resolveInternalSession,
  revokeAllInternalSessions,
  revokeInternalSession,
} from "../../src/lib/internal-session-registry";
import {
  createRegistrySessionToken,
  digestRegistrySessionToken,
} from "../../src/lib/session";
import {
  activateInternalUserWithAudit,
  deactivateInternalUserWithAudit,
} from "../../src/lib/user-privilege-service";
import { assertAiOrchestratorEphemeralDatabaseIdentity } from "./ai-orchestrator-db-test-guard";

const run = process.env.RUN_DB_TESTS === "1";
const db = new PrismaClient();
const syntheticUserIds: string[] = [];

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
};

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitForPostgresLockWait(applicationName: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await db.$queryRaw<Array<{ waiting: boolean }>>`
      SELECT EXISTS (
        SELECT 1
        FROM pg_stat_activity
        WHERE application_name = ${applicationName}
          AND wait_event_type = 'Lock'
          AND state = 'active'
      ) AS waiting
    `;
    if (rows[0]?.waiting) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`transaction ${applicationName} did not enter a PostgreSQL lock wait`);
}

async function createSyntheticUser() {
  const id = `n02-${crypto.randomUUID()}`;
  syntheticUserIds.push(id);
  return db.user.create({
    data: {
      id,
      email: `${id}@example.invalid`,
      name: "Synthetic N02",
      passwordHash: "synthetic-not-a-login-hash",
      role: "admin",
      active: true,
    },
  });
}

async function issueSession(userId: string) {
  const value = createRegistrySessionToken();
  const tokenDigest = await digestRegistrySessionToken(value.bytes);
  const row = await db.$transaction((tx) =>
    createInternalSession(tx, { userId, tokenDigest }),
  );
  return { token: value.token, tokenDigest, row };
}

async function revokeForDisabledUser(
  client: PrismaClient,
  userId: string,
  actorId: string,
) {
  return client.$transaction((tx) =>
    deactivateInternalUserWithAudit(tx, { userId: actorId }, userId),
  );
}

function serializedAuditRecords(records: unknown) {
  return JSON.stringify(records);
}

before(async () => {
  if (run) await assertAiOrchestratorEphemeralDatabaseIdentity(db);
});

async function cleanSyntheticState() {
  if (!run || syntheticUserIds.length === 0) return;
  const ids = [...syntheticUserIds];
  await db.internalSession.deleteMany({
    where: { userId: { in: ids } },
  });
  await db.auditLog.deleteMany({
    where: {
      OR: [
        { entityId: { in: ids } },
        { actorId: { in: ids } },
      ],
    },
  });
  await db.user.deleteMany({ where: { id: { in: ids } } });
  syntheticUserIds.length = 0;
}

beforeEach(cleanSyntheticState);
afterEach(cleanSyntheticState);

after(async () => {
  await cleanSyntheticState();
  await db.$disconnect();
});

async function migrationChain(upgrade: boolean) {
  const allNames = readdirSync("prisma/migrations")
    .filter((name) => /^\d/.test(name))
    .sort();
  assert.equal(allNames.length, 38, "N11 must extend the chain to exactly 38 migrations");
  const names = allNames.slice(0, 33);
  assert.match(names[32], /internal_session_registry_revocation_v1/);

  const root = mkdtempSync(join(tmpdir(), "n02-migrations-"));
  const prismaDir = join(root, "prisma");
  const migrationsDir = join(prismaDir, "migrations");
  mkdirSync(migrationsDir, { recursive: true });
  cpSync("prisma/schema.prisma", join(prismaDir, "schema.prisma"));

  const schema = `n02_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const url = new URL(process.env.DATABASE_URL!);
  url.searchParams.set("schema", schema);
  await db.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);

  const deploy = () =>
    execFileSync(
      resolve("node_modules/.bin/prisma"),
      ["migrate", "deploy", "--schema", join(prismaDir, "schema.prisma")],
      {
        env: { ...process.env, DATABASE_URL: url.toString() },
        stdio: "pipe",
      },
    );

  try {
    const initialNames = upgrade ? names.slice(0, 32) : names;
    for (const name of initialNames) {
      cpSync(join("prisma/migrations", name), join(migrationsDir, name), {
        recursive: true,
      });
    }
    deploy();

    if (upgrade) {
      const n02Migration = names[32];
      cpSync(
        join("prisma/migrations", n02Migration),
        join(migrationsDir, n02Migration),
        { recursive: true },
      );
      deploy();
    }

    const client = new PrismaClient({
      datasources: { db: { url: url.toString() } },
    });
    try {
      const rows = await client.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*)::bigint AS count
        FROM "_prisma_migrations"
        WHERE finished_at IS NOT NULL
      `;
      return Number(rows[0].count);
    } finally {
      await client.$disconnect();
    }
  } finally {
    await db.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    rmSync(root, { recursive: true, force: true });
  }
}

test("N02 migration fresh 1-33 is exact", { skip: !run }, async () => {
  assert.equal(await migrationChain(false), 33);
});

test(
  "N02 migration upgrade 1-32 then 33 is exact",
  { skip: !run },
  async () => {
    assert.equal(await migrationChain(true), 33);
  },
);

test("N02 catalog has checks FKs and indexes", { skip: !run }, async () => {
  const rows = await db.$queryRaw<
    Array<{ checks: bigint; fks: bigint; indexes: bigint }>
  >`
    SELECT
      (SELECT COUNT(*) FROM pg_constraint
        WHERE conrelid='"InternalSession"'::regclass AND contype='c') AS checks,
      (SELECT COUNT(*) FROM pg_constraint
        WHERE conrelid='"InternalSession"'::regclass AND contype='f') AS fks,
      (SELECT COUNT(*) FROM pg_indexes
        WHERE tablename='InternalSession') AS indexes
  `;
  assert.deepEqual(
    [Number(rows[0].checks), Number(rows[0].fks), Number(rows[0].indexes)],
    [3, 2, 4],
  );
});

test(
  "N02 digest lookup uses PostgreSQL expiry boundary",
  { skip: !run },
  async () => {
    const user = await createSyntheticUser();
    const session = await issueSession(user.id);

    assert.equal(session.row.tokenDigest.length, 32);
    assert.ok(await resolveInternalSession(db, session.token));

    await db.$executeRaw`
    UPDATE "InternalSession"
    SET "expiresAt"=CURRENT_TIMESTAMP
    WHERE "id"=${session.row.id}::uuid
  `;
    assert.equal(await resolveInternalSession(db, session.token), null);
  },
);

test(
  "N02 negative sessions fail without request audit",
  { skip: !run },
  async () => {
    const user = await createSyntheticUser();
    const expired = await issueSession(user.id);
    const revoked = await issueSession(user.id);
    const auditCountBefore = await db.auditLog.count();

    await db.$executeRaw`
    UPDATE "InternalSession"
    SET "expiresAt"=CURRENT_TIMESTAMP
    WHERE "id"=${expired.row.id}::uuid
  `;
    await db.$transaction((tx) =>
      revokeInternalSession(tx, revoked.row.id, "INTERNAL_SINGLE", user.id),
    );
    const auditCountAfterRevocation = await db.auditLog.count();

    assert.equal(await resolveInternalSession(db, undefined), null);
    assert.equal(await resolveInternalSession(db, "v1.bad"), null);
    assert.equal(
      await resolveInternalSession(db, createRegistrySessionToken().token),
      null,
    );
    assert.equal(await resolveInternalSession(db, expired.token), null);
    assert.equal(await resolveInternalSession(db, revoked.token), null);
    assert.equal(auditCountAfterRevocation, auditCountBefore + 1);
    assert.equal(await db.auditLog.count(), auditCountAfterRevocation);
  },
);

test(
  "N02 twenty concurrent login issues are distinct",
  { skip: !run },
  async () => {
    const user = await createSyntheticUser();
    const sessions = await Promise.all(
      Array.from({ length: 20 }, async () => {
        const value = createRegistrySessionToken();
        const tokenDigest = await digestRegistrySessionToken(value.bytes);
        const session = await createRegistryLoginSession(db, {
          userId: user.id,
          tokenDigest,
        });
        assert.ok(session);
        return { token: value.token, session };
      }),
    );

    assert.equal(new Set(sessions.map(({ token }) => token)).size, 20);
    assert.equal(
      await db.internalSession.count({ where: { userId: user.id } }),
      20,
    );
  },
);

test(
  "N02 login-first and disable-first races are linearized",
  { skip: !run },
  async () => {
    const loginClient = new PrismaClient();
    const disableClient = new PrismaClient();
    try {
      const loginFirstUser = await createSyntheticUser();
      const loginHasLock = deferred();
      const releaseLogin = deferred();
      const disableAttemptedLock = deferred();

      const loginFirst = loginClient.$transaction(async (tx) => {
        const locked = await lockInternalUser(tx, loginFirstUser.id);
        assert.equal(locked?.active, true);
        loginHasLock.resolve();
        await releaseLogin.promise;
        const value = createRegistrySessionToken();
        return createInternalSession(tx, {
          userId: loginFirstUser.id,
          tokenDigest: await digestRegistrySessionToken(value.bytes),
        });
      });

      await loginHasLock.promise;
      const disableAfterLogin = disableClient.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL application_name='n02-disable-after-login'`;
        const pendingLock = lockInternalUser(tx, loginFirstUser.id);
        disableAttemptedLock.resolve();
        const locked = await pendingLock;
        assert.ok(locked);
        await tx.user.update({
          where: { id: loginFirstUser.id },
          data: { active: false },
        });
        return revokeAllInternalSessions(
          tx,
          loginFirstUser.id,
          "USER_DISABLED",
          loginFirstUser.id,
        );
      });

      await disableAttemptedLock.promise;
      try {
        await waitForPostgresLockWait("n02-disable-after-login");
      } finally {
        releaseLogin.resolve();
      }
      const [created, revocation] = await Promise.all([
        loginFirst,
        disableAfterLogin,
      ]);
      assert.equal(revocation.count, 1);
      assert.equal(
        (await db.internalSession.findUnique({ where: { id: created.id } }))
          ?.revokedReason,
        "USER_DISABLED",
      );

      const disableFirstUser = await createSyntheticUser();
      const disableHasLock = deferred();
      const releaseDisable = deferred();
      const loginAttemptedLock = deferred();

      const disableFirst = disableClient.$transaction(async (tx) => {
        const locked = await lockInternalUser(tx, disableFirstUser.id);
        assert.equal(locked?.active, true);
        await tx.user.update({
          where: { id: disableFirstUser.id },
          data: { active: false },
        });
        disableHasLock.resolve();
        await releaseDisable.promise;
      });

      await disableHasLock.promise;
      const blockedLogin = loginClient.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL application_name='n02-login-after-disable'`;
        const pendingLock = lockInternalUser(tx, disableFirstUser.id);
        loginAttemptedLock.resolve();
        const locked = await pendingLock;
        if (!locked?.active || locked.deletedAt) return null;
        const value = createRegistrySessionToken();
        return createInternalSession(tx, {
          userId: disableFirstUser.id,
          tokenDigest: await digestRegistrySessionToken(value.bytes),
        });
      });

      await loginAttemptedLock.promise;
      try {
        await waitForPostgresLockWait("n02-login-after-disable");
      } finally {
        releaseDisable.resolve();
      }
      await disableFirst;
      assert.equal(await blockedLogin, null);
      assert.equal(
        await db.internalSession.count({
          where: { userId: disableFirstUser.id },
        }),
        0,
      );
    } finally {
      await Promise.all([
        loginClient.$disconnect(),
        disableClient.$disconnect(),
      ]);
    }
  },
);

test(
  "N02 current single global revocation and privacy audits are exact",
  { skip: !run },
  async () => {
    const user = await createSyntheticUser();
    const current = await issueSession(user.id);
    const single = await issueSession(user.id);
    const globalToken = createRegistrySessionToken();
    const globalDigest = await digestRegistrySessionToken(globalToken.bytes);
    const globalRow = await createRegistryLoginSession(db, {
      userId: user.id,
      tokenDigest: globalDigest,
    });
    assert.ok(globalRow);
    const global = {
      token: globalToken.token,
      tokenDigest: globalDigest,
      row: globalRow,
    };

    await db.$transaction((tx) => logoutInternalSession(tx, current.token));
    await db.$transaction((tx) => logoutInternalSession(tx, current.token));
    await db.$transaction((tx) =>
      revokeInternalSession(tx, single.row.id, "INTERNAL_SINGLE", user.id),
    );
    const firstGlobal = await db.$transaction((tx) =>
      revokeAllInternalSessions(tx, user.id, "INTERNAL_GLOBAL", user.id),
    );
    const secondGlobal = await db.$transaction((tx) =>
      revokeAllInternalSessions(tx, user.id, "INTERNAL_GLOBAL", user.id),
    );

    assert.equal(firstGlobal.count, 1);
    assert.equal(secondGlobal.count, 0);
    const loginAudit = await db.auditLog.findFirstOrThrow({
      where: { event: "login", entityId: user.id },
    });
    assert.equal(loginAudit.actorId, user.id);
    assert.equal(loginAudit.entityType, "User");
    assert.equal(loginAudit.before, null);
    assert.equal(loginAudit.ipAddress, null);
    assert.deepEqual(loginAudit.after, {
      sessionId: global.row.id,
      expiresAt: global.row.expiresAt.toISOString(),
    });

    const logoutAudit = await db.auditLog.findFirstOrThrow({
      where: { event: "logout", entityId: user.id },
    });
    assert.equal(logoutAudit.actorId, user.id);
    assert.equal(logoutAudit.entityType, "User");
    assert.equal(logoutAudit.before, null);
    assert.equal(logoutAudit.ipAddress, null);
    assert.deepEqual(logoutAudit.after, {
      sessionId: current.row.id,
      reason: "LOGOUT",
    });
    assert.equal(
      await db.auditLog.count({
        where: { event: "logout", entityId: user.id },
      }),
      1,
    );

    const singleAudit = await db.auditLog.findFirstOrThrow({
      where: { event: "session_revoked", entityId: single.row.id },
    });
    assert.equal(singleAudit.actorId, user.id);
    assert.equal(singleAudit.entityType, "InternalSession");
    assert.equal(singleAudit.before, null);
    assert.equal(singleAudit.ipAddress, null);
    assert.deepEqual(singleAudit.after, {
      reason: "INTERNAL_SINGLE",
      targetUserId: user.id,
    });

    const globalAudit = await db.auditLog.findFirstOrThrow({
      where: { event: "sessions_revoked_global", entityId: user.id },
    });
    assert.equal(globalAudit.actorId, user.id);
    assert.equal(globalAudit.entityType, "User");
    assert.equal(globalAudit.before, null);
    assert.equal(globalAudit.ipAddress, null);
    assert.deepEqual(globalAudit.after, {
      reason: "INTERNAL_GLOBAL",
      revokedCount: 1,
    });
    assert.equal(
      await db.auditLog.count({
        where: { event: "sessions_revoked_global", entityId: user.id },
      }),
      1,
    );
    assert.equal(await resolveInternalSession(db, global.token), null);

    const audits = await db.auditLog.findMany({
      where: { actorId: user.id },
    });
    const serialized = serializedAuditRecords(audits);
    const sessions = [current, single, global];
    const forbiddenValues = [
      ...sessions.map(({ token }) => token),
      ...sessions.map(({ tokenDigest }) =>
        Buffer.from(tokenDigest).toString("hex"),
      ),
      ...sessions.map(({ tokenDigest }) =>
        Buffer.from(tokenDigest).toString("base64"),
      ),
      user.passwordHash,
      user.email,
      user.name,
      "cookie",
      "user-agent",
      "127.0.0.1",
      "AUTH_SECRET",
    ];
    for (const forbidden of forbiddenValues) {
      assert.equal(
        serialized.includes(forbidden),
        false,
        `audit records must not contain ${forbidden}`,
      );
    }
  },
);

test(
  "N02 real login logout and disable transactions roll back on audit fault",
  { skip: !run },
  async () => {
    const actor = await createSyntheticUser();
    const user = await createSyntheticUser();
    const initialLastLoginAt = user.lastLoginAt;
    const loginToken = createRegistrySessionToken();
    const loginDigest = await digestRegistrySessionToken(loginToken.bytes);
    const savedMode = process.env.INTERNAL_SESSION_MODE;
    process.env.INTERNAL_SESSION_MODE = "registry";

    await db.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION n02_fault()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.event IN ('login', 'logout', 'sessions_revoked_global') THEN
        RAISE EXCEPTION 'synthetic audit failure';
      END IF;
      RETURN NEW;
    END $$
  `);
    await db.$executeRawUnsafe(`
    CREATE TRIGGER n02_fault BEFORE INSERT ON "AuditLog"
    FOR EACH ROW EXECUTE FUNCTION n02_fault()
  `);
    try {
      await assert.rejects(
        createRegistryLoginSession(db, {
          userId: user.id,
          tokenDigest: loginDigest,
        }),
      );
      assert.equal(
        await db.internalSession.count({ where: { userId: user.id } }),
        0,
      );
      assert.equal(
        (await db.user.findUniqueOrThrow({ where: { id: user.id } }))
          .lastLoginAt,
        initialLastLoginAt,
      );
      assert.equal(await resolveInternalSession(db, loginToken.token), null);

      const logoutSession = await issueSession(user.id);
      await assert.rejects(
        db.$transaction((tx) => logoutInternalSession(tx, logoutSession.token)),
      );
      assert.ok(await resolveInternalSession(db, logoutSession.token));

      await assert.rejects(revokeForDisabledUser(db, user.id, actor.id));
      assert.equal(
        (await db.user.findUniqueOrThrow({ where: { id: user.id } })).active,
        true,
      );
      assert.ok(await resolveInternalSession(db, logoutSession.token));
      assert.equal(
        await db.auditLog.count({
          where: { event: "user_deactivate", entityId: user.id },
        }),
        0,
      );
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER n02_fault ON "AuditLog"`);
      await db.$executeRawUnsafe(`DROP FUNCTION n02_fault()`);
      if (savedMode === undefined) delete process.env.INTERNAL_SESSION_MODE;
      else process.env.INTERNAL_SESSION_MODE = savedMode;
    }
  },
);

test(
  "N02 replay fails in an isolated process after revocation",
  { skip: !run },
  async () => {
    const user = await createSyntheticUser();
    const session = await issueSession(user.id);
    const isolatedFixture = `
      const { PrismaClient } = await import("@prisma/client");
      const registry = await import("./src/lib/internal-session-registry.ts");
      const resolveInternalSession = registry.resolveInternalSession ?? registry.default?.resolveInternalSession;
      const db = new PrismaClient();
      try {
        const resolved = await resolveInternalSession(db, process.env.N02_SYNTHETIC_COOKIE);
        process.exitCode = Boolean(resolved) === (process.env.N02_EXPECT_VALID === "1") ? 0 : 3;
      } catch (error) {
        console.error(error);
        process.exitCode = 4;
      } finally {
        await db.$disconnect();
      }
    `;
    const runFixture = (expectedValid: boolean) => {
      const childEnvironment: NodeJS.ProcessEnv = {
        ...process.env,
        N02_SYNTHETIC_COOKIE: session.token,
        N02_EXPECT_VALID: expectedValid ? "1" : "0",
      };
      delete childEnvironment.NODE_TEST_CONTEXT;
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "--eval",
          isolatedFixture,
        ],
        {
          env: childEnvironment,
          encoding: "utf8",
        },
      );
      assert.equal(
        result.status,
        0,
        `isolated fixture failed: ${result.error?.message ?? result.stderr}`,
      );
    };

    runFixture(true);
    await db.$transaction((tx) =>
      revokeInternalSession(tx, session.row.id, "INTERNAL_SINGLE", user.id),
    );
    runFixture(false);
  },
);

test("N02 reactivation does not revive sessions", { skip: !run }, async () => {
  const actor = await createSyntheticUser();
  const user = await createSyntheticUser();
  const session = await issueSession(user.id);
  const savedMode = process.env.INTERNAL_SESSION_MODE;
  process.env.INTERNAL_SESSION_MODE = "registry";

  try {
    const deactivated = await revokeForDisabledUser(db, user.id, actor.id);
    assert.equal(deactivated.ok, true);
    const deactivateAudit = await db.auditLog.findFirstOrThrow({
      where: { event: "user_deactivate", entityId: user.id },
    });
    assert.equal(deactivateAudit.actorId, actor.id);
    assert.equal(deactivateAudit.entityType, "User");
    assert.deepEqual(deactivateAudit.before, { active: true });
    assert.deepEqual(deactivateAudit.after, { active: false });
    assert.equal(deactivateAudit.ipAddress, null);

    const revocationAudit = await db.auditLog.findFirstOrThrow({
      where: {
        event: "sessions_revoked_global",
        entityId: user.id,
      },
    });
    assert.equal(revocationAudit.actorId, actor.id);
    assert.equal(revocationAudit.entityType, "User");
    assert.equal(revocationAudit.before, null);
    assert.deepEqual(revocationAudit.after, {
      reason: "USER_DISABLED",
      revokedCount: 1,
    });
    assert.equal(revocationAudit.ipAddress, null);

    const activated = await db.$transaction((tx) =>
      activateInternalUserWithAudit(tx, { userId: actor.id }, user.id),
    );
    assert.equal(activated.ok, true);
    assert.equal(await resolveInternalSession(db, session.token), null);
  } finally {
    if (savedMode === undefined) delete process.env.INTERNAL_SESSION_MODE;
    else process.env.INTERNAL_SESSION_MODE = savedMode;
  }
});

test(
  "N02 digest lookup plan is unique indexed and bounded",
  { skip: !run },
  async () => {
    const user = await createSyntheticUser();
    const target = await issueSession(user.id);
    await db.$executeRaw`
      INSERT INTO "InternalSession"
        ("id", "userId", "tokenDigest", "createdAt", "expiresAt")
      SELECT
        gen_random_uuid(),
        ${user.id},
        decode(lpad(to_hex(value), 64, '0'), 'hex'),
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP + INTERVAL '8 hours'
      FROM generate_series(1, 10000) AS generated(value)
    `;

    await db.$executeRaw`ANALYZE "InternalSession"`;
    await db.$executeRaw`ANALYZE "User"`;
    const lookup = authoritativeInternalSessionLookupQuery(target.tokenDigest);
    const planRows = await db.$queryRaw<Array<{ "QUERY PLAN": unknown }>>(
      Prisma.sql`EXPLAIN (FORMAT JSON) ${lookup}`,
    );

    const serializedPlan = JSON.stringify(planRows[0]["QUERY PLAN"]);
    assert.match(serializedPlan, /"Node Type":"Limit"/);
    assert.match(serializedPlan, /"Node Type":"Index Scan"/);
    assert.match(serializedPlan, /InternalSession_tokenDigest_key/);
    assert.doesNotMatch(
      serializedPlan,
      /"Node Type":"Seq Scan"[^}]*"Relation Name":"InternalSession"/,
    );

    const registrySource = readFileSync(
      "src/lib/internal-session-registry.ts",
      "utf8",
    );
    assert.match(
      registrySource,
      /authoritativeInternalSessionLookupQuery\(digest\)/,
    );
  },
);

test(
  "N02 protected surfaces use authoritative registry resolution",
  { skip: !run },
  async () => {
    const malformed = "v1.bad";
    assert.equal(await resolveInternalSession(db, malformed), null);
    assert.equal(
      await resolveInternalSession(db, createRegistrySessionToken().token),
      null,
    );

    const expiredUser = await createSyntheticUser();
    const expired = await issueSession(expiredUser.id);
    await db.$executeRaw`
    UPDATE "InternalSession"
    SET "expiresAt"=CURRENT_TIMESTAMP
    WHERE "id"=${expired.row.id}::uuid
  `;
    assert.equal(await resolveInternalSession(db, expired.token), null);

    const revokedUser = await createSyntheticUser();
    const revoked = await issueSession(revokedUser.id);
    await db.$transaction((tx) =>
      revokeInternalSession(
        tx,
        revoked.row.id,
        "INTERNAL_SINGLE",
        revokedUser.id,
      ),
    );
    assert.equal(await resolveInternalSession(db, revoked.token), null);

    const disabledUser = await createSyntheticUser();
    const disabled = await issueSession(disabledUser.id);
    await db.user.update({
      where: { id: disabledUser.id },
      data: { active: false },
    });
    assert.equal(await resolveInternalSession(db, disabled.token), null);

    const deletedUser = await createSyntheticUser();
    const deleted = await issueSession(deletedUser.id);
    await db.user.update({
      where: { id: deletedUser.id },
      data: { deletedAt: new Date() },
    });
    assert.equal(await resolveInternalSession(db, deleted.token), null);

    const authSource = readFileSync("src/lib/auth.ts", "utf8");
    assert.match(
      authSource,
      /getSession\(\)[\s\S]*internalSessionMode\(\) === 'registry'[\s\S]*resolveInternalSession\(prisma, token\)/,
    );
    assert.match(authSource, /requireSession[\s\S]*getSession\(\)/);
    assert.match(authSource, /requirePermission[\s\S]*requireSession\(\)/);
    assert.match(authSource, /requireAnyPermission[\s\S]*requireSession\(\)/);
    assert.match(authSource, /requireAuth[\s\S]*requireSession\(\)/);

    const middlewareSource = readFileSync("src/middleware.ts", "utf8");
    assert.match(middlewareSource, /isCanonicalRegistrySessionCookie\(token\)/);
    assert.doesNotMatch(
      middlewareSource,
      /Prisma|prisma|resolveInternalSession/,
    );
  },
);

test(
  "N02 legacy mode is inert and rejects PR88 cookies in registry resolution",
  { skip: !run },
  async () => {
    const countBefore = await db.internalSession.count();
    assert.equal(await resolveInternalSession(db, "legacy:user:cookie"), null);
    assert.equal(await db.internalSession.count(), countBefore);
  },
);

test(
  "N02 anti-resurrection gate blocks live sessions",
  { skip: !run },
  async () => {
    assert.equal(await countLiveInternalSessions(db), 0n);
    const user = await createSyntheticUser();
    await issueSession(user.id);

    assert.equal(await countLiveInternalSessions(db), 1n);
    await assert.rejects(
      assertRegistryActivationReady(db),
      /INTERNAL_SESSION_REGISTRY_ACTIVATION_BLOCKED/,
    );

    await db.$transaction((tx) =>
      revokeAllInternalSessions(tx, user.id, "INTERNAL_GLOBAL", user.id),
    );
    assert.equal(await countLiveInternalSessions(db), 0n);
    await assert.doesNotReject(assertRegistryActivationReady(db));
  },
);

test(
  "N02 Next.js startup blocks registry activation with a live session",
  { skip: !run },
  async () => {
    const savedMode = process.env.INTERNAL_SESSION_MODE;
    const savedRuntime = process.env.NEXT_RUNTIME;
    process.env.INTERNAL_SESSION_MODE = "registry";
    process.env.NEXT_RUNTIME = "nodejs";

    try {
      const { register } = await import("../../src/instrumentation");
      await assert.doesNotReject(register());

      const user = await createSyntheticUser();
      await issueSession(user.id);
      await assert.rejects(
        register(),
        /INTERNAL_SESSION_REGISTRY_ACTIVATION_BLOCKED/,
      );

      process.env.INTERNAL_SESSION_MODE = "legacy";
      await assert.doesNotReject(register());
    } finally {
      if (savedMode === undefined) delete process.env.INTERNAL_SESSION_MODE;
      else process.env.INTERNAL_SESSION_MODE = savedMode;
      if (savedRuntime === undefined) delete process.env.NEXT_RUNTIME;
      else process.env.NEXT_RUNTIME = savedRuntime;
    }
  },
);

test(
  "exact PR88 starts on additive schema 34 and leaves N02/N03 inert",
  { skip: !run },
  async () => {
    const countBefore = await db.internalSession.count();
    const n03Before = {
      keys: await db.applicationKeyVersion.count(),
      throttleBuckets: await db.loginThrottleBucket.count(),
      enabledFeatureGates: await db.applicationFeatureGate.count({ where: { enabled: true } }),
    };
    const root = mkdtempSync(join(tmpdir(), "n02-pr88-"));
    const archive = join(root, ".pr88.tar");
    execFileSync("git", [
      "archive",
      "--format=tar",
      `--output=${archive}`,
      "77828266853c935cf6805cc546ceafdab43d310d",
    ]);
    execFileSync("tar", ["-xf", archive, "-C", root]);
    rmSync(archive);
    symlinkSync(resolve("node_modules"), join(root, "node_modules"), "dir");
    const runtimeEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      AUTH_SECRET: "synthetic-pr88-only",
      NEXT_TELEMETRY_DISABLED: "1",
      NODE_ENV: "production",
    };
    execFileSync(resolve("node_modules/.bin/tsc"), ["--noEmit"], {
      cwd: root,
      env: runtimeEnvironment,
      stdio: "pipe",
      timeout: 120_000,
      maxBuffer: 20 * 1024 * 1024,
    });
    const configPath = join(root, "next.config.ts");
    const originalConfig = readFileSync(configPath, "utf8");
    const buildConfig = originalConfig.replace(
      "const nextConfig: NextConfig = {",
      "const nextConfig: NextConfig = {\n  typescript: { ignoreBuildErrors: true },",
    );
    assert.notEqual(buildConfig, originalConfig);
    writeFileSync(configPath, buildConfig);
    execFileSync(resolve("node_modules/.bin/next"), ["build", "--webpack"], {
      cwd: root,
      env: runtimeEnvironment,
      stdio: "pipe",
      timeout: 120_000,
      maxBuffer: 20 * 1024 * 1024,
    });

    const port = String(43000 + Math.floor(Math.random() * 1000));
    const app = spawn(
      resolve("node_modules/.bin/next"),
      ["start", "-p", port],
      {
        cwd: root,
        env: runtimeEnvironment,
        stdio: "ignore",
      },
    );
    try {
      let payload: { ok?: boolean } | null = null;
      for (let attempt = 0; attempt < 40 && !payload; attempt += 1) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 250));
        try {
          const response = await fetch(`http://127.0.0.1:${port}/api/health`);
          if (response.ok)
            payload = (await response.json()) as { ok?: boolean };
        } catch {
          // Bounded startup polling against the isolated PR88 process.
        }
      }
      assert.equal(payload?.ok, true);
      assert.equal(await db.internalSession.count(), countBefore);
      assert.deepEqual({
        keys: await db.applicationKeyVersion.count(),
        throttleBuckets: await db.loginThrottleBucket.count(),
        enabledFeatureGates: await db.applicationFeatureGate.count({ where: { enabled: true } }),
      }, n03Before);
    } finally {
      app.kill("SIGTERM");
      await new Promise<void>((resolveExit) => {
        app.once("exit", () => resolveExit());
      });
      rmSync(root, { recursive: true, force: true });
    }
  },
);
