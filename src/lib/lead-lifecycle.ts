import { timingSafeEqual } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { AuthSession } from './auth';
import { lockRegisteredPrivilegedStepUpKey } from './application-key-registry';
import { privilegedAccessMode } from './application-security-policy';
import { tokenDigestFromCookie } from './internal-session-registry';
import { acquireLeadIdentityWriteLock } from './lead-identity';
import { verifyPrivilegedStepUpToken, type PrivilegedStepUpKey } from './privileged-step-up-token';
import { withSerializableTransaction } from './serializable';
import { leadLifecycleSchema, leadLifecycleActionAllowed } from './lead-lifecycle-policy';
import { LeadLifecycleError, lockLeadActor, assertLeadActorLive, leadClock } from './lead-lifecycle-lock';

export type LeadLifecycleCredentials = { sessionToken: string; stepUpToken: string; key: PrivilegedStepUpKey };
async function personalConfirmation(tx: Prisma.TransactionClient, actor: AuthSession, proof: LeadLifecycleCredentials) {
  const now = await leadClock(tx);
  if (privilegedAccessMode() !== 'enforced' || !await lockRegisteredPrivilegedStepUpKey(tx, proof.key)) throw new LeadLifecycleError('DENIED');
  const digest = await tokenDigestFromCookie(proof.sessionToken);
  const session = await tx.internalSession.findUnique({ where: { id: actor.sessionId! }, select: { tokenDigest: true } });
  if (!digest || !session || digest.length !== session.tokenDigest.length || !timingSafeEqual(digest, session.tokenDigest)
    || !verifyPrivilegedStepUpToken({ key: proof.key, expectedUserId: actor.userId, sessionToken: proof.sessionToken,
      token: proof.stepUpToken, nowSeconds: Math.floor(now.getTime() / 1000) })) throw new LeadLifecycleError('DENIED');
}
export async function transitionLeadLifecycle(db: PrismaClient, claimed: AuthSession, raw: unknown, proof: LeadLifecycleCredentials) {
  const input = leadLifecycleSchema.parse(raw);
  return withSerializableTransaction(db, async tx => {
    // Same ordering as identity/profile writers: no concurrent intake can
    // create an active duplicate across this transition.
    await acquireLeadIdentityWriteLock(tx);
    const current = await lockLeadActor(tx, claimed);
    if (current.role !== 'admin') throw new LeadLifecycleError('DENIED');
    await personalConfirmation(tx, current, proof);
    await tx.$queryRaw`SELECT "id" FROM "Lead" WHERE "id"=${input.id} FOR UPDATE`;
    const before = await tx.lead.findUnique({ where: { id: input.id } });
    if (!before) throw new LeadLifecycleError('DENIED');
    if (before.updatedAt.toISOString() !== input.updatedAt || !leadLifecycleActionAllowed(before.deletedAt, input.action)) throw new LeadLifecycleError('STALE');
    const now = await leadClock(tx);
    const updatedAt = new Date(Math.max(now.getTime(), before.updatedAt.getTime() + 1));
    const after = await tx.lead.update({ where: { id: before.id, updatedAt: before.updatedAt },
      data: { deletedAt: input.action === 'trash' ? now : null, updatedAt } });
    // Invalidate old N14 commands without closing/reopening its SLA cycle,
    // changing attribution, or claiming a customer response.
    await tx.$queryRaw`SELECT "id" FROM "CommercialLeadInboxItem" WHERE "leadId"=${before.id} FOR UPDATE`;
    await tx.commercialLeadInboxItem.updateMany({ where: { leadId: before.id }, data: { version: { increment: 1 } } });
    await tx.auditLog.create({ data: { actorId: current.userId, entityType: 'Lead', entityId: before.id,
      event: 'lead_lifecycle_changed', createdAt: now,
      before: { status: before.status, deletedAt: before.deletedAt?.toISOString() ?? null },
      after: { leadId: before.id, action: input.action, status: after.status,
        deletedAt: after.deletedAt?.toISOString() ?? null, stateVersion: updatedAt.toISOString(),
        reasonCode: input.reasonCode || null } } });
    await assertLeadActorLive(tx, current);
    await personalConfirmation(tx, current, proof);
    return { id: after.id, state: after.deletedAt ? 'trash' as const : 'active' as const };
  });
}
export async function listTrashedLeads(db: PrismaClient, claimed: AuthSession, page: number) {
  return withSerializableTransaction(db, async tx => {
    const current = await lockLeadActor(tx, claimed, false);
    if (current.role !== 'admin') throw new LeadLifecycleError('DENIED');
    const rows = await tx.lead.findMany({ where: { deletedAt: { not: null } }, orderBy: [{ deletedAt: 'desc' }, { id: 'asc' }],
      skip: (Math.max(1, Math.min(10_000, Math.trunc(page))) - 1) * 30, take: 31,
      select: { id: true, companyName: true, firstName: true, lastName: true, status: true, deletedAt: true, updatedAt: true, clientId: true } });
    await assertLeadActorLive(tx, current);
    return { items: rows.slice(0, 30), hasNext: rows.length > 30 };
  });
}
