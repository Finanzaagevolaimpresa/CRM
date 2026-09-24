import type { Prisma, PrismaClient, RoleCode } from '@prisma/client';
import { UserFacingActionError } from './action-errors';
import { lockAuthoritativeInternalSession, lockInternalUser } from './internal-session-registry';
import { internalSessionMode } from './session';
import { withSerializableTransaction } from './serializable';

export type AssignmentActor = { userId: string; sessionId?: string };
export type AssignmentTarget = { userId?: string | null; roles?: readonly RoleCode[] };

export function denyManualAssignment(): never {
  throw new UserFacingActionError('L’assegnazione è riservata all’amministratore. Aggiorna la pagina e verifica il responsabile.');
}

// An omitted or unchanged form field must never overwrite a concurrent assignment.
export function changedAssignee(before: string | null, submitted: boolean, proposed?: string | null) {
  const next = proposed || null;
  return submitted && next !== before ? next : undefined;
}

export async function authorizeManualAssignment(
  tx: Prisma.TransactionClient, actor: AssignmentActor, targets: readonly AssignmentTarget[],
) {
  if (internalSessionMode() !== 'registry' || !actor.sessionId) denyManualAssignment();
  const session = await lockAuthoritativeInternalSession(tx, { userId: actor.userId, sessionId: actor.sessionId });
  if (!session || !session.active || session.deletedAt || session.revokedAt || !session.live || session.role !== 'admin') {
    denyManualAssignment();
  }
  // Keep target activity/role stable through the assignment commit; suspension uses the same user lock.
  for (const id of [...new Set(targets.flatMap(target => target.userId ? [target.userId] : []))].sort()) {
    const target = await lockInternalUser(tx, id);
    if (!target || !target.active || target.deletedAt) denyManualAssignment();
    const user = await tx.user.findUniqueOrThrow({ where: { id }, select: { role: true } });
    if (targets.some(candidate => candidate.userId === id && candidate.roles && !candidate.roles.includes(user.role))) {
      denyManualAssignment();
    }
  }
}

export function withAssignmentGuard<T>(
  db: PrismaClient, actor: AssignmentActor, changesAssignment: boolean,
  targets: readonly AssignmentTarget[], work: (tx: Prisma.TransactionClient) => Promise<T>,
) {
  return withSerializableTransaction(db, async tx => {
    if (changesAssignment) await authorizeManualAssignment(tx, actor, targets);
    return work(tx);
  });
}
