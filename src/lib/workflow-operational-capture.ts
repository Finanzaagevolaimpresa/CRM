import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { AuthSession } from './auth';
import { updateActor } from './record-updates';
import { currentRecordUpdateUser, recordUpdatePermission } from './record-update-context';
import { lockCommunicationDirectory } from './communication-directory-lock';
import { withSerializableTransaction } from './serializable';
import { planWorkflowOperationalEventInTransaction } from './workflow-event-planner';
import { resolveWorkflowSource, type WorkflowSourceInput } from './workflow-event-source';

type Tx = Prisma.TransactionClient;
type AutomaticSource = Omit<WorkflowSourceInput, 'kind'> & { kind: 'APPOINTMENT_BOOKED' | 'ASSIGNMENT_CONFIRMED' | 'STATUS_CHANGED' };
const kinds: AutomaticSource['kind'][] = ['APPOINTMENT_BOOKED', 'ASSIGNMENT_CONFIRMED', 'STATUS_CHANGED'];

/** Only the native status command calls this, after its actual update and audit.
 * No subscription, delivery, implicit rule or recipient is created. The audit
 * must belong to this transaction and attest a real before/after status change. */
export async function recordWorkflowLeadStatusEvent(tx: Tx, leadId: string, auditId: string): Promise<AutomaticSource | null> {
  if (process.env.WORKFLOW_NATIVE_PREPARATION_MODE !== 'enabled') return null;
  const audits = await tx.$queryRaw<Array<{ after: Prisma.JsonValue }>>`SELECT "after" FROM "AuditLog"
    WHERE id=${auditId} AND "entityType"='Lead' AND "entityId"=${leadId} AND event='lead_status_change'
      AND xmin::text::bigint=(txid_current()%4294967296)`;
  const audit = z.object({ before: z.object({ status: z.string() }), after: z.object({ status: z.string() }) }).parse(audits[0]?.after);
  if (audit.before.status === audit.after.status) throw new Error('WORKFLOW_STATUS_SOURCE_INVALID');
  const lead = await tx.lead.findUniqueOrThrow({ where: { id: leadId }, select: { status: true } });
  if (lead.status !== audit.after.status) throw new Error('WORKFLOW_STATUS_SOURCE_INVALID');
  const [scope] = await tx.$queryRaw<Array<{ value: Prisma.InputJsonValue | null }>>`SELECT fai_record_update_scope('LEAD',${leadId}) AS value`;
  if (!scope?.value) throw new Error('WORKFLOW_STATUS_SOURCE_INVALID');
  const existing = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "RecordUpdateEvent"
    WHERE kind='LEAD' AND "recordId"=${leadId} AND event='STATE_CHANGED' AND changed @> '["status"]'::jsonb
      AND scope=${JSON.stringify(scope.value)}::jsonb AND xmin::text::bigint=(txid_current()%4294967296)`;
  if (existing.length > 1) throw new Error('WORKFLOW_STATUS_SOURCE_AMBIGUOUS');
  const event = existing[0] ?? await tx.recordUpdateEvent.create({ data: { kind: 'LEAD', recordId: leadId, event: 'STATE_CHANGED',
    changed: ['status'], scope: scope.value, sourceKey: 'workflow-status:' + auditId }, select: { id: true } });
  return { kind: 'STATUS_CHANGED', leadId, referenceId: event.id };
}

export async function workflowOperationalEffectiveAt(tx: Tx, source: AutomaticSource): Promise<Date | null> {
  if (source.kind === 'APPOINTMENT_BOOKED') {
    const row = await tx.auditLog.findFirst({ where: { entityType: 'Lead', entityId: source.leadId,
      event: { in: ['lead_appointment_booked', 'lead_appointment_rescheduled'] },
      AND: [{ after: { path: ['appointmentId'], equals: source.referenceId } }, { after: { path: ['version'], equals: source.referenceVersion } }] },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { createdAt: true } });
    return row?.createdAt ?? null;
  }
  if (source.kind === 'STATUS_CHANGED') return (await tx.recordUpdateEvent.findUnique({ where: { id: source.referenceId }, select: { occurredAt: true } }))?.occurredAt ?? null;
  if (source.origin === 'COMMERCIAL_ACTIVITY') return (await tx.commercialLeadActivity.findUnique({ where: { id: source.referenceId }, select: { createdAt: true } }))?.createdAt ?? null;
  return (await tx.auditLog.findUnique({ where: { id: source.referenceId }, select: { createdAt: true } }))?.createdAt ?? null;
}

/** A rule's current author may admit intent under the current native authority.
 * There is no synthetic session, mailbox draft, provider or transport here. */
export async function captureWorkflowOperationalEvent(tx: Tx, source: AutomaticSource) {
  if (process.env.WORKFLOW_NATIVE_PREPARATION_MODE !== 'enabled') return { captured: 0 };
  await lockCommunicationDirectory(tx);
  await tx.$queryRaw`SELECT id FROM "OrdinaryEmailAuthority" WHERE id='ordinary-email' FOR SHARE`;
  const authority = await tx.ordinaryEmailAuthority.findUnique({ where: { id: 'ordinary-email' } });
  if (!authority?.enabled) return { captured: 0 };
  const rules = await tx.workflowAutomation.findMany({ where: { event: source.kind, state: 'ACTIVE', createdById: authority.userId } });
  if (rules.length !== 1) return { captured: 0 };
  await tx.$queryRaw`SELECT id FROM "WorkflowAutomation" WHERE id=${rules[0].id}::uuid FOR SHARE`;
  const rule = await tx.workflowAutomation.findUniqueOrThrow({ where: { id: rules[0].id } });
  if (rule.state !== 'ACTIVE') return { captured: 0 };
  await tx.$queryRaw`SELECT id FROM "User" WHERE id=${rule.createdById} FOR SHARE`;
  const author = await currentRecordUpdateUser(tx, rule.createdById);
  if (!author || author.role !== 'admin' || !recordUpdatePermission(author, 'practice_communications.write') || !recordUpdatePermission(author, 'lead.read')) return { captured: 0 };
  const occurredAt = await workflowOperationalEffectiveAt(tx, source);
  // Activating or revising a rule never enrolls earlier operational events.
  if (!occurredAt || occurredAt < rule.updatedAt) return { captured: 0 };
  const resolved = await resolveWorkflowSource(tx, source);
  const result = await planWorkflowOperationalEventInTransaction(tx, { actor: author, finish: async () => {
    const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`; return clock.now;
  } }, { automationId: rule.id, source, expectedLeadVersion: resolved.lead.updatedAt.toISOString() });
  if (!result.replay) await tx.auditLog.create({ data: { actorId: author.id, entityType: 'WorkflowEnrollment', entityId: result.id,
    event: 'workflow_operational_hook_recorded', after: { kind: source.kind, referenceId: source.referenceId, ruleAuthorId: author.id, providerCalls: 0 } } });
  return { captured: result.replay ? 0 : 1 };
}

