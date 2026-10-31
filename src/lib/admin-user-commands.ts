import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { createHmac } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { AuthSession } from './auth';
import { updateActor, type UpdateCredentials } from './record-updates';
import { lockRegisteredPrivilegedStepUpKey } from './application-key-registry';
import { lockCommunicationDirectory } from './communication-directory-lock';
import { recordUpdatePermission } from './record-update-context';
import { canonicalSha256 } from './canonical-json';
import { adminUserCommandIdentity, adminUserVersion, type AdminUserCommandIdentity } from './admin-user-command-contract';
import { internalUserSchema, userRoleSchema, userPermissionOverridesSchema } from './validation';
import { accountPasswordSchema, accountProfileSchema, passwordResetSchema } from './user-account-contract';
import { updateAccountProfile, resetAccountPassword, restoreRemovedAccount, revokeAccountSessions } from './user-account-service';
import { lockAuthoritativeInternalSession, revokeInternalSession } from './internal-session-registry';
import { createInternalUserWithAudit, activateInternalUserWithAudit, deactivateInternalUserWithAudit,
  updateInternalUserRoleWithAudit, updatePermissionOverridesWithAudit, resetPermissionOverridesWithAudit, removeInternalUserWithAudit } from './user-privilege-service';
import { mapSerializableConflict } from './serializable';
import { loadAdminRoleProfile } from './admin-role-profile-store';

