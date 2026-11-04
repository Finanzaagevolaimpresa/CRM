import type { Prisma } from '@prisma/client';
import { historicalUneditableDenials, overrideSnapshotHash } from './permission-override-preservation';
import { currentTechnicalRestriction } from './technical-account-membership';
import type { PermissionSession } from './permission-evaluator';

type Tx = Prisma.TransactionClient;
type Target = PermissionSession & { id: string };
const events = ['user_permission_overrides_updated', 'user_permission_overrides_reset', 'role_change', 'user_permission_denials_restored'];
export async function readPermissionDenialRestoration(tx: Tx, user: Target) {
  const source = await tx.auditLog.findFirst({ where: { entityType: 'User', entityId: user.id, event: { in: events } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true, event: true, before: true, after: true, createdAt: true } });
  if (!source || source.event !== 'user_permission_overrides_updated') return null;
  const target = { ...user, technicalRestricted: await currentTechnicalRestriction(tx, user.id, user) };
  const denials = historicalUneditableDenials(target, source.before, source.after);
  return denials.length ? { sourceAuditId: source.id, createdAt: source.createdAt, denials,
    sourceHash: overrideSnapshotHash(denials) } : null;
}

/** Called only inside the registered Admin command transaction after current
 * authority, step-up, user-version and command-id checks. No snapshot is accepted
 * from the browser and no prior audit row is rewritten. */
export async function restorePermissionDenials(tx: Tx, actorId: string, user: Target,
  input: { sourceAuditId: string; sourceHash: string }) {
  if (user.id === actorId || user.role === 'admin') return { ok: false };
  const proposal = await readPermissionDenialRestoration(tx, user);
  if (!proposal || proposal.sourceAuditId !== input.sourceAuditId || proposal.sourceHash !== input.sourceHash) return { ok: false };
  await tx.userPermissionOverride.createMany({ data: proposal.denials.map(row => ({ userId: user.id, ...row })) });
  await tx.auditLog.create({ data: { actorId, entityType: 'User', entityId: user.id, event: 'user_permission_denials_restored',
    before: { overrides: user.permissionOverrides.map(({ permission, allowed }) => ({ permission, allowed })) },
    after: { sourceAuditId: proposal.sourceAuditId, restoredDenials: proposal.denials, sourceHash: proposal.sourceHash,
      reason: 'Ripristino esplicito dei soli dinieghi non modificabili omessi dal precedente salvataggio.',
      overrides: [...user.permissionOverrides.map(({ permission, allowed }) => ({ permission, allowed })), ...proposal.denials] } } });
  return { ok: true };
}
