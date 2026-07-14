'use server';
import bcrypt from 'bcryptjs';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import type { Prisma, RoleCode } from '@prisma/client';
import { prisma } from './prisma';
import { isPermission, permissionCodes, requirePermission } from './auth';
import { internalUserSchema, userIdSchema, userPermissionOverridesSchema, userRoleSchema } from './validation';

async function audit(actorId: string, event: string, entityType: string, entityId?: string, after?: unknown, before?: unknown) {
  await prisma.auditLog.create({ data: { actorId, event, entityType, entityId, before: before as Prisma.InputJsonValue, after: after as Prisma.InputJsonValue } });
}

async function activeAdminCount(exceptUserId?: string) {
  return prisma.user.count({ where: { role: 'admin', active: true, deletedAt: null, ...(exceptUserId ? { id: { not: exceptUserId } } : {}) } });
}

async function assertTargetMutable(actor: { userId: string; role: RoleCode }, targetUserId: string, options: { allowSelf?: boolean; adminOverride?: boolean } = {}) {
  const target = await prisma.user.findUniqueOrThrow({ where: { id: targetUserId }, include: { permissionOverrides: true } });
  if (target.deletedAt) throw new Error('Impossibile modificare utenti eliminati.');
  if (!options.allowSelf && target.id === actor.userId) {
    await audit(actor.userId, 'blocked_self_deactivation', 'User', target.id, { reason: 'self_deactivation' });
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
  const user = await prisma.user.create({ data: { email: data.email, name: data.name, role: data.role, active: data.active ?? true, passwordHash: await bcrypt.hash(data.password, 12) } });
  await audit(s.userId, 'user_create', 'User', user.id, { email: user.email, role: user.role, active: user.active });
  revalidateUserPages(user.id);
}

export async function updateInternalUserRole(form: FormData) {
  const s = await requirePermission('settings.manage');
  const data = userRoleSchema.parse(Object.fromEntries(form));
  const before = await assertTargetMutable(s, data.userId, { allowSelf: true });
  if ((before.role === 'admin' || data.role === 'admin') && s.role !== 'admin') throw new Error('Solo un admin può modificare il ruolo di un admin.');
  if (before.role === 'admin' && data.role !== 'admin' && before.active && await activeAdminCount(before.id) === 0) {
    await audit(s.userId, 'blocked_last_admin_change', 'User', before.id, { attemptedRole: data.role }, { role: before.role, active: before.active });
    throw new Error('Impossibile cambiare ruolo all’ultimo admin attivo.');
  }
  const user = await prisma.user.update({ where: { id: data.userId }, data: { role: data.role } });
  await audit(s.userId, 'role_change', 'User', user.id, { role: user.role }, { role: before.role });
  revalidateUserPages(user.id);
}

export async function deactivateInternalUser(form: FormData) {
  const s = await requirePermission('settings.manage');
  const data = userIdSchema.parse(Object.fromEntries(form));
  const before = await assertTargetMutable(s, data.userId);
  if (before.role === 'admin' && before.active && await activeAdminCount(before.id) === 0) {
    await audit(s.userId, 'blocked_last_admin_change', 'User', before.id, { active: false }, { role: before.role, active: before.active });
    throw new Error('Impossibile disattivare l’ultimo admin attivo.');
  }
  const user = await prisma.user.update({ where: { id: data.userId }, data: { active: false } });
  await audit(s.userId, 'user_deactivate', 'User', user.id, { active: false }, { active: before.active });
  revalidateUserPages(user.id);
}

export async function activateInternalUser(form: FormData) {
  const s = await requirePermission('settings.manage');
  const data = userIdSchema.parse(Object.fromEntries(form));
  const before = await assertTargetMutable(s, data.userId, { allowSelf: true });
  const user = await prisma.user.update({ where: { id: data.userId }, data: { active: true } });
  await audit(s.userId, 'user_activate', 'User', user.id, { active: true }, { active: before.active });
  revalidateUserPages(user.id);
}

export async function updateUserPermissionOverrides(form: FormData) {
  const s = await requirePermission('settings.manage');
  const raw = { userId: form.get('userId'), overrides: permissionCodes.map((permission) => ({ permission, value: form.get(`permission:${permission}`) ?? 'inherit' })) };
  const data = userPermissionOverridesSchema.parse(raw);
  const target = await assertTargetMutable(s, data.userId, { allowSelf: true });
  if (target.role === 'admin') throw new Error('Gli account admin non possono avere override di permesso.');
  const before = target.permissionOverrides.map(({ permission, allowed }) => ({ permission, allowed })).filter((override) => isPermission(override.permission));
  const after = data.overrides.filter((override) => override.value !== 'inherit').map((override) => ({ permission: override.permission, allowed: override.value === 'allow' }));
  await prisma.$transaction([
    prisma.userPermissionOverride.deleteMany({ where: { userId: data.userId } }),
    ...after.map((override) => prisma.userPermissionOverride.create({ data: { userId: data.userId, permission: override.permission, allowed: override.allowed } })),
  ]);
  await audit(s.userId, 'user_permission_overrides_update', 'User', target.id, { overrides: after }, { overrides: before });
  revalidateUserPages(target.id);
  redirect(`/settings/users/${target.id}?saved=1`);
}

export async function resetUserPermissionOverrides(form: FormData) {
  const s = await requirePermission('settings.manage');
  const data = userIdSchema.parse(Object.fromEntries(form));
  const target = await assertTargetMutable(s, data.userId, { allowSelf: true });
  if (target.role === 'admin') throw new Error('Gli account admin non possono avere override di permesso.');
  const before = target.permissionOverrides.map(({ permission, allowed }) => ({ permission, allowed })).filter((override) => isPermission(override.permission));
  await prisma.userPermissionOverride.deleteMany({ where: { userId: data.userId } });
  await audit(s.userId, 'user_permission_overrides_reset', 'User', target.id, { overrides: [] }, { overrides: before });
  revalidateUserPages(target.id);
  redirect(`/settings/users/${target.id}?saved=1`);
}
