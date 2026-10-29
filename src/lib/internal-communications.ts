import { timingSafeEqual } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { AuthSession } from './auth';
import { hasPermission } from './permission-evaluator';
import { lockCommunicationDirectory } from './communication-directory-lock';
import { lockAuthoritativeInternalSession, tokenDigestFromCookie } from './internal-session-registry';
import { lockRegisteredPrivilegedStepUpKey } from './application-key-registry';
import { verifyPrivilegedStepUpToken, type PrivilegedStepUpKey } from './privileged-step-up-token';
import { privilegedAccessMode } from './application-security-policy';
import { canonicalSha256 } from './canonical-json';
import { ApprovedCommunicationError } from './approved-communication-contract';
import { emptyCommunicationRecipientSelection, resolveCommunicationRecipients, communicationRecipientSelectionSchema } from './communication-recipient-policy';

type Db = Pick<PrismaClient, '$transaction'>;
type Tx = Prisma.TransactionClient;
export type InternalCommunicationCredentials = { key: PrivilegedStepUpKey; sessionToken: string; stepUpToken?: string };
const inputSchema = z.object({ id: z.string().uuid(), expectedVersion: z.number().int().min(0),
  title: z.string().trim().min(1).max(200), selection: communicationRecipientSelectionSchema.shape.to }).strict();
