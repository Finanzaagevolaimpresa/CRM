import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { AuthSession } from './auth';
import { canonicalSha256 } from './canonical-json';
import { updateActor } from './record-updates';
import { recordUpdatePermission, recordUpdateContext, currentRecordUpdateUser } from './record-update-context';
import { verifiedAcquisitionEvent } from './lead-acquisition-contract';
import { assertSyntheticCatalogDatabase, CatalogV2PreparationError } from './service-catalog-v2-persistence';
import { renderWorkflowTemplate, workflowRuleInput, type WorkflowTemplate } from './workflow-automation-contract';
import { readAdmittedOrdinaryEmailReceipts } from './ordinary-email-receipt-reader';
import { workflowSourceStillCurrent, workflowSourceChoices } from './workflow-event-source';

type Tx = Prisma.TransactionClient;
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
async function transaction<T>(db: PrismaClient, operation: (tx: Tx) => Promise<T>) {
  for (let attempt = 0; ; attempt++) {
    try { return await db.$transaction(operation, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 }); }
    catch (error) {
      const aborted = error instanceof Prisma.PrismaClientKnownRequestError && (error.code === 'P2034'
        || error.code === 'P2010' && ['40001', '40P01'].includes(String(error.meta?.code)));
      if (!aborted || attempt >= 2) throw error;
    }
  }
}
async function syntheticDatabase(db: PrismaClient) {
  if (process.env.APP_ENV !== 'test') throw new Error('WORKFLOW_SYNTHETIC_ONLY');
  await assertSyntheticCatalogDatabase(db);
}
async function actor(tx: Tx, session: AuthSession, admin = false) {
  const auth = await updateActor(tx, session);
  if ((admin && auth.actor.role !== 'admin') || !recordUpdatePermission(auth.actor, 'lead.read')) throw new Error('WORKFLOW_DENIED');
  return auth;
}
async function leadLock(tx: Tx, leadId: string) {
  await tx.$queryRaw`SELECT id FROM "Lead" WHERE id=${leadId} FOR UPDATE`;
}

function nativePlanningEnabled() {
  if (process.env.WORKFLOW_NATIVE_PREPARATION_MODE !== 'enabled') throw new Error('WORKFLOW_NATIVE_PREPARATION_DISABLED');
}

/** The planner is shared by test, the dormant post-projection hook and native
 * preparation. It records intent, never transport authorization. */
async function enrollWorkflowReceipt(db: PrismaClient, session: AuthSession, raw: unknown, synthetic: boolean) {
  const input = z.object({ automationId: z.string().uuid(), receiptId: z.string().uuid() }).strict().parse(raw);
  if (synthetic) await syntheticDatabase(db); else nativePlanningEnabled();
  return transaction(db, async tx => {
    const auth = await actor(tx, session, true);
    return enrollWorkflowReceiptInTransaction(tx, auth, input, synthetic);
  });
}