export async function captureWorkflowOperationalEventAfterCommit(db: PrismaClient, source: AutomaticSource | null) {
  if (process.env.WORKFLOW_NATIVE_PREPARATION_MODE !== 'enabled') return { captured: 0 };
  if (!source) return { captured: 0 };
  try { return await withSerializableTransaction(db, tx => captureWorkflowOperationalEvent(tx, source), { timeout: 30_000 }); }
  catch {
    try { await db.auditLog.create({ data: { entityType: 'Lead', entityId: source.leadId, event: 'workflow_capture_held',
      after: { reason: 'OPERATIONAL_CAPTURE_REQUIRES_RECOVERY', sourceKind: source.kind, referenceId: source.referenceId, providerCalls: 0 } } }); } catch { /* Native source already committed. */ }
    return { captured: 0 };
  }
}

/** Explicit bounded recovery from persisted native sources, under a real current
 * session. Old, superseded and already enrolled facts are excluded by the query;
 * capture rechecks authority, source and rule in its own transaction. */
export async function recoverWorkflowOperationalEvents(db: PrismaClient, session: AuthSession, input: { automationId?: string; limit: number }) {
  if (process.env.WORKFLOW_NATIVE_PREPARATION_MODE !== 'enabled') throw new Error('WORKFLOW_NATIVE_PREPARATION_DISABLED');
  const limit = z.number().int().min(1).max(50).parse(input.limit);
  const sources = await db.$transaction(async tx => {
    const auth = await updateActor(tx, session);
    if (auth.actor.role !== 'admin' || !recordUpdatePermission(auth.actor, 'practice_communications.write') || !recordUpdatePermission(auth.actor, 'lead.read')) throw new Error('WORKFLOW_DENIED');
    const authority = await tx.ordinaryEmailAuthority.findUnique({ where: { id: 'ordinary-email' } });
    if (!authority?.enabled || authority.userId !== auth.actor.id) throw new Error('WORKFLOW_SENDER_AUTHORITY_REQUIRED');
    const rules = await tx.workflowAutomation.findMany({ where: { state: 'ACTIVE', event: { in: kinds }, createdById: auth.actor.id,
      ...(input.automationId ? { id: input.automationId } : {}) }, orderBy: { id: 'asc' }, take: 50 });
    const sources = await recoverableWorkflowSources(tx,rules,limit);
    await auth.finish(); return sources;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 });
  let captured = 0;
  for (const source of sources) captured += (await captureWorkflowOperationalEventAfterCommit(db, source)).captured;
  return { examined: sources.length, captured, providerCalls: 0 as const };
}

/** Bounded source query shared by human recovery and the service grant. The
 * caller supplies an admitted rule/cutoff; the planner rechecks current scope. */
