import { legacyRoleProfilePolicy } from './admin-role-profile-legacy-policy';
import { pr252RoleProfilePolicy } from './admin-role-profile-pr252-policy';
import { normalizeRoleProfile, originalRoleProfile, roleProfileDigest, RoleProfileError,
  type ProfileRole, type RoleProfileSnapshot, editableRolePermission } from './admin-role-profile-contract';
/** Preserve exact immutable history while applying the current mandatory ceiling. */
export function validateHistoricalRoleProfile(value: RoleProfileSnapshot) {
  const legacy = [legacyRoleProfilePolicy[value.id], pr252RoleProfilePolicy[value.id]]
    .find(policy => policy.catalogueHash === value.catalogueHash);
  if (value.catalogueHash === originalRoleProfile(value.id).catalogueHash) {
    if (roleProfileDigest(normalizeRoleProfile(value.id, value.overrides)) !== roleProfileDigest(value.overrides)) throw new RoleProfileError('INTEGRITY');
  } else {
    if (!legacy
      || new Set(value.overrides.map(v => v.permission)).size !== value.overrides.length
      || value.overrides.some(v => !(legacy.editable as readonly string[]).includes(v.permission)
        || v.allowed === (legacy.inherited as readonly string[]).includes(v.permission))
      || roleProfileDigest([...value.overrides].sort((a,b) => a.permission.localeCompare(b.permission))) !== roleProfileDigest(value.overrides)) throw new RoleProfileError('INTEGRITY');
  }
  return value;
}
export function effectiveRoleProfileOverrides(role: ProfileRole, value: RoleProfileSnapshot['overrides']) {
  return normalizeRoleProfile(role, value.filter(v => editableRolePermission(role, v.permission)));
}
export function roleProfileOrigin(first: RoleProfileSnapshot | undefined, role: ProfileRole) {
  const original = originalRoleProfile(role);
  if (!first) return original;
  validateHistoricalRoleProfile(first);
  if (first.id !== role || first.revision !== 0 || first.overrides.length) throw new RoleProfileError('INTEGRITY');
  return { ...original, catalogueHash: first.catalogueHash };
}
