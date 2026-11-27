import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { canonicalSha256 } from './canonical-json';
import { currentRecordUpdateUser, recordUpdateContext, recordUpdatePermission } from './record-update-context';
import { responsibilityDecision } from './responsibility-contract';
import { RecordUpdateError } from './record-update-contract';

type Tx = Prisma.TransactionClient;
export const workflowSourceKind = z.enum(['APPOINTMENT_BOOKED', 'ASSIGNMENT_CONFIRMED', 'STATUS_CHANGED', 'DOCUMENT_REQUESTED']);
export const workflowSourceInput = z.object({ kind: workflowSourceKind, leadId: z.string().min(1).max(128),
  referenceId: z.string().min(1).max(128), referenceVersion: z.number().int().positive().optional(),
  origin: z.enum(['COMMERCIAL_ACTIVITY', 'RESPONSIBILITY']).optional(),
  documents: z.array(z.string().trim().min(2).max(180)).min(1).max(40).optional() }).strict();
export type WorkflowSourceInput = z.infer<typeof workflowSourceInput>;
const sourceSnapshot = z.object({ input: workflowSourceInput, hash: z.string().regex(/^[a-f0-9]{64}$/),
  observedLeadVersion: z.string(), ownerId: z.string().nullable(), ownerEpoch: z.number().int(), data: z.record(z.string(), z.unknown()) });
export type WorkflowBoundSource = z.infer<typeof sourceSnapshot>;
const plain = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value));
export class WorkflowSourceError extends Error {}
function unavailable(): never { throw new WorkflowSourceError('WORKFLOW_SOURCE_CHANGED'); }

/** Read an actual source in the current lead perimeter. A document request is an
 * explicit operator command; its UUID and requested list are its source fact. */