export async function enrollWorkflowReceiptInTransaction(tx: Tx,
  auth: { actor: NonNullable<Awaited<ReturnType<typeof currentRecordUpdateUser>>>; finish: () => Promise<Date> },
  input: { automationId: string; receiptId: string }, synthetic: boolean) {
    const receipt = await tx.secureLeadGatewayReceipt.findUnique({ where: { id: input.receiptId },
      include: { inboxEvent: { include: { leadProjectionLedger: true } } } });
    const inbox = receipt?.inboxEvent, projection = inbox?.leadProjectionLedger;
    const source = inbox ? verifiedAcquisitionEvent(inbox) : null;
    if (!receipt || !inbox || inbox.state !== 'PROCESSED' || !source || !projection?.leadId
      || !['PROJECTED_NEW', 'RESOLVED_NEW', 'RESOLVED_EXISTING'].includes(projection.state)
      || projection.sourceRecordHash !== inbox.recordHash) throw new Error('WORKFLOW_IDENTITY_NOT_RESOLVED');
    await leadLock(tx, projection.leadId);
    if (!(await recordUpdateContext(tx, 'LEAD', projection.leadId)).canRead(auth.actor)) throw new Error('WORKFLOW_DENIED');
    const lead = await tx.lead.findUnique({ where: { id: projection.leadId } });
    if (!lead || lead.deletedAt) throw new Error('WORKFLOW_RECIPIENT_REQUIRED');
    const stored = await tx.workflowAutomation.findUnique({ where: { id: input.automationId } });
    if (!stored || stored.state !== (synthetic ? 'TEST_READY' : 'ACTIVE') || stored.event !== 'LEAD_ACCEPTED') throw new Error('WORKFLOW_NOT_READY');
    const rule = workflowRuleInput.parse({ id: stored.id, name: stored.name, event: stored.event, state: stored.state,
      expectedVersion: stored.version, delayMinutes: stored.delayMinutes, configuration: stored.configuration });
    if (rule.configuration.kind !== 'INDIVIDUAL') throw new Error('WORKFLOW_EVENT_ADAPTER_UNAVAILABLE');
    const internal = rule.configuration.action === 'INTERNAL_NOTICE';
    const owner = internal && lead.assignedToId ? await currentRecordUpdateUser(tx, lead.assignedToId) : null;
    if (internal && (!owner || !(await recordUpdateContext(tx, 'LEAD', lead.id)).canRead(owner))) throw new Error('WORKFLOW_INTERNAL_RECIPIENT_REQUIRED');
    if (!internal && (!z.string().email().safeParse(lead.email).success
      || synthetic && !/@[^@]+\.(test|invalid)$/i.test(lead.email!))) throw new Error('WORKFLOW_RECIPIENT_REQUIRED');
    const eventKey = source.eventId;
    const existing = await tx.workflowEnrollment.findUnique({ where: { automationId_eventKey: { automationId: rule.id, eventKey } } });
    if (existing) {
      if (existing.leadId !== lead.id || existing.sourceHash !== inbox.recordHash || existing.synthetic !== synthetic) throw new Error('WORKFLOW_EVENT_CONFLICT');
      await auth.finish(); return { id: existing.id, replay: true };
    }
    const templates = await tx.workflowEmailTemplate.findMany({ where: { id: { in: [rule.configuration.confirmationTemplateId,
      ...(rule.configuration.followupTemplateId ? [rule.configuration.followupTemplateId] : [])] } } });
    const now = await auth.finish();
    const enrollment = await tx.workflowEnrollment.create({ data: { id: randomUUID(), automationId: rule.id, automationVersion: stored.version,
      eventKey, leadId: lead.id, sourceReceiptId: receipt.id, sourceHash: inbox.recordHash, synthetic,
      snapshot: json({ rule, recipient: lead.email ?? '', fields: { firstName: lead.firstName, companyName: lead.companyName ?? '' } }),
      createdById: auth.actor.id } });
    for (const step of ['CONFIRMATION', ...(rule.configuration.followupTemplateId ? ['FOLLOW_UP'] : [])]) {
      const templateId = step === 'CONFIRMATION' ? rule.configuration.confirmationTemplateId : rule.configuration.followupTemplateId;
      const template = templates.find(row => row.id === templateId);
      if (!template || template.state !== 'PUBLISHED' || !template.authorizationReference) throw new Error('WORKFLOW_TEMPLATE_NOT_APPROVED');
      const rendered = renderWorkflowTemplate(template as WorkflowTemplate, { firstName: lead.firstName, companyName: lead.companyName ?? '' });
      await tx.workflowExecution.create({ data: { id: randomUUID(), enrollmentId: enrollment.id, step,
        recipientUserId: internal ? owner!.id : null,
        state: rendered.ok ? 'PENDING' : 'ERROR', dueAt: new Date(now.getTime() + (step === 'FOLLOW_UP' ? rule.delayMinutes * 60_000 : 0)),
        requestKey: canonicalSha256({ automationId: rule.id, eventKey, step }),
        templateSnapshot: json({ templateId: template.id, templateVersion: template.version, rendered }),
        stopReason: rendered.ok ? null : 'MISSING_FIELDS:' + rendered.missing.join(','),
        history: json([{ event: 'ENROLLED', at: now.toISOString(), sourceReceiptId: receipt.id }]) } });
    }
    await tx.auditLog.create({ data: { actorId: auth.actor.id, entityType: 'WorkflowEnrollment', entityId: enrollment.id,
      event: synthetic ? 'workflow_synthetic_enrolled' : 'workflow_native_planned', after: { automationId: rule.id, sourceReceiptId: receipt.id, leadId: lead.id, synthetic } } });
    await auth.finish(); return { id: enrollment.id, replay: false };
}

/** Explicit test command; the wrapper and the transport both verify the
 * ephemeral database. Caller-provided recipient addresses are never accepted. */
export function enrollSyntheticWorkflowReceipt(db: PrismaClient, session: AuthSession, raw: unknown) {
  return enrollWorkflowReceipt(db, session, raw, true);
}

/** Disabled unless a later mandate enables WORKFLOW_NATIVE_PREPARATION_MODE.
 * This only plans steps; the native email approval and send path stays separate. */
export function planNativeWorkflowReceipt(db: PrismaClient, session: AuthSession, raw: unknown) {
  return enrollWorkflowReceipt(db, session, raw, false);
}

/** Prepare the exact approved template in the existing email system. A native
 * draft is never a send receipt. Approval, provider admission and actual sending
 * retain all native controls; this function does not invoke them. */
