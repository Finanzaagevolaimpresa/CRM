import type { Prisma } from '@prisma/client';
import { sharedUpdateTarget, SharedOperationalUpdateError } from './shared-operational-update-contract';
import { RecordUpdateError } from './record-update-contract';
import { sharedOperationalContext, sharedOperationalLinksMatch, canReadSharedOperational,
  sharedOperationalHref, type SharedUpdatePerson } from './shared-operational-context';
import type { RecordUpdateWork } from './record-update-admission';

export async function visibleSharedOperationalNotice(tx: Prisma.TransactionClient, actor: SharedUpdatePerson, work: RecordUpdateWork) {
  if (work.mode !== 'CRM' || work.ruleId || !work.commandId || work.recipientId !== actor.id
    || work.recipientEpoch !== actor.recordUpdateEpoch || work.event.sourceKey !== 'shared-update:' + work.commandId) return null;
  const row = await tx.sharedOperationalUpdate.findUnique({ where: { id: work.commandId } });
  if (!row || row.eventId !== work.eventId || row.kind !== work.event.kind || row.recordId !== work.event.recordId
    || row.classification !== 'SHARED_OPERATIONAL' || work.command?.mode !== 'CRM') return null;
  try {
    const target = sharedUpdateTarget.parse({ kind: row.kind, id: row.recordId });
    const context = await sharedOperationalContext(tx, target);
    if (!sharedOperationalLinksMatch(row, context) || !canReadSharedOperational(actor, context)) return null;
    return { id: work.id, title: 'Aggiornamento operativo condiviso', category: 'Notifica interna · nessuna email',
      related: context.base.label, href: '/notifications/updates/' + work.id, recordHref: sharedOperationalHref(target),
      date: row.createdAt, readAt: work.readAt, changed: ['profile'] as ['profile'], event: 'RECORD_CHANGED' as const,
      priority: 'bassa' as const, accessUntil: Infinity };
  } catch (error) {
    if (error instanceof SharedOperationalUpdateError || error instanceof RecordUpdateError) return null;
    throw error;
  }
}