export async function recoverableWorkflowSources(tx: Tx,rules: Array<{ id: string;event: string;updatedAt: Date }>,limit: number) {
    const selected: AutomaticSource[] = [];
    for (const rule of rules) {
      const remaining = limit - selected.length; if (!remaining) break;
      let rows: Array<{ leadId: string; referenceId: string; referenceVersion?: number; origin?: 'COMMERCIAL_ACTIVITY' | 'RESPONSIBILITY' }>;
      if (rule.event === 'APPOINTMENT_BOOKED') rows = await tx.$queryRaw`
        SELECT a."leadId",a.id::text AS "referenceId",a.version AS "referenceVersion"
        FROM "LeadAppointment" a JOIN "Lead" l ON l.id=a."leadId"
        WHERE a.status='BOOKED' AND l."deletedAt" IS NULL AND l.status<>'archiviato'
          AND EXISTS(SELECT 1 FROM "AuditLog" j WHERE j."entityType"='Lead' AND j."entityId"=l.id
            AND j.event IN ('lead_appointment_booked','lead_appointment_rescheduled') AND (j."createdAt" AT TIME ZONE 'UTC')>=${rule.updatedAt}
            AND j."after"->>'appointmentId'=a.id::text AND j."after"->>'version'=a.version::text)
          AND NOT EXISTS(SELECT 1 FROM "WorkflowEnrollment" e WHERE e."automationId"=${rule.id}::uuid
            AND e."eventKey"='APPOINTMENT_BOOKED::'||a.id::text||':'||a.version::text)
        ORDER BY a."updatedAt",a.id LIMIT ${remaining}`;
      else if (rule.event === 'STATUS_CHANGED') rows = await tx.$queryRaw`
        SELECT s."recordId" AS "leadId",s.id::text AS "referenceId" FROM "RecordUpdateEvent" s JOIN "Lead" l ON l.id=s."recordId"
        WHERE s.kind='LEAD' AND s.event='STATE_CHANGED' AND s.changed @> '["status"]'::jsonb
          AND s."occurredAt">=${rule.updatedAt} AND l."deletedAt" IS NULL AND l.status<>'archiviato'
          AND s.scope=fai_record_update_scope('LEAD',l.id)
          AND NOT EXISTS(SELECT 1 FROM "RecordUpdateEvent" n WHERE n.kind='LEAD' AND n."recordId"=s."recordId" AND n.event='STATE_CHANGED'
            AND (n."occurredAt",n.id)>(s."occurredAt",s.id))
          AND NOT EXISTS(SELECT 1 FROM "WorkflowEnrollment" e WHERE e."automationId"=${rule.id}::uuid AND e."eventKey"='STATUS_CHANGED::'||s.id::text||':')
        ORDER BY s."occurredAt",s.id LIMIT ${remaining}`;
      else rows = await tx.$queryRaw`
        SELECT q.* FROM (
          SELECT i."leadId",a.id::text AS "referenceId",'COMMERCIAL_ACTIVITY' AS origin,a."createdAt" AS at
          FROM "CommercialLeadActivity" a JOIN "CommercialLeadInboxItem" i ON i.id=a."inboxItemId" JOIN "Lead" l ON l.id=i."leadId"
          WHERE a."activityType"='ASSIGNED' AND a."createdAt">=${rule.updatedAt} AND i.state='OPEN' AND l."deletedAt" IS NULL
            AND a."assigneeAfterId"=l."assignedToId"
            AND NOT EXISTS(SELECT 1 FROM "CommercialLeadActivity" n WHERE n."inboxItemId"=a."inboxItemId" AND n."activityType" IN ('ASSIGNED','UNASSIGNED','CLAIMED') AND n.sequence>a.sequence)
            AND NOT EXISTS(SELECT 1 FROM "WorkflowEnrollment" e WHERE e."automationId"=${rule.id}::uuid AND e."eventKey"='ASSIGNMENT_CONFIRMED:COMMERCIAL_ACTIVITY:'||a.id::text||':')
          UNION ALL
          SELECT j."entityId",j.id,'RESPONSIBILITY',j."createdAt" AT TIME ZONE 'UTC' FROM "AuditLog" j JOIN "Lead" l ON l.id=j."entityId"
          WHERE j."entityType"='Lead' AND j.event='responsibility_assigned' AND (j."createdAt" AT TIME ZONE 'UTC')>=${rule.updatedAt} AND l."deletedAt" IS NULL
            AND j."after"->>'allowed'='true' AND j."after"->'state'->>'commercialOwnerId'=l."assignedToId"
            AND NOT EXISTS(SELECT 1 FROM "CommercialLeadInboxItem" i WHERE i."leadId"=l.id)
            AND NOT EXISTS(SELECT 1 FROM "AuditLog" n WHERE n."entityType"='Lead' AND n."entityId"=j."entityId" AND n.event=j.event AND (n."createdAt",n.id)>(j."createdAt",j.id))
            AND NOT EXISTS(SELECT 1 FROM "WorkflowEnrollment" e WHERE e."automationId"=${rule.id}::uuid AND e."eventKey"='ASSIGNMENT_CONFIRMED:RESPONSIBILITY:'||j.id||':')
        ) q ORDER BY q.at,q."referenceId" LIMIT ${remaining}`;
      selected.push(...rows.map(row => ({ kind: rule.event as AutomaticSource['kind'], leadId: row.leadId,
        referenceId: row.referenceId, ...(row.referenceVersion ? { referenceVersion: row.referenceVersion } : {}), ...(row.origin ? { origin: row.origin } : {}) })));
    }
    return selected;
}
