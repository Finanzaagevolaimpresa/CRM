import type { RoleCode, UserPermissionOverride } from '@prisma/client';
import {
  adminOnlyAiExecutionPermissions,
  isPermission,
  permissionCodes,
  protectedLeadDuplicatePermissions,
  protectedCommercialLeadPermissions,
  roleHasPermission,
  type Permission,
} from './permissions';

export type PermissionOverrideSnapshot = Pick<UserPermissionOverride, 'permission' | 'allowed'>;

export interface PermissionSession {
  readonly role: RoleCode;
  readonly active: boolean;
  readonly permissionOverrides: readonly PermissionOverrideSnapshot[];
}

export type PermissionDecisionSource = 'ADMIN' | 'OVERRIDE' | 'ROLE';

export interface PermissionDecision {
  readonly allowed: boolean;
  readonly source: PermissionDecisionSource;
}

export function evaluatePermission(session: PermissionSession, permission: Permission): PermissionDecision {
  if (!isPermission(permission) || session.active !== true) return { allowed: false, source: 'ROLE' };
  if (permission === 'ai.execution.consume') {
    return { allowed: false, source: session.role === 'admin' ? 'ADMIN' : 'ROLE' };
  }
  if (session.role === 'admin') return { allowed: true, source: 'ADMIN' };
  if ((protectedLeadDuplicatePermissions as readonly Permission[]).includes(permission)) {
    return { allowed: session.role === 'direzione', source: 'ROLE' };
  }
  if ((protectedCommercialLeadPermissions as readonly Permission[]).includes(permission)) {
    return { allowed: session.role === 'direzione', source: 'ROLE' };
  }
  if ((adminOnlyAiExecutionPermissions as readonly Permission[]).includes(permission)) {
    return { allowed: false, source: 'ROLE' };
  }
  const override = session.permissionOverrides.find((item) => item.permission === permission);
  if (override) return { allowed: override.allowed, source: 'OVERRIDE' };
  return { allowed: roleHasPermission(session.role, permission), source: 'ROLE' };
}

export function hasPermission(session: PermissionSession, permission: Permission) {
  return evaluatePermission(session, permission).allowed;
}

export function getEffectivePermissions(session: PermissionSession) {
  return permissionCodes.filter((permission) => hasPermission(session, permission));
}
