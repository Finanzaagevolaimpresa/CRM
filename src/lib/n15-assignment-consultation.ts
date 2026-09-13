import type { PrismaClient } from '@prisma/client';
import type { AuthSession } from './auth';
import { canViewLead } from './access-control';
import { parseCommunicationPersistenceAggregateV1 } from './communication-intent-persistence';
import { hasPermission } from './permission-evaluator';
import { isN15SyntheticAssignmentAdmitted } from './n15-synthetic-self-claim-admission';
import { N15_ASSIGNMENT_SYNTHETIC_PROFILE } from './n15-synthetic-assignment';

export type N15AssignmentConsultation = Readonly<{
  activityId: string;
  recipientUserId: string;
  state: 'HELD';
  occurredAt: Date;
}>;

export class N15AssignmentConsultationError extends Error {
  constructor(readonly code: 'N15_ASSIGNMENT_CONSULTATION_DISABLED' | 'N15_ASSIGNMENT_CONSULTATION_DENIED') {
    super(code);
    this.name = 'N15AssignmentConsultationError';
  }
}

/** Server-only read boundary: it repeats lead ABAC and never exposes canonical payloads. */
export async function listN15SyntheticAssignmentsForLead(
  db: PrismaClient,
  session: AuthSession,
  lead: Readonly<{ id: string; assignedToId: string | null }>,
): Promise<readonly N15AssignmentConsultation[]> {
  if (!isN15SyntheticAssignmentAdmitted()) {
    throw new N15AssignmentConsultationError('N15_ASSIGNMENT_CONSULTATION_DISABLED');
  }
  if (!hasPermission(session, 'lead.read') || !canViewLead(session, lead)) {
    throw new N15AssignmentConsultationError('N15_ASSIGNMENT_CONSULTATION_DENIED');
  }
  const activities = await db.commercialLeadActivity.findMany({
    where: { inboxItem: { leadId: lead.id }, activityType: 'ASSIGNED' },
    select: { id: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 100,
  });
  if (activities.length === 0) return [];
  const records = await db.communicationIntentRecord.findMany({
    where: { intentId: { in: activities.map(({ id }) => id) }, producerCode: N15_ASSIGNMENT_SYNTHETIC_PROFILE.producerCode },
    include: { heldDecision: true, auditRecord: true }, orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
  });
  return records.map((record) => {
    const { intent } = parseCommunicationPersistenceAggregateV1(record);
    return { activityId: intent.intentId, recipientUserId: intent.recipient.entityId,
      state: 'HELD' as const, occurredAt: new Date(intent.occurredAt) };
  });
}
