import type { Prisma } from '@prisma/client';
import type { AuthSession } from './auth';
import { canViewClient, canViewLead } from './access-control';
import { hasPermission } from './permission-evaluator';
import { ApprovedCommunicationError, type CommunicationContext } from './approved-communication-contract';
import { resolveCommunicationRecipients, type CommunicationRecipientSelection } from './communication-recipient-policy';
import { lockCommunicationDirectory } from './communication-directory-lock';

type Tx = Prisma.TransactionClient;
function denied(): never { throw new ApprovedCommunicationError('DENIED'); }
export function communicationRecordWhere(context: CommunicationContext): Prisma.ApprovedCommunicationWhereInput {
  switch (context.kind) {
    case 'READINESS': return { contextKind: 'LEGACY', readinessId: context.id };
    case 'TECHNICAL': return { contextKind: 'LEGACY', technicalPracticeId: context.id };
    case 'CLIENT': return { contextKind: 'CLIENT', clientId: context.id };
    case 'LEAD': return { contextKind: 'LEAD', leadId: context.id };
    case 'INTERNAL': return { contextKind: 'INTERNAL', internalThreadId: context.id };
  }
}
export function communicationFileWhere(context: CommunicationContext): Prisma.CommunicationContextFileWhereInput {
  const field = context.kind === 'READINESS' ? 'readinessId' : context.kind === 'TECHNICAL' ? 'technicalPracticeId'
    : context.kind === 'CLIENT' ? 'clientId' : context.kind === 'LEAD' ? 'leadId' : 'internalThreadId';
  return { contextKind: context.kind, [field]: context.id };
}

/** Called only inside the authoritative message transaction. A participant or
 * email destination never receives a client/project grant through this scope. */
export async function expandedCommunicationScope(tx: Tx, current: AuthSession,
  context: Extract<CommunicationContext, { kind: 'LEAD' | 'CLIENT' | 'INTERNAL' }>) {
  const empty = { practice: null, project: null, service: null, context, leadLifecycle: null as { id: string; createdAt: Date } | null };
  if (context.kind === 'LEAD') {
    await tx.$queryRaw`SELECT "id" FROM "Lead" WHERE "id"=${context.id} FOR SHARE`;
    const lead = await tx.lead.findUnique({ where: { id: context.id } });
    if (!lead || lead.deletedAt || !hasPermission(current, 'lead.read') || !canViewLead(current, lead)) denied();
    const leadLifecycle = await tx.auditLog.findFirst({ where: { entityType: 'Lead', entityId: lead.id, event: 'lead_lifecycle_changed' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true, createdAt: true } });
    return { ...empty, client: null, lead, thread: null, participants: null,
      label: lead.companyName || `${lead.firstName} ${lead.lastName}`, ...(leadLifecycle ? { leadLifecycle } : {}) };
  }
  if (context.kind === 'CLIENT') {
    await tx.$queryRaw`SELECT "id" FROM "Client" WHERE "id"=${context.id} FOR SHARE`;
    const client = await tx.client.findUnique({ where: { id: context.id } });
    if (!client || client.deletedAt || !hasPermission(current, 'client.read') || !canViewClient(current, client)) denied();
    return { ...empty, client, lead: null, thread: null, participants: null, label: client.displayName };
  }
  await tx.$queryRaw`SELECT "id" FROM "InternalCommunicationThread" WHERE "id"=${context.id}::uuid FOR SHARE`;
  const thread = await tx.internalCommunicationThread.findUnique({ where: { id: context.id } });
  if (!thread || thread.deletedAt) denied();
  await tx.$queryRaw`SELECT "userId" FROM "InternalCommunicationParticipant" WHERE "threadId"=${thread.id}::uuid ORDER BY "userId" FOR SHARE`;
  const participants = await tx.internalCommunicationParticipant.findMany({ where: { threadId: thread.id, active: true }, orderBy: { userId: 'asc' } });
  if (!participants.some(person => person.userId === current.userId)) denied();
  // Directory readers retain the shared admission lock; native account writers
  // acquire its exclusive form before actor locks, including owner revocation.
  const owner = await tx.user.findUnique({ where: { id: thread.ownerUserId }, select: { active: true, deletedAt: true } });
  if (!owner?.active || owner.deletedAt) denied();
  return { ...empty, client: null, lead: null, thread, participants, label: thread.title };
}

export async function lockedCommunicationRecipients(tx: Tx, selection: CommunicationRecipientSelection,
  external: { to: string[]; cc: string[]; bcc: string[] }, participantIds?: string[]) {
  // Acquire once before actor/context locks, then retain through DATA. Reentry
  // here is safe; all native directory writers follow that same order.
  await lockCommunicationDirectory(tx);
  const directory = await tx.user.findMany({ select: { id: true, name: true, email: true, role: true, active: true, deletedAt: true }, orderBy: { id: 'asc' } });
  try { return resolveCommunicationRecipients(selection, directory, external, participantIds); }
  catch { throw new ApprovedCommunicationError('CONFLICT'); }
}
