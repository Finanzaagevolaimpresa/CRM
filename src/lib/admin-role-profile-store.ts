import { validateHistoricalRoleProfile, roleProfileOrigin, effectiveRoleProfileOverrides } from './admin-role-profile-compatibility';
import type { Prisma, RoleCode } from '@prisma/client';
import { profileRole, roleProfileModel, roleProfileSnapshot, originalRoleProfile,
  roleProfileDigest as digest, RoleProfileError } from './admin-role-profile-contract';

/** A profile is a versioned preset, not a live bypass of native authorization.
 * Applying it creates ordinary individual overrides with the native audit. */
export async function loadAdminRoleProfile(tx: Prisma.TransactionClient, role: RoleCode, write = false) {
  if (role === 'admin') return { current: null, version: digest(null), history: [], effectiveOverrides: [] };
  const id = profileRole.parse(role);
  await tx.$queryRawUnsafe(
    write ? 'SELECT pg_advisory_xact_lock(hashtextextended($1,0))::text'
      : 'SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))::text', 'admin-role-profile:' + id);
  const original = originalRoleProfile(id);
  const rows = await tx.adminRecordRevision.findMany({ where: { model: roleProfileModel, recordId: id, operation: { not: 'CLOSE' } },
    select: { commandId: true, operation: true, before: true, after: true, beforeHash: true, afterHash: true, reason: true, createdAt: true } });
  const history = rows.map(row => {
    const before = roleProfileSnapshot.safeParse(row.before), after = roleProfileSnapshot.safeParse(row.after);
    if (row.operation !== 'UPDATE' || !before.success || !after.success || before.data.id !== id || after.data.id !== id
      || after.data.revision !== before.data.revision + 1 || digest(before.data) !== row.beforeHash || digest(after.data) !== row.afterHash
      || before.data.catalogueHash === original.catalogueHash && after.data.catalogueHash !== original.catalogueHash) throw new RoleProfileError('INTEGRITY');
    validateHistoricalRoleProfile(before.data); validateHistoricalRoleProfile(after.data);
    return { commandId: row.commandId, reason: row.reason, createdAt: row.createdAt.toISOString(), before: before.data, after: after.data };
  }).sort((a, b) => a.after.revision - b.after.revision);
  let current = roleProfileOrigin(history[0]?.before, id);
  for (const row of history) {
    if (row.after.revision !== current.revision + 1 || digest(row.before) !== digest(current)) throw new RoleProfileError('INTEGRITY');
    current = row.after;
  }
  return { current, version: digest(current), history, effectiveOverrides: effectiveRoleProfileOverrides(id, current.overrides) };
}
