import type { RoleCode, UserPermissionOverride } from '@prisma/client';
import { isPermission, permissionCodes, roleHasPermission, type Permission } from './permissions';

export type PermissionOverrideSnapshot = Pick<UserPermissionOverride, 'permission' | 'allowed'>;

export interface PermissionSession {
  readonly role: RoleCode;
  readonly active: boolean;
  readonly permissionOverrides: readonly PermissionOverrideSnapshot[];
}

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
