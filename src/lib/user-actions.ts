'use server';
import bcrypt from 'bcryptjs';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { prisma } from './prisma';
import { requirePermission } from './auth';
import { internalUserSchema, userIdSchema, userPermissionOverridesSchema, userRoleSchema } from './validation';
import {
  activateInternalUserWithAudit,
  createInternalUserWithAudit,
  deactivateInternalUserWithAudit,
  resetPermissionOverridesWithAudit,
  updateInternalUserRoleWithAudit,
  updatePermissionOverridesWithAudit,
} from './user-privilege-service';
import { withSerializableTransaction } from './serializable';

function failIfDenied<T>(result: { ok: true; value: T } | { ok: false; message: string }) {
  if (!result.ok) throw new Error(result.message);
  return result.value;
}

export async function createInternalUser(form: FormData) {
  const s = await requirePermission('user.write');
  const data = internalUserSchema.parse({ ...Object.fromEntries(form), active: form.get('active') === 'on' });
  const passwordHash = await bcrypt.hash(data.password, 12);
  const result = await withSerializableTransaction(prisma, (tx) => createInternalUserWithAudit(tx, { userId: s.userId }, { email: data.email, name: data.name, role: data.role, active: data.active ?? true, passwordHash }));
  failIfDenied(result);
  revalidatePath('/settings/users');
}

export async function activateInternalUser(form: FormData) {
  const s = await requirePermission('user.write');
  const data = userIdSchema.parse(Object.fromEntries(form));
  const result = await withSerializableTransaction(prisma, (tx) => activateInternalUserWithAudit(tx, { userId: s.userId }, data.userId));
  failIfDenied(result);
  revalidatePath('/settings/users');
}

export async function updateInternalUserRole(form: FormData) {
  const s = await requirePermission('user.write');
  const data = userRoleSchema.parse(Object.fromEntries(form));
  const result = await withSerializableTransaction(prisma, (tx) => updateInternalUserRoleWithAudit(tx, { userId: s.userId }, data.userId, data.role));
  failIfDenied(result);
  revalidatePath('/settings/users'); revalidatePath('/settings/roles'); revalidatePath(`/settings/users/${data.userId}`);
}

export async function deactivateInternalUser(form: FormData) {
  const s = await requirePermission('user.write');
  const data = userIdSchema.parse(Object.fromEntries(form));
  const result = await withSerializableTransaction(prisma, (tx) => deactivateInternalUserWithAudit(tx, { userId: s.userId }, data.userId));
  failIfDenied(result);
  revalidatePath('/settings/users');
}

export async function updateUserPermissionOverrides(form: FormData) {
  const s = await requirePermission('user.write');
  const userId = String(form.get('userId') ?? '');
  const overrides = Array.from(form.entries()).filter(([key]) => key.startsWith('permission:')).map(([key, value]) => ({ permission: key.slice('permission:'.length), value }));
  const data = userPermissionOverridesSchema.parse({ userId, overrides });
  const rows = data.overrides.filter((item) => item.value !== 'inherit').map((item) => ({ permission: item.permission, allowed: item.value === 'allow' }));
  const result = await withSerializableTransaction(prisma, (tx) => updatePermissionOverridesWithAudit(tx, { userId: s.userId }, data.userId, rows));
  failIfDenied(result);
  revalidatePath('/settings/users'); revalidatePath(`/settings/users/${data.userId}`);
}

export async function resetUserPermissionOverrides(form: FormData) {
  const s = await requirePermission('user.write');
  const data = userIdSchema.parse(Object.fromEntries(form));
  const result = await withSerializableTransaction(prisma, (tx) => resetPermissionOverridesWithAudit(tx, { userId: s.userId }, data.userId));
  failIfDenied(result);
  revalidatePath('/settings/users'); revalidatePath(`/settings/users/${data.userId}`);
  redirect(`/settings/users/${data.userId}`);
}