export async function prepareNativeWorkflowEnrollment(db: PrismaClient, session: AuthSession, raw: unknown) {
  nativePlanningEnabled();
  const input = z.object({ enrollmentId: z.string().uuid(), mailboxId: z.string().uuid().optional(), replyTo: z.string().email().optional() }).strict().parse(raw);
  return transaction(db, async tx => {
    const auth = await actor(tx, session, true);
    const initial = await tx.workflowEnrollment.findUnique({ where: { id: input.enrollmentId } });
    if (!initial || initial.synthetic) throw new Error('WORKFLOW_NATIVE_REQUIRED');
    await leadLock(tx, initial.leadId);
    if (!(await recordUpdateContext(tx, 'LEAD', initial.leadId)).canRead(auth.actor)) throw new Error('WORKFLOW_DENIED');
    await tx.$queryRaw`SELECT id FROM "WorkflowEnrollment" WHERE id=${initial.id}::uuid FOR UPDATE`;
    const enrollment = await tx.workflowEnrollment.findUniqueOrThrow({ where: { id: initial.id } });
    if (enrollment.state !== 'PENDING') { await auth.finish(); return { prepared: 0 }; }
    if (!await ensureWorkflowSourceCurrent(tx, enrollment)) { await auth.finish(); return { prepared: 0 }; }
    const currentRule = await tx.workflowAutomation.findUnique({ where: { id: enrollment.automationId } });
    if (currentRule?.state !== 'ACTIVE') throw new Error('WORKFLOW_RULE_PAUSED');
    const lead = await tx.lead.findUniqueOrThrow({ where: { id: enrollment.leadId } });
    const snapshot = z.object({ recipient: z.string(), fields: z.object({ firstName: z.string(), companyName: z.string() }) }).passthrough().parse(enrollment.snapshot);
    if (snapshot.recipient !== (lead.email ?? '') || snapshot.fields.firstName !== lead.firstName || snapshot.fields.companyName !== (lead.companyName ?? ''))
      throw new Error('WORKFLOW_RECIPIENT_CHANGED');
    const now = await auth.finish();
    const pending = await tx.workflowExecution.findMany({ where: { enrollmentId: enrollment.id, state: 'PENDING', dueAt: { lte: now } }, orderBy: { dueAt: 'asc' } });
    const { saveApprovedMessageDraftInTransaction } = await import('./approved-communications');
    let prepared = 0;
    for (const execution of pending) {
      if (execution.step !== 'CONFIRMATION') {
        const confirmation = await tx.workflowExecution.findUnique({ where: { enrollmentId_step: { enrollmentId: enrollment.id, step: 'CONFIRMATION' } } });
        // A prepared email and an uncertain attempt cannot authorize a reminder.
        if (confirmation?.state !== 'SENT') continue;
        const [appointment, reply] = execution.step === 'FOLLOW_UP' ? await Promise.all([
          tx.leadAppointment.findFirst({ where: { leadId: lead.id, status: 'BOOKED' }, select: { id: true } }),
          tx.communicationReply.findFirst({ where: { message: { leadId: lead.id }, receivedAt: { gte: enrollment.createdAt } }, select: { id: true } }),
        ]) : [null, null];
        if (appointment || reply) { await stopPendingWorkflowExecutions(tx, { leadId: lead.id,
          reason: appointment ? 'APPOINTMENT_BOOKED' : 'REPLIED', evidenceId: (appointment ?? reply)!.id }); break; }
      }
      const template = z.object({ rendered: z.object({ ok: z.literal(true), subject: z.string(), body: z.string(), hash: z.string() }) }).passthrough().parse(execution.templateSnapshot);
      if (execution.recipientUserId) {
        const receipt = { channel: 'CRM_INTERNAL_NOTICE', synthetic: false, recipientUserId: execution.recipientUserId,
          id: execution.requestKey, title: template.rendered.subject, body: template.rendered.body, at: now.toISOString(), delivered: true };
        await tx.workflowExecution.update({ where: { id: execution.id, state: 'PENDING' }, data: { state: 'SENT', attemptCount: execution.attemptCount + 1,
          receipt, history: history(execution.history, { event: 'INTERNAL_NOTICE_RECORDED', receipt, at: now.toISOString() }) } });
        prepared++; continue;
      }
      if (!input.mailboxId || !input.replyTo) throw new Error('WORKFLOW_MAILBOX_REQUIRED');
      const message = await saveApprovedMessageDraftInTransaction(tx, session, { messageId: execution.id, expectedRevision: 0,
        context: { kind: 'LEAD', id: lead.id }, mailboxId: input.mailboxId, replyTo: input.replyTo,
        to: [snapshot.recipient], cc: [], bcc: [], subject: template.rendered.subject, body: template.rendered.body,
        attachmentVersionIds: [], classification: 'ORDINARY' });
      await tx.workflowExecution.update({ where: { id: execution.id, state: 'PENDING' }, data: { state: 'PREPARED',
        receipt: { channel: 'NATIVE_EMAIL_DRAFT', synthetic: false, messageId: message.id, revision: message.revision,
          snapshotHash: message.snapshotHash, sent: false },
        history: history(execution.history, { event: 'NATIVE_DRAFT_PREPARED', messageId: message.id, at: now.toISOString() }) } });
      prepared++;
    }
    if (!await tx.workflowExecution.count({ where: { enrollmentId: enrollment.id, state: { in: ['PENDING', 'PREPARED', 'UNCERTAIN', 'ERROR'] } } }))
      await tx.workflowEnrollment.update({ where: { id: enrollment.id }, data: { state: 'COMPLETED' } });
    await auth.finish(); return { prepared };
  });
}

