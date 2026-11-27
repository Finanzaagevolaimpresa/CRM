import { Prisma, type PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AuthSession } from './auth';
import { updateActor } from './record-updates';
import { recordUpdatePermission } from './record-update-context';
import { canonicalSha256 } from './canonical-json';
import { assertSyntheticCatalogDatabase } from './service-catalog-v2-persistence';
import { renderWorkflowTemplate, workflowRuleInput, type WorkflowTemplate } from './workflow-automation-contract';
import { resolveWorkflowSource, workflowSourceInput } from './workflow-event-source';
import { validateTemplatePurpose } from './workflow-automations';

const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value));
const inputSchema = z.object({ automationId: z.string().uuid(), expectedLeadVersion: z.string().datetime({ offset: true }), source: workflowSourceInput }).strict();

/** An explicit command binds a persisted rule to a verified native event. The
 * same planner produces test and native intent; no worker or ingestion hook is
 * enabled by importing it. Document requests are immutable operator commands. */
export async function planWorkflowOperationalEvent(db: PrismaClient, session: AuthSession, raw: unknown, synthetic = false) {
  const input = inputSchema.parse(raw);
  if (synthetic) {
    if (process.env.APP_ENV !== 'test') throw new Error('WORKFLOW_SYNTHETIC_ONLY');
    await assertSyntheticCatalogDatabase(db);
  } else if (process.env.WORKFLOW_NATIVE_PREPARATION_MODE !== 'enabled') throw new Error('WORKFLOW_NATIVE_PREPARATION_DISABLED');
  for (let attempt = 0; ; attempt++) {
    try { return await db.$transaction(async tx => {
      const auth = await updateActor(tx, session);
      return planWorkflowOperationalEventInTransaction(tx, auth, input, synthetic);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 }); }
    catch (error) {
      const aborted = error instanceof Prisma.PrismaClientKnownRequestError && (error.code === 'P2034'
        || error.code === 'P2010' && ['40001', '40P01'].includes(String(error.meta?.code)));
      if (!aborted || attempt >= 2) throw error;
    }
  }
}


/** Shared intent-only planner. Its caller supplies current authority, never a fabricated session. */
export async function planWorkflowOperationalEventInTransaction(tx: Prisma.TransactionClient,
  auth: { actor: NonNullable<Awaited<ReturnType<typeof import('./record-update-context').currentRecordUpdateUser>>>; finish: () => Promise<Date> },
  raw: unknown, synthetic = false) {
  const input = inputSchema.parse(raw);
  if (!synthetic && process.env.WORKFLOW_NATIVE_PREPARATION_MODE !== 'enabled') throw new Error('WORKFLOW_NATIVE_PREPARATION_DISABLED');
  if (auth.actor.role !== 'admin' || !recordUpdatePermission(auth.actor, 'practice_communications.write')) throw new Error('WORKFLOW_DENIED');
  const resolved = await resolveWorkflowSource(tx, input.source), { lead, source, context } = resolved;
  if (!context.canRead(auth.actor)) throw new Error('WORKFLOW_DENIED');
  if (lead.updatedAt.toISOString() !== input.expectedLeadVersion) throw new Error('WORKFLOW_STALE');
  const stored = await tx.workflowAutomation.findUniqueOrThrow({ where: { id: input.automationId } });
  const rule = workflowRuleInput.parse({ id: stored.id, name: stored.name, event: stored.event, state: stored.state,
    expectedVersion: stored.version, delayMinutes: stored.delayMinutes, configuration: stored.configuration });
  if (rule.event !== input.source.kind || rule.configuration.kind !== 'INDIVIDUAL' || rule.state !== (synthetic ? 'TEST_READY' : 'ACTIVE'))
    throw new Error('WORKFLOW_NOT_READY');
  const internal = rule.configuration.action === 'INTERNAL_NOTICE';
  if (internal && !resolved.owner) throw new Error('WORKFLOW_INTERNAL_RECIPIENT_REQUIRED');
  if (!internal && (!z.string().email().safeParse(lead.email).success
    || synthetic && !/@[^@]+\.(test|invalid)$/i.test(lead.email!))) throw new Error('WORKFLOW_RECIPIENT_REQUIRED');
  const eventKey = [input.source.kind, input.source.origin ?? '', input.source.referenceId, input.source.referenceVersion ?? ''].join(':');
  const previous = await tx.workflowEnrollment.findUnique({ where: { automationId_eventKey: { automationId: rule.id, eventKey } } });
  if (previous) {
    if (previous.sourceHash !== source.hash || previous.leadId !== lead.id || previous.synthetic !== synthetic) throw new Error('WORKFLOW_EVENT_CONFLICT');
    await auth.finish(); return { id: previous.id, replay: true };
  }
  const now = await auth.finish();
  const enrollment = await tx.workflowEnrollment.create({ data: { id: randomUUID(), automationId: rule.id, automationVersion: stored.version,
    eventKey, leadId: lead.id, sourceReceiptId: null, sourceHash: source.hash, synthetic,
    snapshot: json({ rule, source, recipient: lead.email ?? '', fields: { firstName: lead.firstName, companyName: lead.companyName ?? '' } }), createdById: auth.actor.id } });
  const templates = await tx.workflowEmailTemplate.findMany({ where: { id: { in: [rule.configuration.confirmationTemplateId,
    ...(rule.configuration.followupTemplateId ? [rule.configuration.followupTemplateId] : [])] } } });
  validateTemplatePurpose(rule, templates as WorkflowTemplate[]);
  const steps = [{ step: 'CONFIRMATION', id: rule.configuration.confirmationTemplateId, due: now },
    ...(rule.configuration.followupTemplateId ? [{ step: input.source.kind === 'APPOINTMENT_BOOKED' ? 'REMINDER' : 'FOLLOW_UP',
      id: rule.configuration.followupTemplateId, due: resolved.reminderBefore
        ? new Date(Math.max(now.getTime(), resolved.reminderBefore.getTime() - rule.delayMinutes * 60_000))
        : new Date(now.getTime() + rule.delayMinutes * 60_000) }] : [])];
  for (const step of steps) {
    const template = templates.find(row => row.id === step.id);
    if (!template) throw new Error('WORKFLOW_TEMPLATE_NOT_APPROVED');
    const rendered = renderWorkflowTemplate(template as WorkflowTemplate, resolved.fields);
    await tx.workflowExecution.create({ data: { id: randomUUID(), enrollmentId: enrollment.id, step: step.step,
      state: rendered.ok ? 'PENDING' : 'ERROR', dueAt: step.due,
      recipientUserId: internal ? resolved.owner!.id : null,
      requestKey: canonicalSha256({ automationId: rule.id, eventKey, step: step.step }),
      templateSnapshot: json({ templateId: template.id, templateVersion: template.version, rendered }),
      stopReason: rendered.ok ? null : 'MISSING_FIELDS:' + rendered.missing.join(','),
      history: json([{ event: 'ENROLLED', sourceHash: source.hash, at: now.toISOString() }]) } });
  }
  await tx.auditLog.create({ data: { actorId: auth.actor.id, entityType: 'WorkflowEnrollment', entityId: enrollment.id,
    event: synthetic ? 'workflow_operational_synthetic_planned' : 'workflow_operational_native_planned',
    after: { sourceKind: input.source.kind, sourceHash: source.hash, synthetic } } });
  await auth.finish(); return { id: enrollment.id, replay: false };
}
