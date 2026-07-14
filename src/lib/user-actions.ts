'use server';
import bcrypt from 'bcryptjs';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { Prisma, type RoleCode } from '@prisma/client';
import { prisma } from './prisma';
import { isPermission, permissionCodes, requirePermission } from './auth';
import { canChangeUserRole, canDeactivateUser, shouldClearPermissionOverridesOnRoleChange } from './user-safety';
import { internalUserSchema, userIdSchema, userPermissionOverridesSchema, userRoleSchema } from './validation';

type Tx = Prisma.TransactionClient;
const SERIALIZABLE_RETRIES = 3;

async function auditWith(tx: Tx, actorId: string, event: string, entityType: string, entityId?: string, after?: unknown, before?: unknown) {
  await tx.auditLog.create({ data: { actorId, event, entityType, entityId, before: before as Prisma.InputJsonValue, after: after as Prisma.InputJsonValue } });
}
async function audit(actorId: string, event: string, entityType: string, entityId?: string, after?: unknown, before?: unknown) {
  await auditWith(prisma, actorId, event, entityType, entityId, after, before);
}

async function serializable<T>(operation: (tx: Tx) => Promise<T>) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= SERIALIZABLE_RETRIES; attempt += 1) {
    try {
      return await prisma.$transaction(operation, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034' && attempt < SERIALIZABLE_RETRIES) {
        lastError = error;
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

async function usersForSafety(tx: Tx) {
  return tx.user.findMany({ where: { deletedAt: null }, select: { id: true, role: true, active: true, deletedAt: true } });
}

async function assertTargetMutable(tx: Tx, actor: { userId: string; role: RoleCode }, targetUserId: string, options: { allowSelf?: boolean; adminOverride?: boolean } = {}) {
  const target = await tx.user.findUniqueOrThrow({ where: { id: targetUserId }, include: { permissionOverrides: true } });
  if (target.deletedAt) throw new Error('Impossibile modificare utenti eliminati.');
  if (!options.allowSelf && target.id === actor.userId) {
    await auditWith(tx, actor.userId, 'blocked_self_deactivation', 'User', target.id, { reason: 'self_deactivation' });
    throw new Error('Non puoi disattivare il tuo account.');
  }
  if (target.role === 'admin' && actor.role !== 'admin' && !options.adminOverride) throw new Error('Solo un admin può modificare un altro admin.');
  return target;
}

function revalidateUserPages(userId: string) {
  revalidatePath('/settings/users');
  revalidatePath(`/settings/users/${userId}`);
  revalidatePath('/settings/roles');
}

export async function createInternalUser(form: FormData) {
  const s = await requirePermission('settings.manage');
  const data = internalUserSchema.parse({ ...Object.fromEntries(form), active: form.get('active') === 'on' });
  if (data.role === 'admin' && s.role !== 'admin') throw new Error('Solo un admin può creare un altro admin.');
  const user = await serializable(async (tx) => {
    const created = await tx.user.create({ data: { email: data.email, name: data.name, role: data.role, active: data.active ?? true, passwordHash: await bcrypt.hash(data.password, 12) } });
    await auditWith(tx, s.userId, 'user_create', 'User', created.id, { email: created.email, role: created.role, active: created.active });
    return created;
  });
  revalidateUserPages(user.id);
}

export async function updateInternalUserRole(form: FormData) {
  const s = await requirePermission('settings.manage');
  const data = userRoleSchema.parse(Object.fromEntries(form));
  const result = await serializable(async (tx) => {
    const before = await assertTargetMutable(tx, s, data.userId, { allowSelf: true });
    if ((before.role === 'admin' || data.role === 'admin') && s.role !== 'admin') throw new Error('Solo un admin può modificare il ruolo di un admin.');
    const safety = canChangeUserRole(before, data.role, await usersForSafety(tx));
    if (!safety.allowed) {
      if (safety.reason === 'last_active_admin') await auditWith(tx, s.userId, 'blocked_last_admin_change', 'User', before.id, { attemptedRole: data.role }, { role: before.role, active: before.active });
      return { allowed: false as const, reason: safety.reason, userId: before.id };
    }
    const deletedOverrides = before.permissionOverrides.map(({ permission, allowed }) => ({ permission, allowed })).filter((override) => isPermission(override.permission));
    const [updated] = await Promise.all([
      tx.user.update({ where: { id: data.userId }, data: { role: data.role } }),
      shouldClearPermissionOverridesOnRoleChange(data.role) ? tx.userPermissionOverride.deleteMany({ where: { userId: data.userId } }) : Promise.resolve({ count: 0 }),
    ]);
    await auditWith(tx, s.userId, 'role_change', 'User', updated.id, { role: updated.role, deletedPermissionOverrides: shouldClearPermissionOverridesOnRoleChange(data.role) ? deletedOverrides : [] }, { role: before.role, permissionOverrides: deletedOverrides });
    return { allowed: true as const, user: updated };
  });
  if (!result.allowed) throw new Error(result.reason === 'last_active_admin' ? 'Impossibile cambiare ruolo all’ultimo admin attivo.' : 'Impossibile modificare utenti eliminati.');
  revalidateUserPages(result.user.id);
}

export async function deactivateInternalUser(form: FormData) {
  const s = await requirePermission('settings.manage');
  const data = userIdSchema.parse(Object.fromEntries(form));
  const result = await serializable(async (tx) => {
    const before = await assertTargetMutable(tx, s, data.userId, { allowSelf: true });
    const safety = canDeactivateUser(s.userId, before, await usersForSafety(tx));
    if (!safety.allowed) {
      if (safety.reason === 'self_deactivation') await auditWith(tx, s.userId, 'blocked_self_deactivation', 'User', before.id, { reason: safety.reason });
      if (safety.reason === 'last_active_admin') await auditWith(tx, s.userId, 'blocked_last_admin_change', 'User', before.id, { active: false }, { role: before.role, active: before.active });
      return { allowed: false as const, reason: safety.reason, userId: before.id };
    }
    const updated = await tx.user.update({ where: { id: data.userId }, data: { active: false } });
    await auditWith(tx, s.userId, 'user_deactivate', 'User', updated.id, { active: false }, { active: before.active });
    return { allowed: true as const, user: updated };
  });
  if (!result.allowed) throw new Error(result.reason === 'self_deactivation' ? 'Non puoi disattivare il tuo account.' : 'Impossibile disattivare l’ultimo admin attivo.');
  revalidateUserPages(result.user.id);
}

export async function activateInternalUser(form: FormData) {
  const s = await requirePermission('settings.manage');
  const data = userIdSchema.parse(Object.fromEntries(form));
  const user = await serializable(async (tx) => {
    const before = await assertTargetMutable(tx, s, data.userId, { allowSelf: true });
    const updated = await tx.user.update({ where: { id: data.userId }, data: { active: true } });
    await auditWith(tx, s.userId, 'user_activate', 'User', updated.id, { active: true }, { active: before.active });
    return updated;
  });
  revalidateUserPages(user.id);
}

export async function updateUserPermissionOverrides(form: FormData) {
  const s = await requirePermission('settings.manage');
  const raw = { userId: form.get('userId'), overrides: permissionCodes.map((permission) => ({ permission, value: form.get(`permission:${permission}`) ?? 'inherit' })) };
  const data = userPermissionOverridesSchema.parse(raw);
  const target = await serializable(async (tx) => {
    const beforeUser = await assertTargetMutable(tx, s, data.userId, { allowSelf: true });
    if (beforeUser.role === 'admin') throw new Error('Gli account admin non possono avere override di permesso.');
    const before = beforeUser.permissionOverrides.map(({ permission, allowed }) => ({ permission, allowed })).filter((override) => isPermission(override.permission));
    const after = data.overrides.filter((override) => override.value !== 'inherit').map((override) => ({ permission: override.permission, allowed: override.value === 'allow' }));
    await tx.userPermissionOverride.deleteMany({ where: { userId: data.userId } });
    for (const override of after) await tx.userPermissionOverride.create({ data: { userId: data.userId, permission: override.permission, allowed: override.allowed } });
    await auditWith(tx, s.userId, 'user_permission_overrides_update', 'User', beforeUser.id, { overrides: after }, { overrides: before });
    return beforeUser;
  });
  revalidateUserPages(target.id);
  redirect(`/settings/users/${target.id}?saved=1`);
}

export async function resetUserPermissionOverrides(form: FormData) {
  const s = await requirePermission('settings.manage');
  const data = userIdSchema.parse(Object.fromEntries(form));
  const target = await serializable(async (tx) => {
    const beforeUser = await assertTargetMutable(tx, s, data.userId, { allowSelf: true });
    if (beforeUser.role === 'admin') throw new Error('Gli account admin non possono avere override di permesso.');
    const before = beforeUser.permissionOverrides.map(({ permission, allowed }) => ({ permission, allowed })).filter((override) => isPermission(override.permission));
    await tx.userPermissionOverride.deleteMany({ where: { userId: data.userId } });
    await auditWith(tx, s.userId, 'user_permission_overrides_reset', 'User', beforeUser.id, { overrides: [] }, { overrides: before });
    return beforeUser;
  });
  revalidateUserPages(target.id);
  redirect(`/settings/users/${target.id}?saved=1`);
}
