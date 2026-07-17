import { Prisma, type RoleCode, type User } from '@prisma/client';
import { serializableOptions } from './serializable';

export type PrivilegeActor = { userId: string };
export type PrivilegeResult<T = unknown> = { ok: true; value: T } | { ok: false; message: string };

type Tx = Prisma.TransactionClient;
type ActorUser = Pick<User, 'id' | 'role' | 'active' | 'deletedAt'>;

function denied(message: string): PrivilegeResult<never> { return { ok: false, message }; }

async function auditTx(tx: Tx, actorId: string, event: string, entityType: string, entityId?: string, after?: unknown, before?: unknown) {
  await tx.auditLog.create({ data: { actorId, event, entityType, entityId, before: before as Prisma.InputJsonValue, after: after as Prisma.InputJsonValue } });
}

async function auditBlocked(tx: Tx, actor: PrivilegeActor, targetId: string, after: unknown, before?: unknown) {
  await auditTx(tx, actor.userId, 'blocked_user_privilege_change', 'User', targetId, after, before);
}

async function loadActor(tx: Tx, actor: PrivilegeActor): Promise<ActorUser | null> {
  return tx.user.findFirst({ where: { id: actor.userId, deletedAt: null }, select: { id: true, role: true, active: true, deletedAt: true } });
}

async function requireAdminActor(tx: Tx, actor: PrivilegeActor, targetId: string, action: string, after: unknown) {
  const actorUser = await loadActor(tx, actor);
  if (!actorUser || !actorUser.active || actorUser.role !== 'admin') {
    await auditBlocked(tx, actor, targetId, { action, ...typeof after === 'object' && after ? after : { detail: after } }, actorUser ? { role: actorUser.role, active: actorUser.active } : { missing: true });
    return null;
  }
  return actorUser;
}

async function activeAdminCount(tx: Tx) { return tx.user.count({ where: { role: 'admin', active: true, deletedAt: null } }); }
async function loadMutableUser(tx: Tx, id: string) {
  const user = await tx.user.findUnique({ where: { id }, include: { permissionOverrides: true } });
  if (!user || user.deletedAt) return null;
  return user;
}

export async function createInternalUserWithAudit(tx: Tx, actor: PrivilegeActor, data: { email: string; name: string; role: RoleCode; active: boolean; passwordHash: string }) {
  const actorUser = await requireAdminActor(tx, actor, actor.userId, 'user_create', { role: data.role, active: data.active, email: data.email });
  if (!actorUser) return denied('Solo un amministratore reale può creare utenti interni.');
  const user = await tx.user.create({ data });
  await auditTx(tx, actor.userId, 'user_create', 'User', user.id, { email: user.email, role: user.role, active: user.active });
  return { ok: true, value: user } as const;
}

export async function activateInternalUserWithAudit(tx: Tx, actor: PrivilegeActor, userId: string) {
  const actorUser = await requireAdminActor(tx, actor, userId, 'user_activate', { active: true });
  if (!actorUser) return denied('Solo un amministratore reale può riattivare utenti interni.');
  const before = await loadMutableUser(tx, userId);
  if (!before) return denied('Utente non modificabile.');
  const user = await tx.user.update({ where: { id: userId }, data: { active: true } });
  await auditTx(tx, actor.userId, 'user_activate', 'User', user.id, { active: true }, { active: before.active });
  return { ok: true, value: user } as const;
}

export async function deactivateInternalUserWithAudit(tx: Tx, actor: PrivilegeActor, userId: string) {
  const actorUser = await requireAdminActor(tx, actor, userId, 'user_deactivate', { active: false });
  if (!actorUser) return denied('Solo un amministratore reale può disattivare utenti interni.');
  const before = await loadMutableUser(tx, userId);
  if (!before) return denied('Utente non modificabile.');
  if (userId === actor.userId) {
    await auditBlocked(tx, actor, userId, { active: false }, { active: before.active });
    return denied('Non puoi disattivare te stesso.');
  }
  if (before.role === 'admin' && before.active && await activeAdminCount(tx) <= 1) {
    await auditBlocked(tx, actor, userId, { active: false }, { active: before.active });
    return denied('Impossibile disattivare l’ultimo admin attivo.');
  }
  const user = await tx.user.update({ where: { id: userId }, data: { active: false } });
  await auditTx(tx, actor.userId, 'user_deactivate', 'User', user.id, { active: false }, { active: before.active });
  return { ok: true, value: user } as const;
}

