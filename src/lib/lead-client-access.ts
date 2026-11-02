import type { ClientType, Prisma, PrismaClient } from '@prisma/client';
import type { AuthSession } from './auth';
import { canViewClient } from './access-control';
import { clientVisibilityWhere } from './core-query-policy';
import { loadClientReadScope } from './client-read-perimeter';
import { recordUpdatePermission } from './record-update-context';
import { assertLeadActorLive, LeadLifecycleError, lockLeadForMutation, lockLeadWriteActor } from './lead-lifecycle-lock';
import { isTechnicalAccount } from './technical-confidentiality';
import { currentTechnicalRestriction } from './technical-account-membership';
import { nextConcurrencyTimestamp, withSerializableTransaction } from './serializable';
import { requireCommercialOfferTargetAccess, requireLeadEditAccess } from './write-access';

export async function readableLeadClient(db: Pick<Prisma.TransactionClient, 'client'>, actor: AuthSession, clientId: string | null) {
  if (!clientId || isTechnicalAccount(actor) || !recordUpdatePermission(actor, 'client.read')) return null;
  const client = await db.client.findFirst({
    where: { id: clientId, deletedAt: null, AND: [clientVisibilityWhere(actor)] },
    select: { id: true, displayName: true, salesOwnerId: true, consultantId: true },
  });
  return client && canViewClient(actor, client) ? { id: client.id, displayName: client.displayName } : null;
}

async function currentConversionActor(tx: Prisma.TransactionClient, locked: Awaited<ReturnType<typeof lockLeadWriteActor>>) {
  if (!recordUpdatePermission(locked, 'client.write') || await currentTechnicalRestriction(tx, locked.userId, locked)) {
    throw new LeadLifecycleError('DENIED');
  }
  return { ...locked, clientReadScope: await loadClientReadScope(tx, locked.userId), technicalRestricted: false };
}

/** The public conversion action returns only a readable destination, including on replay. */
export function convertedClientReference(db: PrismaClient, session: AuthSession, leadId: string, clientId: string, mode: 'existing' | 'created') {
  return withSerializableTransaction(db, async tx => {
    const locked = await lockLeadWriteActor(tx, session, ['lead.read', 'lead.write', 'client.write']);
    const actor = await currentConversionActor(tx, locked);
    const lead = await requireLeadEditAccess(actor, leadId, tx);
    if (lead.clientId !== clientId) throw new LeadLifecycleError('STALE');
    if (mode === 'existing') await requireCommercialOfferTargetAccess(actor, { clientId }, tx);
    const client = await readableLeadClient(tx, actor, clientId);
    await assertLeadActorLive(tx, actor);
    return client ? { id: client.id } : null;
  });
}

export function convertUnlinkedLeadToClient(db: PrismaClient, session: AuthSession,
  data: { id: string; expectedVersion: string; type: ClientType }) {
  return withSerializableTransaction(db, async tx => {
    const { current: locked, lead } = await lockLeadForMutation(tx, session, data.id, data.expectedVersion);
    const current = await currentConversionActor(tx, locked);
    if (lead.clientId
      || await tx.commercialLeadInboxItem.findUnique({ where: { leadId: lead.id } })) throw new LeadLifecycleError('STALE');
    const displayName = lead.companyName || `${lead.firstName} ${lead.lastName}`.trim();
    const client = await tx.client.create({ data: { type: data.type, displayName, leadId: lead.id, salesOwnerId: lead.assignedToId, notes: lead.notes } });
    await tx.lead.update({ where: { id: lead.id, clientId: null, updatedAt: lead.updatedAt, deletedAt: null },
      data: { clientId: client.id, status: 'vinto', updatedAt: nextConcurrencyTimestamp(lead.updatedAt) } });
    await tx.auditLog.create({ data: { actorId: current.userId, event: 'lead_convert_to_client', entityType: 'Lead', entityId: lead.id,
      after: { leadId: lead.id, clientId: client.id, fromStatus: lead.status, toStatus: 'vinto', salesOwnerId: client.salesOwnerId } } });
    const visible = await readableLeadClient(tx, current, client.id);
    await assertLeadActorLive(tx, current);
    return visible ? { id: visible.id } : null;
  });
}