type Tx = Prisma.TransactionClient;
export class AdminUserCommandError extends Error {
  constructor(readonly code: 'DENIED' | 'STALE' | 'CLOSED') { super(`ADMIN_USER_${code}`); }
}
function fail(code: AdminUserCommandError['code']): never { throw new AdminUserCommandError(code); }
async function transaction<T>(db: PrismaClient, operation: (tx: Tx) => Promise<T>) {
  try { return await db.$transaction(async tx => {
    const result = await operation(tx);
    await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
    return result;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 }); }
  catch (error) { throw mapSerializableConflict(error); }
}
async function authority(tx: Tx, actor: AuthSession, proof?: UpdateCredentials) {
  if (proof && !await lockRegisteredPrivilegedStepUpKey(tx, proof.key)) fail('DENIED');
  await lockCommunicationDirectory(tx, true);
  const current = await updateActor(tx, actor, proof);
  if (current.actor.role !== 'admin' || !recordUpdatePermission(current.actor, 'user.write') || !recordUpdatePermission(current.actor, 'user.read')) fail('DENIED');
  return current;
}
async function commandLock(tx: Tx, commandId: string) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`admin-user:${commandId}`},0))::text`;
}
const select = { id: true, name: true, email: true, role: true, active: true, deletedAt: true, updatedAt: true,
  permissionOverrides: { select: { permission: true, allowed: true } } } as const;
function receipt(row: { commandId: string; recordId: string; operation: string }) {
  return { commandId: row.commandId, userId: row.recordId, closed: row.operation === 'CLOSE' };
}
async function journal(tx: Tx, actor: AuthSession, input: AdminUserCommandIdentity, operation: 'CREATE' | 'UPDATE' | 'CLOSE', requestHash: string,
  beforeHash: string, afterHash: string) {
  // The journal stores only references and hashes. No passwords, password hashes,
  // tokens, submitted names or email addresses are copied into the command receipt.
  await tx.adminRecordRevision.create({ data: { commandId: input.commandId, actorId: actor.userId, sessionId: actor.sessionId!,
    model: 'User', recordId: input.userId, operation, requestHash, beforeHash, afterHash,
    before: operation === 'UPDATE' ? { id: input.userId, stateHash: beforeHash } : Prisma.JsonNull,
    after: operation === 'CLOSE' ? Prisma.JsonNull : { id: input.userId, operation: input.operation, stateHash: afterHash },
    reason: `Comando account ${input.operation}` } });
  await tx.auditLog.create({ data: { id: `admin-record:${input.commandId}`, actorId: actor.userId, entityType: 'User', entityId: input.userId,
    event: operation === 'CLOSE' ? 'admin_record_attempt_closed' : 'admin_record_changed',
    after: { commandId: input.commandId, action: operation, beforeHash, afterHash } } });
}
export async function executeAdminUserCommand(db: PrismaClient, actor: AuthSession, rawIdentity: unknown,
  values: Record<string, unknown>, proof: UpdateCredentials) {
  const input = adminUserCommandIdentity.parse(rawIdentity);
  const created = input.operation === 'CREATE' ? internalUserSchema.parse(values) : null;
  if (created) accountPasswordSchema.parse(created.password);
  const role = input.operation === 'ROLE' ? userRoleSchema.parse({ userId: input.userId, role: values.role }).role : null;
  const overrides = input.operation === 'OVERRIDES' ? userPermissionOverridesSchema.parse({ userId: input.userId, overrides: values.overrides }).overrides : null;
  const profile = input.operation === 'PROFILE' ? accountProfileSchema.parse(values) : null;
  const reset = input.operation === 'PASSWORD_RESET' ? passwordResetSchema.parse(values) : null;
  const targetSession = input.operation === 'REVOKE_SESSION' ? z.string().uuid().parse(values.sessionId) : null;
  if (input.operation === 'REMOVE') z.literal(true).parse(values.retainHistory);
  if (input.operation === 'RESTORE') z.literal(true).parse(values.restoreInactive);
  if (input.operation === 'APPLY_ROLE_PROFILE') z.literal(true).parse(values.confirmed);
  // Own profile/password/session changes retain their dedicated logout flow.
  if (['PROFILE', 'PASSWORD_RESET', 'REMOVE', 'RESTORE', 'REVOKE_SESSIONS', 'REVOKE_SESSION'].includes(input.operation) && input.userId === actor.userId) fail('DENIED');
  const requestHash = createHmac('sha256', proof.key.secret).update(JSON.stringify({ domain: 'FAI_ADMIN_USER_COMMAND_V1', input, values })).digest('hex');
  const passwordHash = created || reset ? await bcrypt.hash((created ?? reset)!.password, 12) : null;
  return transaction(db, async tx => {
    const current = await authority(tx, actor, proof); await commandLock(tx, input.commandId);
    const existing = await tx.adminRecordRevision.findUnique({ where: { commandId: input.commandId } });
    if (existing) {
      if (existing.model !== 'User' || existing.actorId !== actor.userId || existing.recordId !== input.userId) fail('DENIED');
      if (existing.operation === 'CLOSE') fail('CLOSED');
      if (existing.requestHash !== requestHash) fail('STALE');
      await current.finish(); return receipt(existing);
    }
    const before = await tx.user.findUnique({ where: { id: input.userId }, select });
    if (adminUserVersion(before) !== input.expectedVersion || (input.operation === 'CREATE' ? Boolean(before)
      : input.operation === 'RESTORE' ? !before?.deletedAt : !before || before.deletedAt)) fail('STALE');
    let result: { ok: boolean; value?: unknown };
    if (created) {
      const preset = await loadAdminRoleProfile(tx, created.role);
      if ((values.roleProfileVersion != null || (preset.current?.revision ?? 0) > 0) && values.roleProfileVersion !== preset.version) fail('STALE');
      result = await createInternalUserWithAudit(tx, actor, { id: input.userId, name: created.name, email: created.email,
        role: created.role, active: created.active ?? true, passwordHash: passwordHash! });
      if (result.ok && preset.current && preset.current.revision > 0) {
        result = await updatePermissionOverridesWithAudit(tx, actor, input.userId, preset.current.overrides);
        if (result.ok) await tx.auditLog.create({ data: { actorId: actor.userId, event: 'admin_role_profile_applied', entityType: 'User', entityId: input.userId,
          after: { role: created.role, profileRevision: preset.current.revision, profileHash: preset.version, existingAccount: false } } });
      }
    }
    else if (input.operation === 'APPLY_ROLE_PROFILE') {
      if (!before || before.role === 'admin') fail('DENIED');
      const preset = await loadAdminRoleProfile(tx, before.role);
      if (values.roleProfileVersion !== preset.version) fail('STALE');
      result = await updatePermissionOverridesWithAudit(tx, actor, input.userId, preset.current!.overrides);
      if (result.ok) await tx.auditLog.create({ data: { actorId: actor.userId, event: 'admin_role_profile_applied', entityType: 'User', entityId: input.userId,
        after: { role: before.role, profileRevision: preset.current!.revision, profileHash: preset.version, existingAccount: true } } });
    }
    else if (input.operation === 'ROLE') result = await updateInternalUserRoleWithAudit(tx, actor, input.userId, role!);
    else if (input.operation === 'ACTIVATE') result = await activateInternalUserWithAudit(tx, actor, input.userId);
    else if (input.operation === 'DEACTIVATE') result = await deactivateInternalUserWithAudit(tx, actor, input.userId);
    else if (input.operation === 'OVERRIDES') result = await updatePermissionOverridesWithAudit(tx, actor, input.userId,
      overrides!.filter(row => row.value !== 'inherit').map(row => ({ permission: row.permission, allowed: row.value === 'allow' })));
    else if (input.operation === 'RESET_OVERRIDES') result = await resetPermissionOverridesWithAudit(tx, actor, input.userId);
    else if (profile) result = await updateAccountProfile(tx, actor, input.userId, profile, true);
    else if (reset) result = await resetAccountPassword(tx, actor, input.userId, passwordHash!);
    else if (input.operation === 'REMOVE') result = await removeInternalUserWithAudit(tx, actor, input.userId, true);
    else if (input.operation === 'RESTORE') result = await restoreRemovedAccount(tx, actor, input.userId, proof);
    else if (input.operation === 'REVOKE_SESSIONS') result = await revokeAccountSessions(tx, actor, input.userId);
    else if (targetSession) {
      const target = await lockAuthoritativeInternalSession(tx, { userId: input.userId, sessionId: targetSession });
      if (!target || target.revokedAt || !target.live) fail('STALE');
      result = { ok: (await revokeInternalSession(tx, targetSession, 'INTERNAL_SINGLE', actor.userId)).count === 1 };
    } else fail('DENIED');
    if (!result.ok) fail('DENIED');
    const after = await tx.user.findUniqueOrThrow({ where: { id: input.userId }, select });
    await current.finish();
    await journal(tx, actor, input, created ? 'CREATE' : 'UPDATE', requestHash, adminUserVersion(before), adminUserVersion(after));
    await current.finish(); return { commandId: input.commandId, userId: input.userId, closed: false };
  });
}
export async function reconcileAdminUserCommand(db: PrismaClient, actor: AuthSession, rawIdentity: unknown, close = false) {
  const input = adminUserCommandIdentity.parse(rawIdentity);
  return transaction(db, async tx => {
    const current = await authority(tx, actor); await commandLock(tx, input.commandId);
    const existing = await tx.adminRecordRevision.findUnique({ where: { commandId: input.commandId } });
    if (existing) {
      if (existing.model !== 'User' || existing.actorId !== actor.userId || existing.recordId !== input.userId) fail('DENIED');
      await current.finish(); return receipt(existing);
    }
    if (!close) return null;
    const empty = canonicalSha256(null);
    await journal(tx, actor, input, 'CLOSE', canonicalSha256(input), empty, empty);
    await current.finish(); return { commandId: input.commandId, userId: input.userId, closed: true };
  });
}
