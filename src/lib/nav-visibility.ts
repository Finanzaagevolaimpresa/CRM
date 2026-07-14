import type { RoleCode } from '@prisma/client';
import type { Permission } from './auth';

export type PermissionNavItem = { permission?: Permission; adminOnly?: boolean; roles?: readonly RoleCode[] };

export function isNavItemVisible(item: PermissionNavItem, context: { role?: RoleCode | null; permissions: readonly Permission[] }) {
  if (item.permission) return context.role === 'admin' || context.permissions.includes(item.permission);
  if (item.adminOnly && !['admin', 'direzione'].includes(context.role ?? '')) return false;
  if (item.roles && (!context.role || !item.roles.includes(context.role))) return false;
  return true;
}