/** Reconciliation reads native send evidence for the exact revision;
 * it does not accept an operator-supplied SENT flag or retry a transport. */
export async function reconcileNativeWorkflowExecution(db: PrismaClient, session: AuthSession, executionId: string) {
  nativePlanningEnabled(); z.string().uuid().parse(executionId);
  return transaction(db, async tx => {
    const auth = await actor(tx, session, true), execution = await tx.workflowExecution.findUniqueOrThrow({ where: { id: executionId } });
    if (!recordUpdatePermission(auth.actor, 'practice_communications.read')) throw new Error('WORKFLOW_DENIED');
    const enrollment = await tx.workflowEnrollment.findUniqueOrThrow({ where: { id: execution.enrollmentId } });
    if (enrollment.synthetic) throw new Error('WORKFLOW_NATIVE_REQUIRED');
    await leadLock(tx, enrollment.leadId);
    if (!(await recordUpdateContext(tx, 'LEAD', enrollment.leadId)).canRead(auth.actor)) throw new Error('WORKFLOW_DENIED');
    await tx.$queryRaw`SELECT id FROM "WorkflowEnrollment" WHERE id=${enrollment.id}::uuid FOR UPDATE`;
    const current = await tx.workflowExecution.findUniqueOrThrow({ where: { id: executionId } });
    const receipt = z.object({ channel: z.literal('NATIVE_EMAIL_DRAFT'), synthetic: z.literal(false), messageId: z.string().uuid(),
      revision: z.number().int().positive(), snapshotHash: z.string() }).passthrough().parse(current.receipt);
    const version = await tx.communicationVersion.findUnique({ where: { messageId_revision: { messageId: receipt.messageId, revision: receipt.revision } },
      include: { message: true } });
    if (!version || version.snapshotHash !== receipt.snapshotHash || version.message.leadId !== enrollment.leadId
      || version.message.currentRevision !== receipt.revision) throw new Error('WORKFLOW_NATIVE_BINDING_CHANGED');
    const [attempt, ordinaryReceipts] = await Promise.all([
      tx.communicationAttempt.findFirst({ where: { versionId: version.id }, orderBy: { createdAt: 'desc' } }),
      readAdmittedOrdinaryEmailReceipts(tx, receipt.messageId),
    ]);
    const ordinary = ordinaryReceipts.find(row => row.revision === receipt.revision && row.snapshotHash === receipt.snapshotHash);
    let state: 'SENT' | 'UNCERTAIN' | 'ERROR' | null = null;
    let evidence: Record<string, unknown> | null = null;
    if (ordinary && (!attempt || ordinary.createdAt > attempt.createdAt)) {
      state = ordinary.outcome === 'ACCEPTED' && version.message.state === 'SENT' ? 'SENT'
        : ordinary.outcome === 'UNCERTAIN' ? 'UNCERTAIN' : ordinary.outcome === 'NOT_SENT' ? 'ERROR' : null;
      evidence = { channel: 'NATIVE_SMTP', attemptId: ordinary.id, receiptHash: canonicalSha256(json(ordinary)) };
    } else if (attempt?.evidence && attempt.evidenceHash === canonicalSha256(attempt.evidence)) {
      const outcome = z.object({ outcome: z.string() }).passthrough().parse(attempt.evidence).outcome;
      state = attempt.state === 'SENT' && outcome === 'SENT' ? 'SENT'
        : attempt.state === 'UNCERTAIN' ? 'UNCERTAIN' : attempt.state === 'FAILED' ? 'ERROR' : null;
      evidence = { channel: 'NATIVE_MANUAL', attemptId: attempt.id, evidenceHash: attempt.evidenceHash };
    }
    if (!state || current.state === state) { await auth.finish(); return { state: current.state, reconciled: Boolean(state) }; }
    if (current.state === 'SENT') throw new Error('WORKFLOW_NATIVE_RECONCILIATION_CONFLICT');
    const now = await auth.finish();
    await tx.workflowExecution.update({ where: { id: current.id }, data: { state, attemptCount: Math.max(current.attemptCount, 1),
      history: history(current.history, { event: 'NATIVE_' + state, ...evidence,
        at: now.toISOString(), delivered: false }) } });
    if (enrollment.state === 'PENDING' && !await tx.workflowExecution.count({ where: { enrollmentId: enrollment.id, state: { in: ['PENDING', 'PREPARED', 'UNCERTAIN', 'ERROR'] } } }))
      await tx.workflowEnrollment.update({ where: { id: enrollment.id }, data: { state: 'COMPLETED' } });
    await auth.finish(); return { state, reconciled: true };
  });
}

function history(value: Prisma.JsonValue, entry: object) {
  if (!Array.isArray(value)) throw new Error('WORKFLOW_HISTORY_INVALID');
  return json([...value, entry]);
}

