'use server';
import bcrypt from 'bcryptjs';
import { revalidatePath } from 'next/cache';
import { prisma } from './prisma';
import { requirePermission } from './auth';
import { internalUserSchema, userIdSchema, userRoleSchema } from './validation';
import type { Prisma } from '@prisma/client';

async function audit(actorId: string, event: string, entityType: string, entityId?: string, after?: unknown, before?: unknown) {
  await prisma.auditLog.create({ data: { actorId, event, entityType, entityId, before: before as Prisma.InputJsonValue, after: after as Prisma.InputJsonValue } });
}
export async function createInternalUser(form: FormData) {
  const s = await requirePermission('settings.manage');
  const data = internalUserSchema.parse({ ...Object.fromEntries(form), active: form.get('active') === 'on' });
  const user = await prisma.user.create({ data: { email: data.email, name: data.name, role: data.role, active: data.active ?? true, passwordHash: await bcrypt.hash(data.password, 12) } });
  await audit(s.userId, 'user_create', 'User', user.id, { email: user.email, role: user.role, active: user.active });
  revalidatePath('/settings/users');
}
export async function updateInternalUserRole(form: FormData) {
  const s = await requirePermission('settings.manage');
  const data = userRoleSchema.parse(Object.fromEntries(form));
  const before = await prisma.user.findUniqueOrThrow({ where: { id: data.userId } });
  const user = await prisma.user.update({ where: { id: data.userId }, data: { role: data.role } });
  await audit(s.userId, 'role_change', 'User', user.id, { role: user.role }, { role: before.role });
  revalidatePath('/settings/users'); revalidatePath('/settings/roles');
}
export async function deactivateInternalUser(form: FormData) {
  const s = await requirePermission('settings.manage');
  const data = userIdSchema.parse(Object.fromEntries(form));
  const user = await prisma.user.update({ where: { id: data.userId }, data: { active: false } });
  await audit(s.userId, 'user_deactivate', 'User', user.id, { active: false });
  revalidatePath('/settings/users');
}
