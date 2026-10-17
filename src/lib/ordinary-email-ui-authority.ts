import { timingSafeEqual } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { AuthSession } from './auth';
import { lockRegisteredPrivilegedStepUpKey } from './application-key-registry';
import { lockAuthoritativeInternalSession, tokenDigestFromCookie } from './internal-session-registry';
import { hasPermission } from './permission-evaluator';
import { verifyPrivilegedStepUpToken, type PrivilegedStepUpKey } from './privileged-step-up-token';

/** A UI hint for messages already admitted by the ordinary communication read.
 * It never authorizes a decision: preview/refusal reload the complete context,
 * bytes, qualifications, current binding and credentials in their transaction. */
export async function readOrdinaryEmailUiAuthority(db: Pick<PrismaClient, '$transaction'>, claimed: AuthSession,
  key: PrivilegedStepUpKey, credentials: { sessionToken: string; stepUpToken?: string }) {
  return db.$transaction(async tx => {
    const [tables] = await tx.$queryRaw<Array<{ present: number }>>`SELECT count(*)::integer AS present FROM
      (VALUES (to_regclass('public."OrdinaryEmailAuthority"')), (to_regclass('public."OrdinaryEmailChannel"')),
        (to_regclass('public."OrdinaryEmailAttempt"')), (to_regclass('public."OrdinaryEmailDecision"')),
        (to_regclass('public."OrdinaryEmailClaim"')), (to_regclass('public."OrdinaryEmailOutcome"'))) AS candidate(relation) WHERE relation IS NOT NULL`;
    if (tables.present === 0) return null;
    if (tables.present !== 6) throw new Error('ORDINARY_EMAIL_UI_UNAVAILABLE');
    if (!claimed.sessionId || !await lockRegisteredPrivilegedStepUpKey(tx, key)) return null;
    const actor = await lockAuthoritativeInternalSession(tx, { userId: claimed.userId, sessionId: claimed.sessionId });
    if (!actor || !actor.live || actor.revokedAt || actor.deletedAt || !actor.active || actor.role !== 'admin'
      || !hasPermission(actor, 'practice_communications.read') || !hasPermission(actor, 'practice_communications.mark_used')) return null;
    const digest = await tokenDigestFromCookie(credentials.sessionToken);
    const registry = await tx.internalSession.findUnique({ where: { id: claimed.sessionId }, select: { tokenDigest: true } });
    if (!digest || !registry || digest.length !== registry.tokenDigest.length || !timingSafeEqual(digest, registry.tokenDigest)) return null;
    const rows = await tx.$queryRaw<Array<{ mailboxId: string }>>`SELECT a."mailboxId" FROM "OrdinaryEmailAuthority" a
      JOIN "OrdinaryEmailChannel" c ON c."mailboxId"=a."mailboxId"
      JOIN "CommunicationMailbox" b ON b."id"=a."mailboxId"
      WHERE a."id"='ordinary-email' AND a."enabled" AND a."userId"=${actor.userId}
        AND c."enabled" AND c."mailboxRevision"=b."revision" AND b."kind"='MAILBOX' AND b."canonicalMailboxId" IS NULL
        AND b."address"='comunicazioni@finanzaagevolaimpresa.it' AND b."providerReference"='register_it'
        AND b."configurationReference"='M4_COMUNICAZIONI_REGISTER_IT' AND b."enabled" AND b."canSend"
        AND b."configuredRevision"=b."revision" AND b."testedRevision"=b."revision"`;
    const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    if (!rows[0] || !claimed.active || actor.expiresAt <= clock.now || claimed.expiresAt * 1000 <= clock.now.getTime()) return null;
    return { mailboxId: rows[0].mailboxId, stepUpActive: Boolean(verifyPrivilegedStepUpToken({ key,
      expectedUserId: actor.userId, sessionToken: credentials.sessionToken, token: credentials.stepUpToken,
      nowSeconds: Math.floor(clock.now.getTime() / 1000) })) };
  }, { timeout: 30_000 });
}
