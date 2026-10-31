import { z } from 'zod';
import { canonicalSha256 } from './canonical-json';
import { permissionCatalog, permissionCodes, roleHasPermission, type Permission } from './permissions';
import { evaluatePermission } from './permission-evaluator';

export const profileRoles = ['direzione', 'commerciale', 'consulente', 'revisore', 'backoffice', 'amministrazione', 'collaboratore_limitato'] as const;
export const profileRole = z.enum(profileRoles);
export type ProfileRole = z.infer<typeof profileRole>;
export const roleProfileModel = 'AdminRoleProfile';
export const roleProfileDigest = (value: unknown) => canonicalSha256(JSON.parse(JSON.stringify(value)));
export function editableRolePermission(role: ProfileRole, permission: Permission) {
  if (permission.startsWith('ai.') || permission.startsWith('ai_agents.') || permission === 'video.manage') return false;
  return [true, false].every(allowed => evaluatePermission({ role, active: true,
    permissionOverrides: [{ permission, allowed }] }, permission).allowed === allowed);
}
export const roleProfileOverrides = z.array(z.object({
  permission: z.string().refine((value): value is Permission => permissionCodes.includes(value as Permission)),
  allowed: z.boolean(),
}).strict()).max(permissionCodes.length);
export function normalizeRoleProfile(role: ProfileRole, raw: unknown) {
  const values = roleProfileOverrides.parse(raw);
  if (new Set(values.map(value => value.permission)).size !== values.length
    || values.some(value => !editableRolePermission(role, value.permission))) throw new RoleProfileError('INVALID');
  return values.filter(value => value.allowed !== roleHasPermission(role, value.permission))
    .sort((a, b) => a.permission.localeCompare(b.permission));
}
export const roleProfileSnapshot = z.object({
  id: profileRole, revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  catalogueHash: z.string().regex(/^[a-f0-9]{64}$/), overrides: roleProfileOverrides,
}).strict();
export type RoleProfileSnapshot = z.infer<typeof roleProfileSnapshot>;
export function originalRoleProfile(role: ProfileRole): RoleProfileSnapshot {
  return { id: role, revision: 0, overrides: [], catalogueHash: roleProfileDigest(permissionCatalog.map(item => ({
    code: item.code, inherited: roleHasPermission(role, item.code), editable: editableRolePermission(role, item.code),
  }))) };
}
export class RoleProfileError extends Error {
  constructor(readonly code: 'DENIED' | 'INVALID' | 'STALE' | 'CLOSED' | 'INTEGRITY') { super('ADMIN_ROLE_PROFILE_' + code); }
}
export const roleProfileCommand = z.object({
  commandId: z.string().uuid(), role: profileRole, expectedVersion: z.string().regex(/^[a-f0-9]{64}$/),
  overrides: roleProfileOverrides, reason: z.string().trim().min(3).max(2000), confirmed: z.literal(true),
}).strict();
