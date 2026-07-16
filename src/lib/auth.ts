import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { RoleCode, UserPermissionOverride } from '@prisma/client';
import { prisma } from './prisma';
import { verifySessionCookie, type SessionCookie } from './session';
import { isPermission, permissionCodes, roleHasPermission, rolePermissions, type Permission } from './permissions';

const cookieName = process.env.AUTH_COOKIE_NAME ?? 'fai_crm_session';

export type PermissionOverrideSnapshot = Pick<UserPermissionOverride, 'permission' | 'allowed'>;
export type AuthSession = SessionCookie & {
  role: RoleCode;
  active: boolean;
  permissionOverrides: PermissionOverrideSnapshot[];
};
export type { Permission } from './permissions';
export { permissionCatalog, permissionCodes, roleHasPermission, rolePermissions, isPermission } from './permissions';
export const permissions = rolePermissions;

async function auditBlockedInactiveUserAccess(userId: string) {
  await prisma.auditLog.create({ data: { actorId: userId, event: 'blocked_inactive_user_access', entityType: 'User', entityId: userId } });
}

export async function getSession() {
  const token = (await cookies()).get(cookieName)?.value;
  const cookieSession = await verifySessionCookie(token);
  if (!cookieSession) return null;

  const user = await prisma.user.findUnique({
    where: { id: cookieSession.userId },
    select: { id: true, role: true, active: true, deletedAt: true, permissionOverrides: { select: { permission: true, allowed: true } } },
  });
  if (!user || user.deletedAt) return null;
  if (!user.active) {
    await auditBlockedInactiveUserAccess(user.id);
    return null;
  }

  return { ...cookieSession, role: user.role, active: user.active, permissionOverrides: user.permissionOverrides } satisfies AuthSession;
}

export async function requireSession(): Promise<AuthSession> {
  const session = await getSession();
  if (!session) redirect('/login');
  return session;
}

export type PermissionSession = Pick<AuthSession, 'role' | 'active' | 'permissionOverrides'>;

export function hasPermission(session: PermissionSession, permission: Permission) {
  if (!isPermission(permission)) return false;
  if (session.active !== true) return false;
  if (session.role === 'admin') return true;
  const override = session.permissionOverrides.find((item) => item.permission === permission);
  if (override) return override.allowed;
  return roleHasPermission(session.role, permission);
}

export function getEffectivePermissions(session: PermissionSession) {
  return permissionCodes.filter((permission) => hasPermission(session, permission));
}

export async function requirePermission(permission: Permission) {
  const session = await requireSession();
  if (!hasPermission(session, permission)) redirect('/dashboard');
  return session;
}

export async function requireAnyPermission(permissions: readonly Permission[]) {
  const session = await requireSession();
  if (!permissions.some((permission) => hasPermission(session, permission))) redirect('/dashboard');
  return session;
}

export async function requireAuth(roles?: RoleCode[]) {
  const session = await requireSession();
  if (roles && !roles.includes(session.role)) redirect('/dashboard');
  return session;
}
