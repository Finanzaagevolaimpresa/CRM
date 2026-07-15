'use server';
import bcrypt from 'bcryptjs';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { Prisma, type RoleCode } from '@prisma/client';
import { prisma } from './prisma';
import { requirePermission, type AuthSession } from './auth';
import { internalUserSchema, userIdSchema, userPermissionOverridesSchema, userRoleSchema } from './validation';

async function auditTx(tx: Prisma.TransactionClient, actorId: string, event: string, entityType: string, entityId?: string, after?: unknown, before?: unknown) {
  await tx.auditLog.create({ data: { actorId, event, entityType, entityId, before: before as Prisma.InputJsonValue, after: after as Prisma.InputJsonValue } });
}
function assertAdminActor(s: AuthSession) { if (s.role !== 'admin') throw new Error('Solo un amministratore reale può modificare privilegi utenti.'); }
async function activeAdminCount(tx: Prisma.TransactionClient) { return tx.user.count({ where: { role: 'admin', active: true, deletedAt: null } }); }
async function loadMutableUser(tx: Prisma.TransactionClient, id: string) {
  const user = await tx.user.findUnique({ where: { id }, include: { permissionOverrides: true } });
  if (!user || user.deletedAt) throw new Error('Utente non modificabile.');
  return user;
}
async function blocked(tx: Prisma.TransactionClient, s: AuthSession, targetId: string, after: unknown, before?: unknown) {
  await auditTx(tx, s.userId, 'blocked_user_privilege_change', 'User', targetId, after, before);
}
async function serializable<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) {
  try { return await prisma.$transaction(fn, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }); }
  catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') throw new Error('Operazione concorrente rilevata: riprovare.');
    throw error;
  }
}

export async function createInternalUser(form: FormData) {
  const s = await requirePermission('user.write');
  const data = internalUserSchema.parse({ ...Object.fromEntries(form), active: form.get('active') === 'on' });
  if (data.role === 'admin') assertAdminActor(s);
  const user = await prisma.user.create({ data: { email: data.email, name: data.name, role: data.role, active: data.active ?? true, passwordHash: await bcrypt.hash(data.password, 12) } });
  await prisma.auditLog.create({ data: { actorId: s.userId, event: 'user_create', entityType: 'User', entityId: user.id, after: { email: user.email, role: user.role, active: user.active } } });
  revalidatePath('/settings/users');
}

export async function activateInternalUser(form: FormData) {
  const s = await requirePermission('user.write');
  const data = userIdSchema.parse(Object.fromEntries(form));
  await serializable(async (tx) => {
    const before = await loadMutableUser(tx, data.userId);
    if (before.role === 'admin') assertAdminActor(s);
    const user = await tx.user.update({ where: { id: data.userId }, data: { active: true } });
    await auditTx(tx, s.userId, 'user_activate', 'User', user.id, { active: true }, { active: before.active });
  });
  revalidatePath('/settings/users');
}

export async function updateInternalUserRole(form: FormData) {
  const s = await requirePermission('user.write');
  const data = userRoleSchema.parse(Object.fromEntries(form));
  await serializable(async (tx) => {
    const before = await loadMutableUser(tx, data.userId);
    const privilegeChange = before.role === 'admin' || data.role === 'admin' || data.userId === s.userId;
    if (privilegeChange) assertAdminActor(s);
    if (data.userId === s.userId && before.role === 'admin' && data.role !== 'admin') { await blocked(tx, s, data.userId, { role: data.role }, { role: before.role }); throw new Error('Non puoi rimuovere il tuo ruolo admin.'); }
    if (before.role === 'admin' && data.role !== 'admin' && await activeAdminCount(tx) <= 1) { await blocked(tx, s, data.userId, { role: data.role }, { role: before.role }); throw new Error('Impossibile modificare l’ultimo admin attivo.'); }
    const user = await tx.user.update({ where: { id: data.userId }, data: { role: data.role as RoleCode } });
    await auditTx(tx, s.userId, 'role_change', 'User', user.id, { role: user.role }, { role: before.role });
  });
  revalidatePath('/settings/users'); revalidatePath('/settings/roles'); revalidatePath(`/settings/users/${data.userId}`);
}

export async function deactivateInternalUser(form: FormData) {
  const s = await requirePermission('user.write');
  const data = userIdSchema.parse(Object.fromEntries(form));
  await serializable(async (tx) => {
    const before = await loadMutableUser(tx, data.userId);
    if (data.userId === s.userId) { await blocked(tx, s, data.userId, { active: false }, { active: before.active }); throw new Error('Non puoi disattivare te stesso.'); }
    if (before.role === 'admin') assertAdminActor(s);
    if (before.role === 'admin' && before.active && await activeAdminCount(tx) <= 1) { await blocked(tx, s, data.userId, { active: false }, { active: before.active }); throw new Error('Impossibile disattivare l’ultimo admin attivo.'); }
    const user = await tx.user.update({ where: { id: data.userId }, data: { active: false } });
    await auditTx(tx, s.userId, 'user_deactivate', 'User', user.id, { active: false }, { active: before.active });
  });
  revalidatePath('/settings/users');
}

export async function updateUserPermissionOverrides(form: FormData) {
  const s = await requirePermission('user.write');
  assertAdminActor(s);
  const userId = String(form.get('userId') ?? '');
  const overrides = Array.from(form.entries()).filter(([key]) => key.startsWith('permission:')).map(([key, value]) => ({ permission: key.slice('permission:'.length), value }));
  const data = userPermissionOverridesSchema.parse({ userId, overrides });
  await serializable(async (tx) => {
    const user = await loadMutableUser(tx, data.userId);
    if (user.id === s.userId) { await blocked(tx, s, user.id, { overrides: 'self' }); throw new Error('Non puoi modificare i tuoi override.'); }
    if (user.role === 'admin') { await blocked(tx, s, user.id, { overrides: 'admin_immune' }); throw new Error('Gli admin sono immuni dagli override.'); }
    const before = user.permissionOverrides.map(({ permission, allowed }) => ({ permission, allowed }));
    await tx.userPermissionOverride.deleteMany({ where: { userId: user.id } });
    const rows = data.overrides.filter((item) => item.value !== 'inherit').map((item) => ({ userId: user.id, permission: item.permission, allowed: item.value === 'allow' }));
    if (rows.length) await tx.userPermissionOverride.createMany({ data: rows, skipDuplicates: true });
    await auditTx(tx, s.userId, 'user_permission_overrides_updated', 'User', user.id, rows.map(({ permission, allowed }) => ({ permission, allowed })), before);
  });
  revalidatePath('/settings/users'); revalidatePath(`/settings/users/${data.userId}`);
}

export async function resetUserPermissionOverrides(form: FormData) {
  const s = await requirePermission('user.write');
  assertAdminActor(s);
  const data = userIdSchema.parse(Object.fromEntries(form));
  await serializable(async (tx) => {
    const user = await loadMutableUser(tx, data.userId);
    if (user.id === s.userId || user.role === 'admin') { await blocked(tx, s, user.id, { overrides: 'reset_blocked' }); throw new Error('Override non modificabili per questo utente.'); }
    const before = user.permissionOverrides.map(({ permission, allowed }) => ({ permission, allowed }));
    await tx.userPermissionOverride.deleteMany({ where: { userId: user.id } });
    await auditTx(tx, s.userId, 'user_permission_overrides_reset', 'User', user.id, [], before);
  });
  revalidatePath('/settings/users'); revalidatePath(`/settings/users/${data.userId}`);
  redirect(`/settings/users/${data.userId}`);
}
