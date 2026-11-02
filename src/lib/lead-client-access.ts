import type { Prisma, PrismaClient } from '@prisma/client';
import type { AuthSession } from './auth';
import { canViewClient } from './access-control';
import { clientVisibilityWhere } from './core-query-policy';
import { loadClientReadScope } from './client-read-perimeter';
import { recordUpdatePermission } from './record-update-context';
import { assertLeadActorLive, LeadLifecycleError, lockLeadWriteActor } from './lead-lifecycle-lock';
import { currentTechnicalRestriction } from './technical-account-membership';
import { withSerializableTransaction } from './serializable';
import { requireCommercialOfferTargetAccess, requireLeadEditAccess } from './write-access';

export async function readableLeadClient(db: Pick<Prisma.TransactionClient, 'client'>, actor: AuthSession, clientId: string | null) {
  if (!clientId || actor.technicalRestricted || !recordUpdatePermission(actor, 'client.read')) return null;
  const client = await db.client.findFirst({
    where: { id: clientId, deletedAt: null, AND: [clientVisibilityWhere(actor)] },
    select: { id: true, displayName: true, salesOwnerId: true, consultantId: true },
  });
  return client && canViewClient(actor, client) ? { id: client.id, displayName: client.displayName } : null;
}

/** The public conversion action returns only a readable destination, including on replay. */
export function convertedClientReference(db: PrismaClient, session: AuthSession, leadId: string, clientId: string, mode: 'existing' | 'created') {
  return withSerializableTransaction(db, async tx => {
    const locked = await lockLeadWriteActor(tx, session, ['lead.read', 'lead.write', 'client.write']);
    const actor = { ...locked, clientReadScope: await loadClientReadScope(tx, locked.userId),
      technicalRestricted: await currentTechnicalRestriction(tx, locked.userId, locked) };
    if (actor.technicalRestricted) throw new LeadLifecycleError('DENIED');
    const lead = await requireLeadEditAccess(actor, leadId, tx);
    if (lead.clientId !== clientId) throw new LeadLifecycleError('STALE');
    if (mode === 'existing') await requireCommercialOfferTargetAccess(actor, { clientId }, tx);
    const client = await readableLeadClient(tx, actor, clientId);
    await assertLeadActorLive(tx, actor);
    return client ? { id: client.id } : null;
  });
}
