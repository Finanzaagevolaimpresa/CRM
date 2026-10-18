import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { AuthSession, Permission } from './auth';
import { UserFacingActionError } from './action-errors';
import { canEditLead } from './access-control';
import { hasPermission } from './permission-evaluator';
import { lockAuthoritativeInternalSession } from './internal-session-registry';
import { internalSessionMode } from './session';
import { loadSelectiveLeadScope } from './selective-lead-scope';

export class LeadLifecycleError extends UserFacingActionError {
  constructor(readonly code: 'DENIED' | 'STALE') {
    super(code === 'STALE' ? 'Il lead è cambiato. Ricarica la pagina prima di riprovare.'
      : 'Lead o operazione non disponibili per il tuo accesso attuale.');
  }
}
export async function leadClock(tx: Prisma.TransactionClient) {
  const [row] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
  if (!row) throw new LeadLifecycleError('DENIED');
  return row.now;
}
export async function lockLeadWriteActor(tx: Prisma.TransactionClient, claimed: AuthSession, permissions: readonly Permission[]) {
  if (internalSessionMode() !== 'registry' || !z.string().uuid().safeParse(claimed.sessionId).success) throw new LeadLifecycleError('DENIED');
  const row = await lockAuthoritativeInternalSession(tx, { userId: claimed.userId, sessionId: claimed.sessionId! });
  if (!row || row.revokedAt || !row.active || row.deletedAt) throw new LeadLifecycleError('DENIED');
  const current = { ...claimed, ...await loadSelectiveLeadScope(tx, claimed.userId), role: row.role, active: row.active, permissionOverrides: [...row.permissionOverrides], registryExpiresAt: row.expiresAt };
  // An explicit suspension also blocks this personal operation for an Admin.
  if (permissions.some(permission => !hasPermission(current, permission)
    || current.permissionOverrides.some(item => item.permission === permission && !item.allowed))) throw new LeadLifecycleError('DENIED');
  await assertLeadActorLive(tx, current);
  return current;
}
export function lockLeadActor(tx: Prisma.TransactionClient, claimed: AuthSession, write = true) {
  return lockLeadWriteActor(tx, claimed, write ? ['lead.read', 'lead.write'] : ['lead.read']);
}
export async function assertLeadActorLive(tx: Prisma.TransactionClient, current: AuthSession & { registryExpiresAt: Date }) {
  const now = await leadClock(tx);
  if (!Number.isFinite(current.expiresAt) || current.expiresAt * 1000 <= now.getTime() || current.registryExpiresAt <= now) throw new LeadLifecycleError('DENIED');
}
/** Hold through the dependent mutation: a page-time access check alone is insufficient. */
export async function assertLeadOperational(tx: Prisma.TransactionClient, id?: string | null) {
  if (!id) return null;
  await tx.$queryRaw`SELECT "id" FROM "Lead" WHERE "id"=${id} FOR SHARE`;
  const lead = await tx.lead.findUnique({ where: { id } });
  if (!lead || lead.deletedAt) throw new LeadLifecycleError('DENIED');
  return lead;
}
export async function lockLeadForMutation(tx: Prisma.TransactionClient, claimed: AuthSession, id: string, expectedVersion: string) {
  const current = await lockLeadActor(tx, claimed);
  await tx.$queryRaw`SELECT "id" FROM "Lead" WHERE "id"=${id} FOR UPDATE`;
  const lead = await tx.lead.findUnique({ where: { id } });
  if (!lead || lead.deletedAt || !canEditLead(current, lead)) throw new LeadLifecycleError('DENIED');
  if (lead.updatedAt.toISOString() !== expectedVersion) throw new LeadLifecycleError('STALE');
  return { current, lead };
}