type SourceEnrollment = { id: string; leadId: string; sourceReceiptId: string | null; sourceHash: string; snapshot: Prisma.JsonValue };
async function workflowEnrollmentSourceCurrent(tx: Tx, enrollment: SourceEnrollment) {
  if (!enrollment.sourceReceiptId) return workflowSourceStillCurrent(tx, enrollment.snapshot, enrollment.sourceHash);
  const receipt = await tx.secureLeadGatewayReceipt.findUnique({ where: { id: enrollment.sourceReceiptId }, include: { inboxEvent: { include: { leadProjectionLedger: true } } } });
  const inbox = receipt?.inboxEvent, projection = inbox?.leadProjectionLedger;
  return Boolean(inbox?.state === 'PROCESSED' && inbox.recordHash === enrollment.sourceHash && projection?.leadId === enrollment.leadId
    && projection.sourceRecordHash === inbox.recordHash && ['PROJECTED_NEW', 'RESOLVED_NEW', 'RESOLVED_EXISTING'].includes(projection.state));
}
async function ensureWorkflowSourceCurrent(tx: Tx, enrollment: SourceEnrollment) {
  let valid = await workflowEnrollmentSourceCurrent(tx, enrollment);
  const internal = await tx.workflowExecution.findFirst({ where: { enrollmentId: enrollment.id, recipientUserId: { not: null } }, select: { recipientUserId: true } });
  if (internal?.recipientUserId) {
    const lead = await tx.lead.findUniqueOrThrow({ where: { id: enrollment.leadId } });
    const recipient = await currentRecordUpdateUser(tx, internal.recipientUserId);
    valid = valid && lead.assignedToId === internal.recipientUserId && Boolean(recipient && (await recordUpdateContext(tx, 'LEAD', lead.id)).canRead(recipient));
  }
  if (valid) return true;
  const pending = await tx.workflowExecution.findMany({ where: { enrollmentId: enrollment.id, state: { in: ['PENDING', 'PREPARED'] } } });
  for (const execution of pending) await tx.workflowExecution.update({ where: { id: execution.id }, data: { state: 'STOPPED', stopReason: 'SOURCE_CHANGED',
    history: history(execution.history, { event: 'STOPPED', reason: 'SOURCE_CHANGED', at: new Date().toISOString() }) } });
  await tx.workflowEnrollment.update({ where: { id: enrollment.id }, data: { state: 'STOPPED' } });
  return false;
}

async function workflowTablesPresent(tx: Tx) {
  const [tables] = await tx.$queryRaw<Array<{ count: number }>>`SELECT count(*)::integer AS count FROM
    (VALUES (to_regclass(format('%I.%I',current_schema(),'WorkflowEnrollment'))),
      (to_regclass(format('%I.%I',current_schema(),'WorkflowExecution')))) AS relations(value) WHERE value IS NOT NULL`;
  if (tables.count !== 0 && tables.count !== 2) throw new Error('WORKFLOW_PERSISTENCE_INCOMPLETE');
  return tables.count === 2;
}

/** Native mail calls this before a new write/approval/send admission. Historical
 * messages remain readable and an already-started attempt may still record its
 * evidence. A prepared workflow draft is bound to its exact immutable version. */
export async function assertWorkflowMessageAction(tx: Tx, input: {
  messageId: string; revision: number; snapshotHash: string; edit?: boolean;
}) {
  if (!await workflowTablesPresent(tx)) return;
  const first = await tx.workflowExecution.findUnique({ where: { id: input.messageId }, include: { enrollment: true } });
  if (!first) return;
  nativePlanningEnabled();
  await leadLock(tx, first.enrollment.leadId);
  await tx.$queryRaw`SELECT id FROM "WorkflowEnrollment" WHERE id=${first.enrollmentId}::uuid FOR UPDATE`;
  const execution = await tx.workflowExecution.findUniqueOrThrow({ where: { id: input.messageId }, include: { enrollment: true } });
  if (!await workflowEnrollmentSourceCurrent(tx, execution.enrollment)) throw new Error('WORKFLOW_SOURCE_CHANGED');
  const lead = await tx.lead.findUniqueOrThrow({ where: { id: execution.enrollment.leadId } });
  const source = z.object({ recipient: z.string().email(), fields: z.object({ firstName: z.string(), companyName: z.string() }) })
    .passthrough().parse(execution.enrollment.snapshot);
  if (lead.deletedAt || source.recipient !== lead.email || source.fields.firstName !== lead.firstName || source.fields.companyName !== (lead.companyName ?? ''))
    throw new Error('WORKFLOW_RECIPIENT_CHANGED');
  await tx.$queryRaw`SELECT id FROM "WorkflowAutomation" WHERE id=${execution.enrollment.automationId}::uuid FOR SHARE`;
  const rule = await tx.workflowAutomation.findUniqueOrThrow({ where: { id: execution.enrollment.automationId } });
  const receipt = z.object({ channel: z.literal('NATIVE_EMAIL_DRAFT'), synthetic: z.literal(false), messageId: z.string().uuid(),
    revision: z.number().int().positive(), snapshotHash: z.string() }).passthrough().safeParse(execution.receipt);
  if (input.edit || execution.enrollment.synthetic || execution.enrollment.state !== 'PENDING' || execution.state !== 'PREPARED'
    || rule.state !== 'ACTIVE' || !receipt.success || receipt.data.messageId !== input.messageId
    || receipt.data.revision !== input.revision || receipt.data.snapshotHash !== input.snapshotHash)
    throw new Error('WORKFLOW_MESSAGE_NO_LONGER_ADMISSIBLE');
  if (execution.step === 'FOLLOW_UP') {
    const [appointment, reply] = await Promise.all([
      tx.leadAppointment.findFirst({ where: { leadId: execution.enrollment.leadId, status: 'BOOKED' }, select: { id: true } }),
      tx.communicationReply.findFirst({ where: { message: { leadId: execution.enrollment.leadId }, receivedAt: { gte: execution.enrollment.createdAt } }, select: { id: true } }),
    ]);
    if (appointment || reply) throw new Error('WORKFLOW_MESSAGE_NO_LONGER_ADMISSIBLE');
  }
}

