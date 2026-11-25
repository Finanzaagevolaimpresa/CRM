import { createHmac, randomBytes } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { tokenDigestFromCookie } from './internal-session-registry';
import { lockRegisteredPrivilegedStepUpKey } from './application-key-registry';
import type { PrivilegedStepUpKey } from './privileged-step-up-token';
import { internalSessionMode } from './session';

import { ordinaryWindowEnabled, ordinaryActionAllowed } from './admin-ordinary-policy';
type Actor = { userId: string; sessionId?: string; role: string };
function fingerprint(key: PrivilegedStepUpKey, session: string, token: string) {
  return createHmac('sha256',key.secret).update('admin-ordinary-v1\0').update(session).update('\0').update(token).digest();
}
function eligible(actor: Actor) {
  return ordinaryWindowEnabled() && internalSessionMode() === 'registry' && actor.role === 'admin' && !!actor.sessionId;
}
export async function openOrdinaryWindow(db: PrismaClient, actor: Actor, key: PrivilegedStepUpKey, sessionToken: string, passwordHash: string) {
  if (!eligible(actor)) return null;
  const digest = await tokenDigestFromCookie(sessionToken);
  if (!digest) return null;
  const token = randomBytes(32).toString('base64url');
  return db.$transaction(async tx => {
    if (!await lockRegisteredPrivilegedStepUpKey(tx,key)) return null;
    const [user] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "User" WHERE id=${actor.userId}
      AND role='admin' AND active AND "deletedAt" IS NULL AND "passwordHash"=${passwordHash} FOR SHARE`;
    if (!user) return null;
    const [row] = await tx.$queryRaw<{ expiresAt: Date }[]>`UPDATE "InternalSession" SET
      "ordinaryConfirmedAt"=CURRENT_TIMESTAMP, "ordinaryLastActiveAt"=CURRENT_TIMESTAMP, "ordinaryKeyVersion"=${key.version},
      "ordinaryDigest"=${fingerprint(key,sessionToken,token)}, "expiresAt"=CURRENT_TIMESTAMP + INTERVAL '24 hours'
      WHERE id=${actor.sessionId}::uuid AND "userId"=${user.id} AND "tokenDigest"=${Buffer.from(digest)}
        AND "revokedAt" IS NULL AND "expiresAt">CURRENT_TIMESTAMP
        AND ("ordinaryLastActiveAt" IS NULL OR "ordinaryLastActiveAt">CURRENT_TIMESTAMP - INTERVAL '1 hour') RETURNING "expiresAt"`;
    return row ? { token, expiresAt: row.expiresAt } : null;
  });
}
export async function ordinaryWindowExpiry(db: PrismaClient, actor: Actor, action: string, key: PrivilegedStepUpKey,
  sessionToken: string, token: string | undefined, touch: boolean) {
  if (!eligible(actor) || !ordinaryActionAllowed(action) || !token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const digest = await tokenDigestFromCookie(sessionToken);
  if (!digest) return null;
  return db.$transaction(async tx => {
    if (!await lockRegisteredPrivilegedStepUpKey(tx,key)) return null;
    const where = Prisma.sql`s.id=${actor.sessionId}::uuid AND s."userId"=${actor.userId} AND s."tokenDigest"=${Buffer.from(digest)}
      AND s."revokedAt" IS NULL AND s."expiresAt">CURRENT_TIMESTAMP AND s."ordinaryKeyVersion"=${key.version}
      AND s."ordinaryDigest"=${fingerprint(key,sessionToken,token)}
      AND s."ordinaryConfirmedAt">CURRENT_TIMESTAMP - INTERVAL '24 hours'
      AND s."ordinaryLastActiveAt">CURRENT_TIMESTAMP - INTERVAL '1 hour'
      AND EXISTS (SELECT 1 FROM "User" u WHERE u.id=s."userId" AND u.role='admin' AND u.active AND u."deletedAt" IS NULL)`;
    const [row] = await tx.$queryRaw<{ expiresAt: Date }[]>(touch
      ? Prisma.sql`UPDATE "InternalSession" s SET "ordinaryLastActiveAt"=CURRENT_TIMESTAMP WHERE ${where} RETURNING s."expiresAt"`
      : Prisma.sql`SELECT s."expiresAt" FROM "InternalSession" s WHERE ${where}`);
    return row?.expiresAt.getTime() ?? null;
  });
}
export async function endOrdinaryWindow(db: PrismaClient, actor: Actor) {
  if (!actor.sessionId) return;
  await db.$executeRaw`UPDATE "InternalSession" SET "ordinaryConfirmedAt"=NULL, "ordinaryLastActiveAt"=NULL,
    "ordinaryKeyVersion"=NULL, "ordinaryDigest"=NULL, "expiresAt"=LEAST("expiresAt","createdAt" + INTERVAL '8 hours')
    WHERE id=${actor.sessionId}::uuid AND "userId"=${actor.userId} AND "ordinaryConfirmedAt" IS NOT NULL`;
}
