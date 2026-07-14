import type { RoleCode } from '@prisma/client';

export type UserSafetySnapshot = { id: string; role: RoleCode; active: boolean; deletedAt?: Date | null };

export function activeAdminCountFromSnapshot(users: readonly UserSafetySnapshot[], exceptUserId?: string) {
  return users.filter((user) => user.role === 'admin' && user.active && !user.deletedAt && user.id !== exceptUserId).length;
}

export function canDeactivateUser(actorId: string, target: UserSafetySnapshot, users: readonly UserSafetySnapshot[]) {
  if (target.deletedAt) return { allowed: false, reason: 'deleted_user' } as const;
  if (actorId === target.id) return { allowed: false, reason: 'self_deactivation' } as const;
  if (target.role === 'admin' && target.active && activeAdminCountFromSnapshot(users, target.id) === 0) return { allowed: false, reason: 'last_active_admin' } as const;
  return { allowed: true } as const;
}

export function canChangeUserRole(target: UserSafetySnapshot, nextRole: RoleCode, users: readonly UserSafetySnapshot[]) {
  if (target.deletedAt) return { allowed: false, reason: 'deleted_user' } as const;
  if (target.role === 'admin' && nextRole !== 'admin' && target.active && activeAdminCountFromSnapshot(users, target.id) === 0) return { allowed: false, reason: 'last_active_admin' } as const;
  return { allowed: true } as const;
}

export function shouldClearPermissionOverridesOnRoleChange(nextRole: RoleCode) {
  return nextRole === 'admin';
}