function deny(): never { throw new ApprovedCommunicationError('DENIED'); }
function conflict(): never { throw new ApprovedCommunicationError('CONFLICT'); }
async function clock(tx: Tx) { return (await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`)[0].now; }

async function reader(tx: Tx, claimed: AuthSession) {
  if (!claimed.sessionId || !claimed.active || claimed.expiresAt * 1000 <= Date.now()) deny();
  await lockCommunicationDirectory(tx);
  const actor = await lockAuthoritativeInternalSession(tx, { userId: claimed.userId, sessionId: claimed.sessionId });
  if (!actor?.active || !actor.live || actor.revokedAt || actor.deletedAt || !hasPermission(actor, 'communications.internal.read')) deny();
  return actor;
}

/** Personal context administration is distinct from sending. It consumes no
 * email decision and creates no channel/binding/client or project grant. */
async function personal(tx: Tx, claimed: AuthSession, credentials: InternalCommunicationCredentials, write: boolean) {
  if (privilegedAccessMode() !== 'enforced' || !await lockRegisteredPrivilegedStepUpKey(tx, credentials.key)) deny();
  // Exclusive before actor locks for participant mutations: FK checks cannot
  // deadlock a new participant who concurrently opens this conversation.
  await lockCommunicationDirectory(tx, write);
  const actor = await reader(tx, claimed);
  if (actor.role !== 'admin' || !hasPermission(actor, 'practice_communications.write')) deny();
  const rows = await tx.$queryRaw<Array<{ userId: string; mailboxId: string; revision: number; enabled: boolean }>>`
    SELECT "userId","mailboxId","revision","enabled" FROM "OrdinaryEmailAuthority" WHERE "id"='ordinary-email' FOR SHARE`;
  const authority = rows[0];
  if (!authority?.enabled || authority.userId !== actor.userId) deny();
  const digest = await tokenDigestFromCookie(credentials.sessionToken);
  const registry = await tx.internalSession.findUnique({ where: { id: actor.id }, select: { tokenDigest: true } });
  if (!registry || !digest || digest.length !== registry.tokenDigest.length || !timingSafeEqual(digest, registry.tokenDigest)) deny();
  const finish = async () => {
    const now = await clock(tx);
    if (actor.expiresAt <= now || claimed.expiresAt * 1000 <= now.getTime()
      || (write && !verifyPrivilegedStepUpToken({ key: credentials.key, expectedUserId: actor.userId, role: actor.role,
        sessionToken: credentials.sessionToken, token: credentials.stepUpToken, nowSeconds: Math.floor(now.getTime() / 1000) }))) deny();
  };
  await finish();
  return { actor, authority, finish };
}

async function proposed(tx: Tx, claimed: AuthSession, raw: unknown, credentials: InternalCommunicationCredentials, write: boolean) {
  const input = inputSchema.parse(raw), admitted = await personal(tx, claimed, credentials, write);
  await tx.$queryRaw`SELECT "id" FROM "InternalCommunicationThread" WHERE "id"=${input.id}::uuid FOR UPDATE`;
  const existing = await tx.internalCommunicationThread.findUnique({ where: { id: input.id } });
  if (input.expectedVersion === 0 ? existing !== null : !existing || existing.deletedAt
    || existing.ownerUserId !== admitted.actor.userId || existing.version !== input.expectedVersion) conflict();
  if (existing) {
    const owner = await tx.internalCommunicationParticipant.findUnique({ where: { threadId_userId: { threadId: input.id, userId: admitted.actor.userId } } });
    if (!owner?.active) deny();
  }
  const directory = await tx.user.findMany({ select: { id: true, name: true, email: true, role: true, active: true, deletedAt: true }, orderBy: { id: 'asc' } });
  const selected = resolveCommunicationRecipients({ ...emptyCommunicationRecipientSelection(), to: input.selection }, directory, { to: [], cc: [], bcc: [] });
  const ids = [...new Set([admitted.actor.userId, ...selected.people.to.map(person => person.id)])].sort();
  const before = existing ? await tx.internalCommunicationParticipant.findMany({ where: { threadId: existing.id }, orderBy: { userId: 'asc' } }) : [];
  const evidenceHash = canonicalSha256({ input, ids, directoryHash: selected.evidenceHash,
    before: before.map(({ createdAt, updatedAt, ...participant }) => ({ ...participant,
      createdAt: createdAt.toISOString(), updatedAt: updatedAt.toISOString() })),
    authorityRevision: admitted.authority.revision, actorId: admitted.actor.userId, sessionId: admitted.actor.id });
  const people = directory.filter(person => ids.includes(person.id)).map(({ id, name, email, role }) => ({ id, name, email, role }));
  await admitted.finish();
  return { input, admitted, ids, people, before, evidenceHash };
}

export async function previewInternalCommunication(db: Db, claimed: AuthSession, raw: unknown, credentials: InternalCommunicationCredentials) {
  return db.$transaction(async tx => {
    const p = await proposed(tx, claimed, raw, credentials, false);
    return { input: p.input, people: p.people, removedUserIds: p.before.filter(person => person.active && !p.ids.includes(person.userId)).map(person => person.userId), evidenceHash: p.evidenceHash };
  }, { timeout: 30_000 });
}

export async function confirmInternalCommunication(db: Db, claimed: AuthSession, raw: unknown, evidenceHash: string,
  credentials: InternalCommunicationCredentials) {
  if (!/^[a-f0-9]{64}$/.test(evidenceHash)) deny();
  return db.$transaction(async tx => {
    const p = await proposed(tx, claimed, raw, credentials, true);
    if (p.evidenceHash !== evidenceHash) conflict();
    const now = await clock(tx), version = p.input.expectedVersion + 1;
    if (p.input.expectedVersion === 0) await tx.internalCommunicationThread.create({ data: { id: p.input.id,
      title: p.input.title, ownerUserId: p.admitted.actor.userId, version, createdAt: now, updatedAt: now } });
    else await tx.internalCommunicationThread.update({ where: { id: p.input.id, version: p.input.expectedVersion },
      data: { title: p.input.title, version, updatedAt: now } });
    for (const person of p.before) if (person.active && !p.ids.includes(person.userId))
      await tx.internalCommunicationParticipant.update({ where: { threadId_userId: { threadId: p.input.id, userId: person.userId } },
        data: { active: false, version: { increment: 1 }, updatedAt: now } });
    for (const userId of p.ids) {
      const previous = p.before.find(person => person.userId === userId);
      if (!previous) await tx.internalCommunicationParticipant.create({ data: { threadId: p.input.id, userId, createdAt: now, updatedAt: now } });
      else if (!previous.active) await tx.internalCommunicationParticipant.update({ where: { threadId_userId: { threadId: p.input.id, userId } },
        data: { active: true, version: { increment: 1 }, updatedAt: now } });
    }
    await tx.auditLog.create({ data: { actorId: p.admitted.actor.userId, entityType: 'InternalCommunicationThread',
      entityId: p.input.id, event: 'internal_communication_participants_confirmed', after: { version,
        participants: p.ids.length, evidenceHash, scope: 'INTERNAL_CONVERSATION_ONLY' } } });
    await p.admitted.finish();
    return { id: p.input.id, version };
  }, { timeout: 30_000 });
}

export async function listInternalCommunications(db: Db, claimed: AuthSession) {
  return db.$transaction(async tx => {
    const actor = await reader(tx, claimed);
    const rows = await tx.$queryRaw<Array<{ id: string; title: string; version: number; updatedAt: Date }>>`
      SELECT t."id",t."title",t."version",t."updatedAt" FROM "InternalCommunicationThread" t
      JOIN "InternalCommunicationParticipant" p ON p."threadId"=t."id" AND p."userId"=${actor.userId} AND p."active"
      JOIN "User" owner ON owner."id"=t."ownerUserId" AND owner."active" AND owner."deletedAt" IS NULL
      WHERE t."deletedAt" IS NULL ORDER BY t."updatedAt" DESC,t."id" LIMIT 100 FOR SHARE OF t,p`;
    const now = await clock(tx);
    if (actor.expiresAt <= now || claimed.expiresAt * 1000 <= now.getTime()) deny();
    return rows;
  }, { timeout: 30_000 });
}

export async function readCommunicationDirectory(db: Db, claimed: AuthSession) {
  return db.$transaction(async tx => {
    const actor = await reader(tx, claimed);
    if (actor.role !== 'admin') deny();
    const people = await tx.user.findMany({ where: { active: true, deletedAt: null },
      select: { id: true, name: true, email: true, role: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }] });
    const now = await clock(tx);
    if (actor.expiresAt <= now || claimed.expiresAt * 1000 <= now.getTime()) deny();
    return people;
  }, { timeout: 30_000 });
}
