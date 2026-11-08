import { Prisma } from '@prisma/client';
import { canonicalSha256 } from './canonical-json';
import { canViewClient } from './access-control';
import { currentRecordUpdateUser, recordUpdateContext, recordUpdatePermission, recordReadPermissions } from './record-update-context';
import { isTechnicalAccount } from './technical-confidentiality';
import { hasSelectiveClientContext } from './selective-client-policy';
import { hasSelectiveContext } from './selective-project-policy';
import { isSelectivePractice } from './selective-practice-policy';
import { SharedOperationalUpdateError, type SharedUpdateTarget } from './shared-operational-update-contract';

type Tx = Prisma.TransactionClient;
export type SharedUpdatePerson = NonNullable<Awaited<ReturnType<typeof currentRecordUpdateUser>>>;
export async function sharedOperationalContext(tx: Tx, target: SharedUpdateTarget, write = false) {
  const base = await recordUpdateContext(tx, target.kind, target.id, write);
  if (!base.clientId) throw new SharedOperationalUpdateError('DENIED');
  const client = await tx.client.findUniqueOrThrow({ where: { id: base.clientId }, select: {
    id: true, salesOwnerId: true, consultantId: true, operationalState: true, displayName: true, leadId: true,
  } });
  const practice = target.kind === 'PRACTICE' ? await tx.technicalPractice.findUniqueOrThrow({ where: { id: target.id },
    select: { id: true, projectId: true, clientServiceId: true, commercialOwnerId: true, status: true } }) : null;
  const service = practice?.clientServiceId ? await tx.clientService.findUniqueOrThrow({ where: { id: practice.clientServiceId },
    select: { projectId: true } }) : null;
  const projectId = target.kind === 'PROJECT' ? target.id : practice?.projectId ?? service?.projectId ?? null;
  const project = projectId ? await tx.project.findUniqueOrThrow({ where: { id: projectId },
    select: { id: true, companyId: true, status: true } }) : null;
  const commercialId = practice?.commercialOwnerId ?? client.salesOwnerId;
  const state = practice?.status ?? project?.status ?? client.operationalState;
  const binding = canonicalSha256({ scope: base.scope, clientId: client.id, projectId,
    companyId: project?.companyId ?? null, commercialId });
  return { target, base, client, projectId, companyId: project?.companyId ?? null,
    practiceId: practice?.id ?? null, commercialId, state, binding };
}
export type SharedOperationalContext = Awaited<ReturnType<typeof sharedOperationalContext>>;

/** A notice is never an access grant. Commercial admission is limited to the
 * current named referent, the existing client perimeter and this typed panel.
 * It does not authorize the ordinary project/practice page or any attachment. */
export function canReadSharedOperational(actor: SharedUpdatePerson, context: SharedOperationalContext) {
  if (isTechnicalAccount(actor) || !recordUpdatePermission(actor, recordReadPermissions[context.target.kind])) return false;
  if (actor.role === 'admin') return context.base.canRead(actor);
  return actor.role === 'commerciale' && actor.id === context.commercialId
    && recordUpdatePermission(actor, 'client.read') && canViewClient(actor, context.client)
    && !hasSelectiveClientContext(actor, { clientId: context.client.id })
    && !hasSelectiveContext(actor, { projectId: context.projectId })
    && (context.target.kind !== 'PRACTICE' || !isSelectivePractice(actor, context.target.id));
}
export function sharedOperationalHref(target: SharedUpdateTarget) {
  return '/operational-updates/' + target.kind.toLowerCase() + '/' + encodeURIComponent(target.id);
}
export function sharedOperationalLinksMatch(row: { clientId: string; projectId: string | null; practiceId: string | null },
  context: SharedOperationalContext) {
  return row.clientId === context.client.id && row.projectId === context.projectId && row.practiceId === context.practiceId;
}

export async function sharedOperationalRecipients(tx: Tx, context: SharedOperationalContext) {
  const users = await tx.user.findMany({ where: { active: true, deletedAt: null,
    OR: [{ role: 'admin' }, ...(context.commercialId ? [{ id: context.commercialId, role: 'commerciale' as const }] : [])] },
    select: { id: true }, orderBy: { id: 'asc' } });
  const recipients: Array<{ id: string; epoch: number; name: string; role: string }> = [];
  for (const user of users) {
    const actor = await currentRecordUpdateUser(tx, user.id);
    if (actor && canReadSharedOperational(actor, context)) recipients.push({
      id: actor.id, epoch: actor.recordUpdateEpoch, name: actor.name, role: actor.role,
    });
  }
  return recipients;
}