/** Call only within a native, authorized lead/reply/appointment transaction.
 * The lead lock serializes a stop with any synthetic execution claim. */
export async function stopPendingWorkflowExecutions(tx: Tx, input: {
  leadId: string; reason: 'REPLIED' | 'APPOINTMENT_BOOKED'; evidenceId: string;
}) {
  if (!input.leadId || !input.evidenceId || !['REPLIED', 'APPOINTMENT_BOOKED'].includes(input.reason)) throw new Error('WORKFLOW_STOP_EVIDENCE_REQUIRED');
  // Historical-schema qualification has no workflow state to stop. A partial
  // migration is an error, never an excuse to ignore existing pending work.
  if (!await workflowTablesPresent(tx)) return { stopped: 0 };
  await leadLock(tx, input.leadId);
  const enrollments = await tx.workflowEnrollment.findMany({ where: { leadId: input.leadId, state: 'PENDING' } });
  const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
  let stopped = 0;
  for (const enrollment of enrollments) {
    await tx.$queryRaw`SELECT id FROM "WorkflowEnrollment" WHERE id=${enrollment.id}::uuid FOR UPDATE`;
    if (!await tx.workflowExecution.count({ where: { enrollmentId: enrollment.id, step: 'FOLLOW_UP', state: { not: 'SENT' } } })) continue;
    const pending = await tx.workflowExecution.findMany({ where: { enrollmentId: enrollment.id, step: 'FOLLOW_UP', state: { in: ['PENDING', 'PREPARED'] } } });
    for (const execution of pending) {
      await tx.workflowExecution.update({ where: { id: execution.id, state: execution.state }, data: { state: 'STOPPED', stopReason: input.reason,
        history: history(execution.history, { event: 'STOPPED', reason: input.reason, evidenceId: input.evidenceId, at: clock.now.toISOString() }) } });
      stopped++;
    }
    await tx.workflowEnrollment.update({ where: { id: enrollment.id }, data: { state: 'STOPPED' } });
  }
  return { stopped };
}

/** Persistent synthetic outbox: no transport injection and no real sender.
 * A duplicate/concurrent command cannot produce a second acceptance receipt. */
