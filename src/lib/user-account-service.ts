import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { internalSessionMode } from './session';
import { lockAuthoritativeInternalSession, lockInternalUser, revokeAllInternalSessions } from './internal-session-registry';
import { accountProfileSchema } from './user-account-contract';

type Tx = Prisma.TransactionClient;
export type AccountActor = { userId: string; sessionId?: string };
type AccountResult = { ok: true; sessionRevoked: boolean } | { ok: false; message: string };
const deny = (): AccountResult => ({ ok: false, message: 'Operazione non consentita o account non disponibile.' });

async function actorForMutation(tx: Tx, actor: AccountActor, adminOnly: boolean) {
  if (internalSessionMode() !== 'registry' || !actor.sessionId) return null;
  const session = await lockAuthoritativeInternalSession(tx, { userId: actor.userId, sessionId: actor.sessionId });
  if (!session || session.revokedAt || !session.live || !session.active || session.deletedAt) return null;
  if (adminOnly && session.role !== 'admin') return null;
  return session;
}

async function record(tx: Tx, actor: AccountActor, userId: string, event: string) {
  // Account mutations never put submitted values or password hashes in the audit.
  await tx.auditLog.create({ data: { actorId: actor.userId, entityType: 'User', entityId: userId, event } });
}

export async function updateAccountProfile(tx: Tx, actor: AccountActor, userId: string, input: unknown): Promise<AccountResult> {
  const data = accountProfileSchema.parse(input);
  if (!await actorForMutation(tx, actor, actor.userId !== userId)) return deny();
  const locked = await lockInternalUser(tx, userId);
  if (!locked || locked.deletedAt) return deny();
  const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } });
  // Changing a login identifier is reserved to an administrator, including on their own account.
  const emailChanged = data.email !== user.email;
  if (emailChanged && !await actorForMutation(tx, actor, true)) return deny();
  await tx.user.update({ where: { id: userId }, data });
  if (emailChanged) await revokeAllInternalSessions(tx, userId, 'INTERNAL_GLOBAL', actor.userId);
  await record(tx, actor, userId, 'user_profile_updated');
  return { ok: true, sessionRevoked: emailChanged && actor.userId === userId };
}

export async function changeAccountPassword(
  tx: Tx, actor: AccountActor, input: { currentPassword: string; passwordHash: string },
): Promise<AccountResult> {
  if (!await actorForMutation(tx, actor, false)) return deny();
  const user = await tx.user.findUniqueOrThrow({ where: { id: actor.userId }, select: { passwordHash: true } });
  if (!await bcrypt.compare(input.currentPassword, user.passwordHash)) {
    await record(tx, actor, actor.userId, 'user_password_change_denied');
    return { ok: false, message: 'Password attuale non valida.' };
  }
  await tx.user.update({ where: { id: actor.userId }, data: { passwordHash: input.passwordHash } });
  await revokeAllInternalSessions(tx, actor.userId, 'INTERNAL_GLOBAL', actor.userId);
  await record(tx, actor, actor.userId, 'user_password_changed');
  return { ok: true, sessionRevoked: true };
}

export async function resetAccountPassword(
  tx: Tx, actor: AccountActor, userId: string, passwordHash: string,
): Promise<AccountResult> {
  if (!await actorForMutation(tx, actor, true) || actor.userId === userId) return deny();
  const user = await lockInternalUser(tx, userId);
  if (!user || user.deletedAt) return deny();
  await tx.user.update({ where: { id: userId }, data: { passwordHash } });
  await revokeAllInternalSessions(tx, userId, 'INTERNAL_GLOBAL', actor.userId);
  await record(tx, actor, userId, 'user_password_reset');
  return { ok: true, sessionRevoked: false };
}

export async function revokeAccountSessions(tx: Tx, actor: AccountActor, userId: string): Promise<AccountResult> {
  if (!await actorForMutation(tx, actor, actor.userId !== userId)) return deny();
  const user = await lockInternalUser(tx, userId);
  if (!user || user.deletedAt) return deny();
  await revokeAllInternalSessions(tx, userId, 'INTERNAL_GLOBAL', actor.userId);
  await record(tx, actor, userId, 'user_sessions_revoked');
  return { ok: true, sessionRevoked: actor.userId === userId };
}
