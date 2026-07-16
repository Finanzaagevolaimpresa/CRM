'use server';
import bcrypt from 'bcryptjs';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { Prisma } from '@prisma/client';
import { prisma } from './prisma';
import { requirePermission } from './auth';
import { internalUserSchema, userIdSchema, userPermissionOverridesSchema, userRoleSchema } from './validation';
import {
  activateInternalUserWithAudit,
  createInternalUserWithAudit,
  deactivateInternalUserWithAudit,
  resetPermissionOverridesWithAudit,
  serializableOptions,
  updateInternalUserRoleWithAudit,
  updatePermissionOverridesWithAudit,
} from './user-privilege-service';

async function serializable<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) {
  try { return await prisma.$transaction(fn, serializableOptions); }
  catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') throw new Error('Operazione concorrente rilevata: riprovare.');
    throw error;
  }
}
function failIfDenied<T>(result: { ok: true; value: T } | { ok: false; message: string }) {
  if (!result.ok) throw new Error(result.message);
  return result.value;
}

export async function createInternalUser(form: FormData) {
  const s = await requirePermission('user.write');
  const data = internalUserSchema.parse({ ...Object.fromEntries(form), active: form.get('active') === 'on' });
  const passwordHash = await bcrypt.hash(data.password, 12);
  const result = await serializable((tx) => createInternalUserWithAudit(tx, s, { email: data.email, name: data.name, role: data.role, active: data.active ?? true, passwordHash }));
  failIfDenied(result);
  revalidatePath('/settings/users');
}

export async function activateInternalUser(form: FormData) {
  const s = await requirePermission('user.write');
  const data = userIdSchema.parse(Object.fromEntries(form));
  const result = await serializable((tx) => activateInternalUserWithAudit(tx, s, data.userId));
  failIfDenied(result);
  revalidatePath('/settings/users');
}

export async function updateInternalUserRole(form: FormData) {
  const s = await requirePermission('user.write');
  const data = userRoleSchema.parse(Object.fromEntries(form));
  const result = await serializable((tx) => updateInternalUserRoleWithAudit(tx, s, data.userId, data.role));
  failIfDenied(result);
  revalidatePath('/settings/users'); revalidatePath('/settings/roles'); revalidatePath(`/settings/users/${data.userId}`);
}

export async function deactivateInternalUser(form: FormData) {
  const s = await requirePermission('user.write');
  const data = userIdSchema.parse(Object.fromEntries(form));
  const result = await serializable((tx) => deactivateInternalUserWithAudit(tx, s, data.userId));
  failIfDenied(result);
  revalidatePath('/settings/users');
}

export async function updateUserPermissionOverrides(form: FormData) {
  const s = await requirePermission('user.write');
  const userId = String(form.get('userId') ?? '');
  const overrides = Array.from(form.entries()).filter(([key]) => key.startsWith('permission:')).map(([key, value]) => ({ permission: key.slice('permission:'.length), value }));
  const data = userPermissionOverridesSchema.parse({ userId, overrides });
  const rows = data.overrides.filter((item) => item.value !== 'inherit').map((item) => ({ permission: item.permission, allowed: item.value === 'allow' }));
  const result = await serializable((tx) => updatePermissionOverridesWithAudit(tx, s, data.userId, rows));
  failIfDenied(result);
  revalidatePath('/settings/users'); revalidatePath(`/settings/users/${data.userId}`);
}

export async function resetUserPermissionOverrides(form: FormData) {
  const s = await requirePermission('user.write');
  const data = userIdSchema.parse(Object.fromEntries(form));
  const result = await serializable((tx) => resetPermissionOverridesWithAudit(tx, s, data.userId));
  failIfDenied(result);
  revalidatePath('/settings/users'); revalidatePath(`/settings/users/${data.userId}`);
  redirect(`/settings/users/${data.userId}`);
}
