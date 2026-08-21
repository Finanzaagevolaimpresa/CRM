import { Prisma, type PrismaClient, type RoleCode } from "@prisma/client";
import { randomUUID } from "node:crypto";
import {
  digestRegistrySessionToken,
  parseRegistrySessionToken,
  SESSION_TTL_SECONDS,
} from "./session";

type Db = PrismaClient | Prisma.TransactionClient;
export type RegistryLoginSessionInput = {
  userId: string;
  tokenDigest: Uint8Array;
};
export async function tokenDigestFromCookie(cookie: string | undefined) {
  const bytes = parseRegistrySessionToken(cookie);
  return bytes ? digestRegistrySessionToken(bytes) : null;
}
export async function lockInternalUser(
  tx: Prisma.TransactionClient,
  userId: string,
) {
  const rows = await tx.$queryRaw<
    Array<{ id: string; active: boolean; deletedAt: Date | null }>
  >(
    Prisma.sql`SELECT "id","active","deletedAt" FROM "User" WHERE "id"=${userId} FOR UPDATE`,
  );
  return rows[0] ?? null;
}
export async function createInternalSession(
  tx: Prisma.TransactionClient,
  input: { userId: string; tokenDigest: Uint8Array },
) {
  const rows = await tx.$queryRaw<
    Array<{
      id: string;
      userId: string;
      tokenDigest: Buffer;
      createdAt: Date;
      expiresAt: Date;
      revokedAt: Date | null;
      revokedReason: string | null;
      revokedByUserId: string | null;
    }>
  >(
    Prisma.sql`INSERT INTO "InternalSession" ("id","userId","tokenDigest","createdAt","expiresAt") VALUES (${randomUUID()}::uuid,${input.userId},${Buffer.from(input.tokenDigest)},CURRENT_TIMESTAMP,CURRENT_TIMESTAMP+(${SESSION_TTL_SECONDS}*INTERVAL '1 second')) RETURNING *`,
  );
  return rows[0]!;
}
export async function createRegistryLoginSession(
  db: PrismaClient,
  input: RegistryLoginSessionInput,
) {
  return db.$transaction(async (tx) => {
    const user = await lockInternalUser(tx, input.userId);
    if (!user?.active || user.deletedAt) return null;

    const session = await createInternalSession(tx, input);
    await tx.$executeRaw(
      Prisma.sql`UPDATE "User" SET "lastLoginAt"=CURRENT_TIMESTAMP WHERE "id"=${user.id}`,
    );
    await tx.auditLog.create({
      data: {
        actorId: user.id,
        event: "login",
        entityType: "User",
        entityId: user.id,
        after: {
          sessionId: session.id,
          expiresAt: session.expiresAt.toISOString(),
        },
      },
    });
    return session;
  });
}
export function authoritativeInternalSessionLookupQuery(
  digest: Uint8Array,
) {
  return Prisma.sql`
    SELECT s."id", s."userId", s."expiresAt", u."role", u."active", u."deletedAt"
    FROM "InternalSession" s
    JOIN "User" u ON u."id" = s."userId"
    WHERE s."tokenDigest" = ${Buffer.from(digest)}
      AND s."revokedAt" IS NULL
      AND s."expiresAt" > CURRENT_TIMESTAMP
      AND u."active" = TRUE
      AND u."deletedAt" IS NULL
    LIMIT 1
  `;
}
export async function resolveInternalSession(
  db: Db,
  cookie: string | undefined,
) {
  const digest = await tokenDigestFromCookie(cookie);
  if (!digest) return null;
  const rows = await db.$queryRaw<
    Array<{
      id: string;
      userId: string;
      expiresAt: Date;
      role: RoleCode;
      active: boolean;
      deletedAt: Date | null;
    }>
  >(authoritativeInternalSessionLookupQuery(digest));
  const row = rows[0];
  if (!row) return null;
  const permissionOverrides = await db.userPermissionOverride.findMany({
    where: { userId: row.userId },
    select: { permission: true, allowed: true },
  });
  return {
    id: row.id,
    userId: row.userId,
    expiresAt: row.expiresAt,
    user: {
      id: row.userId,
      role: row.role,
      active: row.active,
      deletedAt: row.deletedAt,
      permissionOverrides,
    },
  };
}
export async function lockAuthoritativeInternalSession(
  tx: Prisma.TransactionClient,
  input: { sessionId: string; userId: string },
) {
  const rows = await tx.$queryRaw<Array<{
    id: string;
    userId: string;
    expiresAt: Date;
    revokedAt: Date | null;
    live: boolean;
    role: RoleCode;
    active: boolean;
    deletedAt: Date | null;
  }>>(Prisma.sql`
    SELECT session_row."id", session_row."userId", session_row."expiresAt",
      session_row."revokedAt", session_row."expiresAt" > CURRENT_TIMESTAMP AS "live",
      user_row."role", user_row."active", user_row."deletedAt"
    FROM "InternalSession" session_row
    JOIN "User" user_row ON user_row."id" = session_row."userId"
    WHERE session_row."id" = ${input.sessionId}::UUID
      AND session_row."userId" = ${input.userId}
    FOR UPDATE OF session_row, user_row
  `);
  const session = rows[0];
  if (!session) return null;
  const permissionOverrides = await tx.$queryRaw<
    Array<{ permission: string; allowed: boolean }>
  >(Prisma.sql`
    SELECT "permission", "allowed"
    FROM "UserPermissionOverride"
    WHERE "userId" = ${session.userId}
    ORDER BY "permission"
    FOR SHARE
  `);
  return Object.freeze({
    ...session,
    permissionOverrides: Object.freeze(permissionOverrides),
  });
}
export async function revokeInternalSession(
  tx: Prisma.TransactionClient,
  id: string,
  reason: "INTERNAL_SINGLE",
  actor: string | null,
) {
  const exists = await tx.internalSession.findUnique({
    where: { id },
    select: { id: true, userId: true },
  });
  if (!exists) return { count: 0 };
  const count = await tx.$executeRaw(
    Prisma.sql`UPDATE "InternalSession" SET "revokedAt"=CURRENT_TIMESTAMP,"revokedReason"=${reason},"revokedByUserId"=${actor} WHERE "id"=${id}::uuid AND "revokedAt" IS NULL`,
  );
  if (count === 1)
    await tx.auditLog.create({
      data: {
        actorId: actor,
        event: "session_revoked",
        entityType: "InternalSession",
        entityId: id,
        after: { reason, targetUserId: exists.userId },
      },
    });
  return { count };
}
export async function revokeAllInternalSessions(
  tx: Prisma.TransactionClient,
  userId: string,
  reason: "USER_DISABLED" | "INTERNAL_GLOBAL",
  actor: string | null,
) {
  const count = await tx.$executeRaw(
    Prisma.sql`UPDATE "InternalSession" SET "revokedAt"=CURRENT_TIMESTAMP,"revokedReason"=${reason},"revokedByUserId"=${actor} WHERE "userId"=${userId} AND "revokedAt" IS NULL`,
  );
  if (count > 0) {
    await tx.auditLog.create({
      data: {
        actorId: actor,
        event: "sessions_revoked_global",
        entityType: "User",
        entityId: userId,
        after: { reason, revokedCount: count },
      },
    });
  }
  return { count };
}
export async function logoutInternalSession(
  tx: Prisma.TransactionClient,
  cookie: string | undefined,
) {
  const digest = await tokenDigestFromCookie(cookie);
  if (!digest) return null;
  const rows = await tx.$queryRaw<Array<{ id: string; userId: string }>>(
    Prisma.sql`SELECT "id","userId" FROM "InternalSession" WHERE "tokenDigest"=${Buffer.from(digest)} AND "revokedAt" IS NULL AND "expiresAt">CURRENT_TIMESTAMP LIMIT 1`,
  );
  const session = rows[0];
  if (!session) return null;
  const count = await tx.$executeRaw(
    Prisma.sql`UPDATE "InternalSession" SET "revokedAt"=CURRENT_TIMESTAMP,"revokedReason"='LOGOUT',"revokedByUserId"=${session.userId} WHERE "id"=${session.id}::uuid AND "revokedAt" IS NULL AND "expiresAt">CURRENT_TIMESTAMP`,
  );
  if (count !== 1) return null;
  await tx.auditLog.create({
    data: {
      actorId: session.userId,
      event: "logout",
      entityType: "User",
      entityId: session.userId,
      after: { sessionId: session.id, reason: "LOGOUT" },
    },
  });
  return session;
}
export async function countLiveInternalSessions(db: PrismaClient) {
  const rows = await db.$queryRaw<Array<{ count: bigint }>>(
    Prisma.sql`SELECT COUNT(*)::bigint count FROM "InternalSession" WHERE "revokedAt" IS NULL AND "expiresAt">CURRENT_TIMESTAMP`,
  );
  return rows[0]?.count ?? 0n;
}
export async function assertRegistryActivationReady(db: PrismaClient) {
  if ((await countLiveInternalSessions(db)) !== 0n)
    throw new Error("INTERNAL_SESSION_REGISTRY_ACTIVATION_BLOCKED");
}