export async function runSyntheticWorkflowEnrollment(db: PrismaClient, session: AuthSession, raw: unknown) {
  const input = z.object({ enrollmentId: z.string().uuid(), now: z.string().datetime({ offset: true }),
    outcome: z.enum(['SENT', 'ERROR', 'UNCERTAIN']).default('SENT') }).strict().parse(raw);
  await syntheticDatabase(db);
  return transaction(db, async tx => {
    const auth = await actor(tx, session, true);
    const initial = await tx.workflowEnrollment.findUnique({ where: { id: input.enrollmentId } });
    if (!initial?.synthetic) throw new Error('WORKFLOW_SYNTHETIC_ONLY');
    await leadLock(tx, initial.leadId);
    if (!(await recordUpdateContext(tx, 'LEAD', initial.leadId)).canRead(auth.actor)) throw new Error('WORKFLOW_DENIED');
    await tx.$queryRaw`SELECT id FROM "WorkflowEnrollment" WHERE id=${initial.id}::uuid FOR UPDATE`;
    const enrollment = await tx.workflowEnrollment.findUniqueOrThrow({ where: { id: initial.id } });
    if (enrollment.state !== 'PENDING') { await auth.finish(); return { executed: 0 }; }
    if (!await ensureWorkflowSourceCurrent(tx, enrollment)) { await auth.finish(); return { executed: 0 }; }
    const currentRule = await tx.workflowAutomation.findUnique({ where: { id: enrollment.automationId } });
    if (currentRule?.state !== 'TEST_READY') throw new Error('WORKFLOW_RULE_PAUSED');
    const lead = await tx.lead.findUnique({ where: { id: enrollment.leadId } });
    if (!lead || lead.deletedAt) throw new Error('WORKFLOW_SYNTHETIC_RECIPIENT_REQUIRED');
    const snapshot = z.object({ recipient: z.string(), fields: z.object({ firstName: z.string(), companyName: z.string() }) }).passthrough().parse(enrollment.snapshot);
    if (snapshot.recipient !== (lead.email ?? '') || snapshot.fields.firstName !== lead.firstName || snapshot.fields.companyName !== (lead.companyName ?? ''))
      throw new Error('WORKFLOW_RECIPIENT_CHANGED');
    const pending = await tx.workflowExecution.findMany({ where: { enrollmentId: enrollment.id, state: 'PENDING', dueAt: { lte: new Date(input.now) } }, orderBy: { dueAt: 'asc' } });
    let executed = 0;
    for (const execution of pending) {
      if (execution.step !== 'CONFIRMATION') {
        const prior = await tx.workflowExecution.findUnique({ where: { enrollmentId_step: { enrollmentId: enrollment.id, step: 'CONFIRMATION' } } });
        if (prior?.state !== 'SENT') continue;
      }
      const attempt = execution.attemptCount + 1;
      if (!execution.recipientUserId && (!lead.email || !/@[^@]+\.(test|invalid)$/i.test(lead.email))) throw new Error('WORKFLOW_SYNTHETIC_RECIPIENT_REQUIRED');
      const rendered = z.object({ rendered: z.object({ ok: z.literal(true), subject: z.string(), body: z.string() }).passthrough() }).passthrough().parse(execution.templateSnapshot).rendered;
      const receipt = { synthetic: true, channel: execution.recipientUserId ? 'CRM_INTERNAL_NOTICE' : 'DATABASE_TEST_OUTBOX', id: canonicalSha256({ requestKey: execution.requestKey, attempt }),
        ...(execution.recipientUserId ? { recipientUserId: execution.recipientUserId, title: rendered.subject, body: rendered.body } : {}),
        outcome: input.outcome, at: input.now, delivered: false, sender: 'no-reply@example.test', recipient: lead.email };
      await tx.workflowExecution.update({ where: { id: execution.id, state: 'PENDING' }, data: { state: input.outcome, attemptCount: attempt,
        receipt, stopReason: input.outcome === 'UNCERTAIN' ? 'RECONCILE_BEFORE_RETRY' : input.outcome === 'ERROR' ? 'TEST_CHANNEL_REJECTED' : null,
        history: history(execution.history, { event: input.outcome, receiptId: receipt.id, receipt, at: input.now }) } });
      executed++;
    }
    if (!await tx.workflowExecution.count({ where: { enrollmentId: enrollment.id, state: { in: ['PENDING', 'UNCERTAIN', 'ERROR'] } } }))
      await tx.workflowEnrollment.update({ where: { id: enrollment.id }, data: { state: 'COMPLETED' } });
    await auth.finish(); return { executed };
  });
}

export async function reconcileSyntheticWorkflowExecution(db: PrismaClient, session: AuthSession, raw: unknown) {
  const input = z.object({ executionId: z.string().uuid(), outcome: z.enum(['SENT', 'NOT_SENT']), evidence: z.string().trim().min(3).max(200) }).strict().parse(raw);
  await syntheticDatabase(db);
  return transaction(db, async tx => {
    const auth = await actor(tx, session, true), execution = await tx.workflowExecution.findUnique({ where: { id: input.executionId } });
    if (!execution) throw new Error('WORKFLOW_UNAVAILABLE');
    const enrollment = await tx.workflowEnrollment.findUnique({ where: { id: execution.enrollmentId } });
    if (!enrollment?.synthetic) throw new Error('WORKFLOW_SYNTHETIC_ONLY');
    await leadLock(tx, enrollment.leadId);
    if (!(await recordUpdateContext(tx, 'LEAD', enrollment.leadId)).canRead(auth.actor)) throw new Error('WORKFLOW_DENIED');
    await tx.$queryRaw`SELECT id FROM "WorkflowEnrollment" WHERE id=${enrollment.id}::uuid FOR UPDATE`;
    const current = await tx.workflowExecution.findUniqueOrThrow({ where: { id: input.executionId } });
    if (current.state !== 'UNCERTAIN') {
      const previous = Array.isArray(current.history) && current.history.some(item => typeof item === 'object' && item !== null && !Array.isArray(item)
        && item.event === 'RECONCILED_' + input.outcome && item.evidence === input.evidence);
      if (!previous) throw new Error('WORKFLOW_RECONCILIATION_INVALID');
      await auth.finish(); return { state: current.state };
    }
    const freshEnrollment = await tx.workflowEnrollment.findUniqueOrThrow({ where: { id: enrollment.id } });
    const state = input.outcome === 'SENT' ? 'SENT' : freshEnrollment.state === 'STOPPED' ? 'STOPPED' : 'PENDING';
    const now = await auth.finish();
    await tx.workflowExecution.update({ where: { id: current.id, state: 'UNCERTAIN' }, data: { state,
      stopReason: state === 'STOPPED' ? 'STOPPED_DURING_RECONCILIATION' : null,
      history: history(current.history, { event: 'RECONCILED_' + input.outcome, evidence: input.evidence, at: now.toISOString() }) } });
    await auth.finish(); return { state };
  });
}