export async function resolveWorkflowSource(tx: Tx, raw: WorkflowSourceInput) {
  const input = workflowSourceInput.parse(raw);
  const context = await recordUpdateContext(tx, 'LEAD', input.leadId, true);
  const lead = await tx.lead.findUniqueOrThrow({ where: { id: input.leadId } });
  const owner = lead.assignedToId ? await currentRecordUpdateUser(tx, lead.assignedToId) : null;
  if (lead.assignedToId && (!owner || !context.canRead(owner))) unavailable();
  let data: Record<string, unknown>, appointmentAt: string | undefined, reminderBefore: Date | undefined;
  if (input.kind === 'APPOINTMENT_BOOKED') {
    z.string().uuid().parse(input.referenceId);
    const appointment = await tx.leadAppointment.findUnique({ where: { id: input.referenceId }, include: { calendar: true } });
    if (!appointment || appointment.leadId !== lead.id || appointment.status !== 'BOOKED' || appointment.version !== input.referenceVersion) unavailable();
    const calendarOwner = await currentRecordUpdateUser(tx, appointment.calendar.userId);
    if (!calendarOwner || !recordUpdatePermission(calendarOwner, 'lead.read')) unavailable();
    data = { id: appointment.id, version: appointment.version, generation: appointment.generation, calendarId: appointment.calendarId,
      calendarOwnerId: calendarOwner.id, calendarOwnerEpoch: calendarOwner.recordUpdateEpoch,
      startsAt: appointment.startsAt.toISOString(), endsAt: appointment.endsAt.toISOString(), status: appointment.status };
    reminderBefore = appointment.startsAt;
    appointmentAt = new Intl.DateTimeFormat('it-IT', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Rome' }).format(appointment.startsAt) + ' Europe/Rome';
  } else if (input.kind === 'ASSIGNMENT_CONFIRMED') {
    if (!owner) unavailable();
    if (input.origin === 'COMMERCIAL_ACTIVITY') {
      z.string().uuid().parse(input.referenceId);
      const activity = await tx.commercialLeadActivity.findUnique({ where: { id: input.referenceId }, include: { inboxItem: true } });
      const latest = activity && await tx.commercialLeadActivity.findFirst({ where: { inboxItemId: activity.inboxItemId,
        activityType: { in: ['ASSIGNED', 'UNASSIGNED', 'CLAIMED'] } }, orderBy: { sequence: 'desc' } });
      if (!activity || activity.activityType !== 'ASSIGNED' || activity.inboxItem.leadId !== lead.id || latest?.id !== activity.id
        || activity.assigneeAfterId !== owner.id || activity.inboxItem.state === 'CLOSED') unavailable();
      data = { id: activity.id, sequence: activity.sequence, actorId: activity.actorUserId, assigneeId: activity.assigneeAfterId,
        inboxVersionAfter: activity.inboxVersionAfter, createdAt: activity.createdAt.toISOString() };
    } else if (input.origin === 'RESPONSIBILITY') {
      // N14 emits both a commercial activity and a responsibility decision.
      // Only its activity is an enrollment source for that single assignment.
      if (await tx.commercialLeadInboxItem.findUnique({ where: { leadId: lead.id }, select: { id: true } })) unavailable();
      const audit = await tx.auditLog.findUnique({ where: { id: input.referenceId } });
      const decision = responsibilityDecision.safeParse(audit?.after);
      const latest = await tx.auditLog.findFirst({ where: { entityType: 'Lead', entityId: lead.id, event: 'responsibility_assigned' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
      if (!audit || audit.id !== latest?.id || !decision.success || !decision.data.allowed
        || decision.data.state.commercialOwnerId !== owner.id || decision.data.state.clientId !== lead.clientId) unavailable();
      data = { id: audit.id, actorId: audit.actorId, decision: decision.data, createdAt: audit.createdAt.toISOString() };
    } else unavailable();
  } else if (input.kind === 'STATUS_CHANGED') {
    z.string().uuid().parse(input.referenceId);
    const event = await tx.recordUpdateEvent.findUnique({ where: { id: input.referenceId } });
    const latest = await tx.recordUpdateEvent.findFirst({ where: { kind: 'LEAD', recordId: lead.id, event: 'STATE_CHANGED' },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }] });
    if (!event || event.id !== latest?.id || event.kind !== 'LEAD' || event.recordId !== lead.id || event.event !== 'STATE_CHANGED'
      || canonicalSha256(event.scope) !== context.scopeDigest || !Array.isArray(event.changed) || !event.changed.includes('status')) unavailable();
    data = { id: event.id, event: event.event, changed: event.changed, scope: event.scope, occurredAt: event.occurredAt.toISOString(), status: lead.status };
  } else {
    z.string().uuid().parse(input.referenceId);
    if (!input.documents?.length || new Set(input.documents).size !== input.documents.length) unavailable();
    data = { commandId: input.referenceId, documents: input.documents };
  }
  const binding = { input, data: plain(data) };
  const source = { ...binding, ownerId: lead.assignedToId, ownerEpoch: lead.recordUpdateEpoch,
    observedLeadVersion: lead.updatedAt.toISOString(), hash: canonicalSha256(binding) };
  return { source, context, lead, owner, reminderBefore,
    fields: { firstName: lead.firstName, companyName: lead.companyName ?? '', ...(appointmentAt ? { appointmentAt } : {}),
      ...(input.documents ? { documentList: input.documents.join('\n') } : {}) } };
}

export async function workflowSourceStillCurrent(tx: Tx, snapshot: Prisma.JsonValue, expectedHash: string) {
  const raw = z.object({ source: sourceSnapshot.optional() }).passthrough().parse(snapshot).source;
  if (!raw) return true; // Receipt-based lead acquisition has its own source binding.
  if (raw.hash !== expectedHash || canonicalSha256({ input: raw.input, data: raw.data }) !== raw.hash) throw new Error('WORKFLOW_SOURCE_BINDING_INVALID');
  try {
    const current = (await resolveWorkflowSource(tx, raw.input)).source;
    return current.hash === expectedHash && current.ownerId === raw.ownerId && current.ownerEpoch === raw.ownerEpoch;
  }
  catch (error) { if (error instanceof WorkflowSourceError || error instanceof RecordUpdateError && error.code === 'DENIED') return false; throw error; }
}

export async function workflowSourceChoices(tx: Tx, leadId: string) {
  const [appointment, activity, responsibility, state] = await Promise.all([
    tx.leadAppointment.findUnique({ where: { leadId } }),
    tx.commercialLeadActivity.findFirst({ where: { inboxItem: { leadId }, activityType: 'ASSIGNED' }, orderBy: { sequence: 'desc' } }),
    tx.auditLog.findFirst({ where: { entityType: 'Lead', entityId: leadId, event: 'responsibility_assigned' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }),
    tx.recordUpdateEvent.findFirst({ where: { kind: 'LEAD', recordId: leadId, event: 'STATE_CHANGED' }, orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }] }),
  ]);
  const candidates: WorkflowSourceInput[] = [
    ...(appointment?.status === 'BOOKED' ? [{ kind: 'APPOINTMENT_BOOKED' as const, leadId, referenceId: appointment.id, referenceVersion: appointment.version }] : []),
    ...(activity ? [{ kind: 'ASSIGNMENT_CONFIRMED' as const, leadId, referenceId: activity.id, origin: 'COMMERCIAL_ACTIVITY' as const }]
      : responsibility ? [{ kind: 'ASSIGNMENT_CONFIRMED' as const, leadId, referenceId: responsibility.id, origin: 'RESPONSIBILITY' as const }] : []),
    ...(state ? [{ kind: 'STATUS_CHANGED' as const, leadId, referenceId: state.id }] : []),
  ];
  const admitted: WorkflowSourceInput[] = [];
  for (const candidate of candidates) {
    try { await resolveWorkflowSource(tx, candidate); admitted.push(candidate); }
    catch (error) { if (!(error instanceof WorkflowSourceError)) throw error; }
  }
  return admitted;
}