export async function updateInternalUserRoleWithAudit(tx: Tx, actor: PrivilegeActor, userId: string, role: RoleCode) {
  const actorUser = await requireAdminActor(tx, actor, userId, 'role_change', { role });
  if (!actorUser) return denied('Solo un amministratore reale può modificare ruoli utente.');
  const before = await loadMutableUser(tx, userId);
  if (!before) return denied('Utente non modificabile.');
  const removedOverrides = before.permissionOverrides.map(({ permission, allowed }) => ({ permission, allowed }));
  if (userId === actor.userId && before.role === 'admin' && role !== 'admin') {
    await auditBlocked(tx, actor, userId, { role }, { role: before.role });
    return denied('Non puoi rimuovere il tuo ruolo admin.');
  }
  if (before.role === 'admin' && before.active && role !== 'admin' && await activeAdminCount(tx) <= 1) {
    await auditBlocked(tx, actor, userId, { role }, { role: before.role });
    return denied('Impossibile modificare l’ultimo admin attivo.');
  }
  if (role === 'admin' && removedOverrides.length > 0) await tx.userPermissionOverride.deleteMany({ where: { userId } });
  const user = await tx.user.update({ where: { id: userId }, data: { role } });
  await auditTx(tx, actor.userId, 'role_change', 'User', user.id, { role: user.role, removedOverrides: role === 'admin' ? removedOverrides : [] }, { role: before.role, overrides: removedOverrides });
  return { ok: true, value: user } as const;
}

export async function updatePermissionOverridesWithAudit(tx: Tx, actor: PrivilegeActor, userId: string, overrides: { permission: string; allowed: boolean }[]) {
  const actorUser = await requireAdminActor(tx, actor, userId, 'user_permission_overrides_updated', { count: overrides.length });
  if (!actorUser) return denied('Solo un amministratore reale può modificare override utente.');
  const user = await loadMutableUser(tx, userId);
  if (!user) return denied('Utente non modificabile.');
  if (user.id === actor.userId) {
    await auditBlocked(tx, actor, user.id, { overrides: 'self' });
    return denied('Non puoi modificare i tuoi override.');
  }
  if (user.role === 'admin') {
    await auditBlocked(tx, actor, user.id, { overrides: 'admin_immune' });
    return denied('Gli admin sono immuni dagli override.');
  }
  const before = user.permissionOverrides.map(({ permission, allowed }) => ({ permission, allowed }));
  await tx.userPermissionOverride.deleteMany({ where: { userId: user.id } });
  if (overrides.length) await tx.userPermissionOverride.createMany({ data: overrides.map((item) => ({ userId: user.id, ...item })), skipDuplicates: true });
  await auditTx(tx, actor.userId, 'user_permission_overrides_updated', 'User', user.id, overrides, before);
  return { ok: true, value: overrides } as const;
}

export async function resetPermissionOverridesWithAudit(tx: Tx, actor: PrivilegeActor, userId: string) {
  const actorUser = await requireAdminActor(tx, actor, userId, 'user_permission_overrides_reset', {});
  if (!actorUser) return denied('Solo un amministratore reale può ripristinare override utente.');
  const user = await loadMutableUser(tx, userId);
  if (!user) return denied('Utente non modificabile.');
  if (user.id === actor.userId || user.role === 'admin') {
    await auditBlocked(tx, actor, user.id, { overrides: 'reset_blocked' });
    return denied('Override non modificabili per questo utente.');
  }
  const before = user.permissionOverrides.map(({ permission, allowed }) => ({ permission, allowed }));
  await tx.userPermissionOverride.deleteMany({ where: { userId: user.id } });
  await auditTx(tx, actor.userId, 'user_permission_overrides_reset', 'User', user.id, [], before);
  return { ok: true, value: [] } as const;
}

export { serializableOptions };