export async function readLeadWorkflowExecutions(db: PrismaClient, session: AuthSession, leadId: string) {
  return db.$transaction(async tx => {
    const auth = await actor(tx, session);
    const context = await recordUpdateContext(tx, 'LEAD', leadId);
    if (!context.canRead(auth.actor)) throw new Error('WORKFLOW_DENIED');
    const enrollments = await tx.workflowEnrollment.findMany({ where: { leadId }, orderBy: { createdAt: 'desc' }, take: 100 });
    const executions = await tx.workflowExecution.findMany({ where: { enrollmentId: { in: enrollments.map(row => row.id) } }, orderBy: { dueAt: 'asc' } });
    await auth.finish();
    return enrollments.map(row => ({ id: row.id, state: row.state, synthetic: row.synthetic,
      executions: executions.filter(execution => execution.enrollmentId === row.id).map(execution => {
        const canReadReceipt = !execution.recipientUserId || auth.actor.role === 'admin' || execution.recipientUserId === auth.actor.id;
        const notice = canReadReceipt
          ? z.object({ channel: z.literal('CRM_INTERNAL_NOTICE'), title: z.string(), body: z.string() }).passthrough().safeParse(execution.receipt) : null;
        const { id, step, state, dueAt, stopReason, attemptCount } = execution;
        return { id, step, state, dueAt, stopReason, attemptCount, events: canReadReceipt ? execution.history : [],
          internal: Boolean(execution.recipientUserId), notice: notice?.success ? notice.data : null };
      }) }));
  }, { timeout: 30_000 });
}

export async function readSyntheticWorkflowLeadSetup(db: PrismaClient, session: AuthSession, leadId: string) {
  if (process.env.APP_ENV !== 'test' || session.role !== 'admin') return null;
  try { await syntheticDatabase(db); }
  catch (error) {
    // An APP_ENV=test application can serve ordinary pages without opting into
    // local synthetic commands. Hide only this optional form; command guards
    // and failures of an explicitly qualified database remain authoritative.
    if (error instanceof CatalogV2PreparationError && error.message === 'SERVICE_CATALOG_SYNTHETIC_CONFIGURATION_DENIED') return null;
    throw error;
  }
  return db.$transaction(async tx => {
    const auth = await actor(tx, session, true), context = await recordUpdateContext(tx, 'LEAD', leadId);
    if (!context.canRead(auth.actor)) throw new Error('WORKFLOW_DENIED');
    const [rules, receipts, eventRules, sources] = await Promise.all([
      tx.workflowAutomation.findMany({ where: { event: 'LEAD_ACCEPTED', state: 'TEST_READY' }, select: { id: true, name: true, version: true }, orderBy: { name: 'asc' } }),
      tx.secureLeadGatewayReceipt.findMany({ where: { inboxEvent: { leadProjectionLedger: { is: { leadId } } } },
        select: { id: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 30 }),
      tx.workflowAutomation.findMany({ where: { event: { notIn: ['LEAD_ACCEPTED', 'NEWSLETTER'] }, state: 'TEST_READY' }, select: { id: true, name: true, version: true, event: true }, orderBy: { name: 'asc' } }),
      workflowSourceChoices(tx, leadId),
    ]);
    await auth.finish(); return { rules, receipts, eventRules, sources, leadVersion: context.version.toISOString() };
  });
}

/** Current source choices for an explicit native command. Reading the form does
 * not enroll a lead; its action validates the same rule/source versions again. */
export async function readNativeWorkflowLeadSetup(db: PrismaClient, session: AuthSession, leadId: string) {
  if (process.env.WORKFLOW_NATIVE_PREPARATION_MODE !== 'enabled' || session.role !== 'admin') return null;
  return db.$transaction(async tx => {
    const auth = await actor(tx, session, true), context = await recordUpdateContext(tx, 'LEAD', leadId);
    if (!context.canRead(auth.actor) || !recordUpdatePermission(auth.actor, 'practice_communications.write')) throw new Error('WORKFLOW_DENIED');
    const [eventRules, sources] = await Promise.all([
      tx.workflowAutomation.findMany({ where: { event: { notIn: ['LEAD_ACCEPTED', 'NEWSLETTER'] }, state: 'ACTIVE' },
        select: { id: true, name: true, version: true, event: true }, orderBy: { name: 'asc' } }),
      workflowSourceChoices(tx, leadId),
    ]);
    await auth.finish(); return { eventRules, sources, leadVersion: context.version.toISOString() };
  });
}
