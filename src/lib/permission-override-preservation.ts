import { z } from 'zod';
import { canonicalSha256 } from './canonical-json';
import { evaluatePermission, permissionOverrideControl, type PermissionSession, type PermissionOverrideSnapshot } from './permission-evaluator';
import { isPermission, permissionCodes } from './permissions';

const snapshots = z.array(z.object({ permission: z.string().refine(isPermission), allowed: z.boolean() }).strict())
  .max(permissionCodes.length).refine(rows => new Set(rows.map(row => row.permission)).size === rows.length);
export const overrideSnapshotHash = (rows: readonly PermissionOverrideSnapshot[]) =>
  canonicalSha256([...rows].map(({ permission, allowed }) => ({ permission, allowed })).sort((a, b) => a.permission.localeCompare(b.permission)));

/** Disabled controls are omitted by FormData. Their current server values are
 * retained, never reconstructed from a client-provided hidden field. */
export function preserveUneditableOverrides(actor: PermissionSession, requested: readonly PermissionOverrideSnapshot[]) {
  const proposed = { ...actor, permissionOverrides: requested };
  const retained = actor.permissionOverrides.filter(row => !isPermission(row.permission)
    || !permissionOverrideControl(actor, row.permission).editable
    || !permissionOverrideControl(proposed, row.permission).editable);
  const retainedCodes = new Set(retained.map(row => row.permission));
  if (requested.some(row => retainedCodes.has(row.permission))) throw new Error('READ_ONLY_OVERRIDE_SUBMITTED');
  return [...requested, ...retained];
}

/** Recover only absent historical DENY values from the exact current audit
 * successor. No allow, editable choice, or changed account state is replayed. */
export function historicalUneditableDenials(actor: PermissionSession, before: unknown, after: unknown) {
  const old = snapshots.safeParse(before), saved = snapshots.safeParse(after);
  if (!old.success || !saved.success || actor.role === 'admin'
    || overrideSnapshotHash(saved.data) !== overrideSnapshotHash(actor.permissionOverrides)) return [];
  const present = new Set(actor.permissionOverrides.map(row => row.permission));
  return old.data.filter(row => !row.allowed && !present.has(row.permission) && isPermission(row.permission)
    && !permissionOverrideControl(actor, row.permission).editable
    && !evaluatePermission({ ...actor, active: true }, row.permission).allowed);
}
