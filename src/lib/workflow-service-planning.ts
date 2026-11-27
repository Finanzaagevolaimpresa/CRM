import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { canonicalSha256 } from './canonical-json';
import { leadVisibilityWhere } from './core-query-policy';
import { currentRecordUpdateUser,recordUpdateContext } from './record-update-context';
import { enrollWorkflowReceiptInTransaction, stopPendingWorkflowExecutions, workflowEnrollmentSourceCurrent } from './workflow-executions';
import { planWorkflowNewsletterInTransaction } from './workflow-newsletters';
import { renderWorkflowTemplate, type WorkflowTemplate } from './workflow-automation-contract';
import { lockNativeNewsletterPreference, nativeNewsletterQualification } from './workflow-newsletter-admission';
import { readNativeNewsletterPolicy } from './workflow-newsletter-policy';
import { readAdmittedOrdinaryEmailReceipts } from './ordinary-email-receipt-reader';
import { admitWorkflowService, assertServiceAdmission, assertWorkflowServiceQuota, serviceClock, serviceDenied, serviceJson,
  type WorkflowServiceAdmission, type WorkflowServiceRuntime } from './workflow-service-authority';
import { serviceMac,type ServiceInvocation } from './workflow-service-contract';
import { recoverableWorkflowSources,workflowOperationalEffectiveAt } from './workflow-operational-capture';
import { resolveWorkflowSource,workflowSourceInput } from './workflow-event-source';
import { planWorkflowOperationalEventInTransaction } from './workflow-event-planner';

type Tx = Prisma.TransactionClient;
type SourceId = { executionId: string|null; recipientId: string|null };
const history = (prior: Prisma.JsonValue, event: object) => {
  if (!Array.isArray(prior)) serviceDenied(); return serviceJson([...prior,event]);
};
const renderedSchema = z.object({ ok: z.literal(true),subject: z.string(),body: z.string(),hash: z.string() });

export async function planWorkflowService(tx: Tx, auth: WorkflowServiceAdmission, runtime: WorkflowServiceRuntime, limit: number) {
  assertServiceAdmission(tx,auth);
  if (auth.policy.event === 'NEWSLETTER') {
    const policy = await (runtime.newsletterPolicySource ?? readNativeNewsletterPolicy)(await auth.finish());
    await planWorkflowNewsletterInTransaction(tx,auth,{ id: auth.grant.id,automationId: auth.grant.automationId },{
      synthetic: false,unsubscribeUrl: policy.unsubscribeUrl,qualificationReference: nativeNewsletterQualification(policy.bindingHash),policyReference: policy.policyReference });
    return;
  }
  const rule = await tx.workflowAutomation.findUniqueOrThrow({ where: { id: auth.grant.automationId } });
  const cutoff = new Date(Math.max(auth.grant.validFrom.getTime(),auth.grant.approvedAt.getTime(),rule.updatedAt.getTime()));
  if (auth.policy.event !== 'LEAD_ACCEPTED') {
    // A document list is an explicit business request already persisted by the
    // native planner, never invented by a background runner. Other native facts
    // are recovered automatically from their canonical audit/version.
    if (auth.policy.event !== 'DOCUMENT_REQUESTED') {
      const sources = await recoverableWorkflowSources(tx,[{ ...rule,updatedAt: cutoff }],limit);
      for (const source of sources) {
        const resolved = await resolveWorkflowSource(tx,source);
        await planWorkflowOperationalEventInTransaction(tx,auth,{ automationId: rule.id,source,expectedLeadVersion: resolved.lead.updatedAt.toISOString() });
      }
    }
    await auth.finish(); return;
  }
  const sources = await tx.secureLeadGatewayReceipt.findMany({ where: { workflowEnrollments: { none: { automationId: rule.id } },
    inboxEvent: { state: 'PROCESSED',leadProjectionLedger: { is: { state: { in: ['PROJECTED_NEW','RESOLVED_NEW','RESOLVED_EXISTING'] },
      OR: [{ state: 'PROJECTED_NEW',completedAt: { gte: cutoff } },
        { state: { in: ['RESOLVED_NEW','RESOLVED_EXISTING'] },duplicateCase: { is: { resolvedAt: { gte: cutoff } } } }],
      lead: { deletedAt: null,AND: [leadVisibilityWhere(auth.actor)] } } } } },
    select: { id: true },orderBy: [{ createdAt: 'asc' },{ id: 'asc' }],take: limit });
  for (const source of sources) await enrollWorkflowReceiptInTransaction(tx,auth,{ automationId: rule.id,receiptId: source.id },false);
  await auth.finish();
}

/** Same current source checks for draft preparation, reservation, claim and
 * both DATA boundaries. A source snapshot cannot authorize a changed lead. */
export async function readWorkflowServiceSource(tx: Tx, auth: WorkflowServiceAdmission, id: SourceId, runtime: WorkflowServiceRuntime) {
  assertServiceAdmission(tx,auth);
  if (Boolean(id.executionId) === Boolean(id.recipientId)) serviceDenied();
  const now = await auth.finish();
  if (id.executionId) {
    const initial = await tx.workflowExecution.findUniqueOrThrow({ where: { id: id.executionId },include: { enrollment: true } });
    const context = await recordUpdateContext(tx,'LEAD',initial.enrollment.leadId,true);
    if (!context.canRead(auth.actor)) serviceDenied();
    await tx.$queryRaw`SELECT id FROM "WorkflowEnrollment" WHERE id=${initial.enrollment.id}::uuid FOR UPDATE`;
    const row = await tx.workflowExecution.findUniqueOrThrow({ where: { id: id.executionId },include: { enrollment: true } }), enrollment = row.enrollment;
    const internal = auth.policy.action === 'INTERNAL_NOTICE';
    if (enrollment.synthetic || enrollment.automationId !== auth.grant.automationId || enrollment.automationVersion !== auth.grant.automationVersion
      || Boolean(row.recipientUserId) !== internal || !['CONFIRMATION','FOLLOW_UP','REMINDER'].includes(row.step)
      || !await workflowEnrollmentSourceCurrent(tx,enrollment)) serviceDenied();
    let effectiveAt: Date|null|undefined, operational: Awaited<ReturnType<typeof resolveWorkflowSource>>|undefined;
    if (auth.policy.event === 'LEAD_ACCEPTED') {
      if (!enrollment.sourceReceiptId) serviceDenied();
      const receipt = await tx.secureLeadGatewayReceipt.findUniqueOrThrow({ where: { id: enrollment.sourceReceiptId },
        include: { inboxEvent: { include: { leadProjectionLedger: { include: { duplicateCase: true } } } } } });
      const projection = receipt.inboxEvent.leadProjectionLedger;
      effectiveAt = projection?.state.startsWith('RESOLVED_') ? projection.duplicateCase?.resolvedAt : projection?.completedAt;
    } else {
      if (enrollment.sourceReceiptId) serviceDenied();
      const { source } = z.object({ source: z.object({ input: workflowSourceInput }).passthrough() }).passthrough().parse(enrollment.snapshot);
      if (source.input.kind !== auth.policy.event) serviceDenied();
      operational = await resolveWorkflowSource(tx,source.input);
      effectiveAt = source.input.kind === 'DOCUMENT_REQUESTED' ? enrollment.createdAt : await workflowOperationalEffectiveAt(tx,{ ...source.input,kind: source.input.kind });
    }
    if (!effectiveAt || effectiveAt < auth.grant.validFrom || effectiveAt < auth.grant.approvedAt) serviceDenied();
    if (enrollment.state !== 'PENDING' || !['PENDING','PREPARED'].includes(row.state) || row.dueAt > now) return null;
    const lead = await tx.lead.findUniqueOrThrow({ where: { id: enrollment.leadId } });
    const snapshot = z.object({ recipient: z.string(),fields: z.object({ firstName: z.string(),companyName: z.string() }) }).passthrough().parse(enrollment.snapshot);
    if (lead.deletedAt || snapshot.recipient !== (lead.email ?? '') || snapshot.fields.firstName !== lead.firstName || snapshot.fields.companyName !== (lead.companyName ?? '')) serviceDenied();
    if (internal) {
      const recipient = row.recipientUserId && await currentRecordUpdateUser(tx,row.recipientUserId);
      if (!recipient || lead.assignedToId !== recipient.id || !context.canRead(recipient)) serviceDenied();
    } else if (!z.string().email().safeParse(snapshot.recipient).success) serviceDenied();
    if (operational?.reminderBefore && operational.reminderBefore <= now) {
      for (const pending of await tx.workflowExecution.findMany({ where: { enrollmentId: enrollment.id,state: { in: ['PENDING','PREPARED'] } } }))
        await tx.workflowExecution.update({ where: { id: pending.id },data: { state: 'STOPPED',stopReason: 'APPOINTMENT_PASSED',
          history: history(pending.history,{ event: 'STOPPED',reason: 'APPOINTMENT_PASSED',at: now.toISOString() }) } });
      await tx.workflowEnrollment.update({ where: { id: enrollment.id },data: { state: 'STOPPED' } }); return null;
    }
    if (row.step === 'FOLLOW_UP') {
      const [appointment,reply] = await Promise.all([
        tx.leadAppointment.findFirst({ where: { leadId: lead.id,status: 'BOOKED' },select: { id: true } }),
        tx.communicationReply.findFirst({ where: { message: { leadId: lead.id },receivedAt: { gte: enrollment.createdAt } },select: { id: true } }),
      ]);
      if (appointment || reply) {
        await stopPendingWorkflowExecutions(tx,{ leadId: lead.id,reason: appointment ? 'APPOINTMENT_BOOKED' : 'REPLIED',evidenceId: (appointment ?? reply)!.id });
        return null;
      }
    }
    if (row.step !== 'CONFIRMATION') {
      const first = await tx.workflowExecution.findUnique({ where: { enrollmentId_step: { enrollmentId: enrollment.id,step: 'CONFIRMATION' } } });
      if (first?.state !== 'SENT') return null;
      let acceptedAt: Date|null = null;
      if (internal) {
        const notice = await tx.workflowServiceNotice.findUnique({ where: { executionId: first.id } });
        if (notice?.grantId !== auth.grant.id) serviceDenied(); acceptedAt=notice.createdAt;
      } else {
        const firstMessage = await tx.workflowServiceMessage.findUnique({ where: { executionId: first.id } });
        if (firstMessage?.grantId !== auth.grant.id) serviceDenied();
        const accepted = (await readAdmittedOrdinaryEmailReceipts(tx,first.id)).find(value => value.outcome === 'ACCEPTED' && value.snapshotHash === firstMessage.snapshotHash);
        acceptedAt=accepted?.recordedAt ?? null;
      }
      // The delay starts at evidenced SMTP acceptance, not intake or draft time.
      if (!acceptedAt || row.step === 'FOLLOW_UP' && acceptedAt.getTime()+auth.rule.delayMinutes*60000 > now.getTime()) return null;
    }
    const templateId = row.step === 'CONFIRMATION' ? auth.rule.configuration.confirmationTemplateId : auth.rule.configuration.followupTemplateId;
    if (!templateId) serviceDenied();
    const template = await tx.workflowEmailTemplate.findUniqueOrThrow({ where: { id: templateId } });
    const expected = renderWorkflowTemplate(template as WorkflowTemplate,operational?.fields ?? snapshot.fields);
    const stored = z.object({ templateId: z.string(),templateVersion: z.number(),rendered: renderedSchema }).parse(row.templateSnapshot);
    if (!expected.ok || stored.templateId !== templateId || stored.templateVersion !== template.version || canonicalSha256(expected) !== canonicalSha256(stored.rendered)) serviceDenied();
    return { messageId: row.id,leadId: lead.id,to: snapshot.recipient,subject: expected.subject,body: expected.body,
      sourceHash: enrollment.sourceHash,executionId: row.id,recipientId: null,recipientUserId: row.recipientUserId,history: row.history,state: row.state,policySnapshot: null };
  }
  const initial = await tx.workflowNewsletterRecipient.findUniqueOrThrow({ where: { id: id.recipientId! } });
  if (!(await recordUpdateContext(tx,'LEAD',initial.leadId,true)).canRead(auth.actor)) serviceDenied();
  await tx.$queryRaw`SELECT id FROM "WorkflowNewsletterRecipient" WHERE id=${initial.id}::uuid FOR UPDATE`;
  const row = await tx.workflowNewsletterRecipient.findUniqueOrThrow({ where: { id: initial.id },include: { run: true,lead: true } });
  if (row.run.synthetic || row.runId !== auth.grant.id || row.run.automationId !== auth.grant.automationId || row.run.automationVersion !== auth.grant.automationVersion) serviceDenied();
  if (!['PENDING','PREPARED'].includes(row.state) || row.run.scheduledAt > now) return null;
  const snapshot = z.object({ email: z.string().email(),firstName: z.string(),companyName: z.string(),rendered: renderedSchema }).parse(row.snapshot);
  if (row.lead.deletedAt || row.lead.email?.trim().toLowerCase() !== snapshot.email || row.lead.firstName !== snapshot.firstName || (row.lead.companyName ?? '') !== snapshot.companyName) serviceDenied();
  const policy = await (runtime.newsletterPolicySource ?? readNativeNewsletterPolicy)(now);
  const check = await lockNativeNewsletterPreference(tx,snapshot.email,nativeNewsletterQualification(policy.bindingHash),runtime.newsletterPolicySource);
  const template = await tx.workflowEmailTemplate.findUniqueOrThrow({ where: { id: auth.rule.configuration.confirmationTemplateId } });
  const expected = renderWorkflowTemplate(template as WorkflowTemplate,{ firstName: snapshot.firstName,companyName: snapshot.companyName,unsubscribeUrl: policy.unsubscribeUrl });
  if (!expected.ok || canonicalSha256(expected) !== canonicalSha256(snapshot.rendered)) serviceDenied();
  return { messageId: row.id,leadId: row.leadId,to: snapshot.email,subject: expected.subject,body: expected.body,
    sourceHash: canonicalSha256({ runId: row.runId,requestKey: row.requestKey,snapshot: row.snapshot,runSnapshot: row.run.snapshot }),
    executionId: null,recipientId: row.id,recipientUserId: null,history: row.history,state: row.state,policySnapshot: await check() };
}

/** Internal delivery is one atomic DB effect, with its own immutable delegated
 * decision and quota. No ApprovedCommunication, SMTP attempt or fake email. */
export async function executeWorkflowServiceNotice(db: PrismaClient,invocation: ServiceInvocation,id: SourceId,runtime: WorkflowServiceRuntime) {
  return db.$transaction(async tx => {
    const auth = await admitWorkflowService(tx,invocation,runtime);
    if (auth.policy.action !== 'INTERNAL_NOTICE') serviceDenied();
    const source = await readWorkflowServiceSource(tx,auth,id,runtime);
    if (!source) return false;
    if (!source.executionId || !source.recipientUserId || source.state !== 'PENDING') serviceDenied();
    await assertWorkflowServiceQuota(tx,auth);
    const now = await auth.finish(), textHash = canonicalSha256({ title: source.subject,body: source.body });
    const decision = { protocol: 'FAI_WORKFLOW_SERVICE_INTERNAL_DECISION_V1',executionId: source.executionId,grantId: auth.grant.id,
      grantRevision: auth.grant.revision,invocationId: invocation.id,policyHash: auth.grant.policyHash,sourceHash: source.sourceHash,
      recipientUserId: source.recipientUserId,textHash,at: now.toISOString() };
    await tx.workflowServiceNotice.create({ data: { executionId: source.executionId,grantId: auth.grant.id,invocationId: invocation.id,
      recipientUserId: source.recipientUserId,policyHash: auth.grant.policyHash,sourceHash: source.sourceHash,textHash,
      decision: serviceJson(decision),decisionHash: canonicalSha256(decision),proof: serviceMac('decision',decision,runtime.credential.key) } });
    await tx.workflowExecution.update({ where: { id: source.executionId },data: { state: 'SENT',attemptCount: { increment: 1 },
      receipt: { channel: 'CRM_INTERNAL_NOTICE',synthetic: false,recipientUserId: source.recipientUserId,id: source.executionId,
        title: source.subject,body: source.body,at: now.toISOString(),delivered: true,grantId: auth.grant.id },
      history: history(source.history,{ event: 'SERVICE_INTERNAL_NOTICE_RECORDED',decisionHash: canonicalSha256(decision),at: now.toISOString() }) } });
    const execution = await tx.workflowExecution.findUniqueOrThrow({ where: { id: source.executionId } });
    if (!await tx.workflowExecution.count({ where: { enrollmentId: execution.enrollmentId,state: { notIn: ['SENT','STOPPED'] } } }))
      await tx.workflowEnrollment.update({ where: { id: execution.enrollmentId },data: { state: 'COMPLETED' } });
    await auth.finish(); return true;
  },{ timeout: 30000 });
}

export async function prepareWorkflowServiceMessage(db: PrismaClient, invocation: ServiceInvocation, id: SourceId, runtime: WorkflowServiceRuntime) {
  return db.$transaction(async tx => {
    const auth = await admitWorkflowService(tx,invocation,runtime), source = await readWorkflowServiceSource(tx,auth,id,runtime);
    if (auth.policy.action !== 'EMAIL') serviceDenied();
    if (!source) return null;
    const previous = await tx.workflowServiceMessage.findUnique({ where: { messageId: source.messageId } });
    if (previous) {
      if (previous.grantId !== auth.grant.id || previous.sourceHash !== source.sourceHash) serviceDenied();
      return source.messageId;
    }
    if (source.state !== 'PENDING') serviceDenied();
    const { saveWorkflowServiceDraft } = await import('./approved-communications');
    const draft = await saveWorkflowServiceDraft(tx,auth,source);
    await tx.workflowServiceMessage.create({ data: { messageId: draft.id,versionId: draft.versionId,grantId: auth.grant.id,invocationId: invocation.id,
      executionId: source.executionId,recipientId: source.recipientId,sourceHash: source.sourceHash,snapshotHash: draft.snapshotHash,policyHash: auth.grant.policyHash } });
    const receipt = { channel: 'NATIVE_EMAIL_DRAFT',synthetic: false,messageId: draft.id,revision: draft.revision,snapshotHash: draft.snapshotHash,sent: false };
    const entry = { event: 'SERVICE_DRAFT_PREPARED',grantId: auth.grant.id,messageId: draft.id,at: (await auth.finish()).toISOString() };
    if (source.executionId) await tx.workflowExecution.update({ where: { id: source.executionId },data: { state: 'PREPARED',receipt,history: history(source.history,entry) } });
    else await tx.workflowNewsletterRecipient.update({ where: { id: source.recipientId! },data: { state: 'PREPARED',nativeMessageId: draft.id,
      nativeRevision: draft.revision,nativeSnapshotHash: draft.snapshotHash,policySnapshot: serviceJson(source.policySnapshot),receipt,history: history(source.history,entry) } });
    await auth.finish(); return draft.id;
  },{ timeout: 30000 });
}

/** Evidence-only projection. It never creates a new attempt, and a committed
 * reservation without outcome stays unresolved until native reconciliation. */
export async function reconcileWorkflowServiceMessage(db: PrismaClient, invocation: ServiceInvocation, messageId: string, runtime: WorkflowServiceRuntime) {
  return db.$transaction(async tx => {
    const auth = await admitWorkflowService(tx,invocation,runtime);
    const binding = await tx.workflowServiceMessage.findUniqueOrThrow({ where: { messageId } });
    if (binding.grantId !== auth.grant.id) serviceDenied();
    const version = await tx.communicationVersion.findUniqueOrThrow({ where: { id: binding.versionId },include: { message: true } });
    if (!version.message.leadId || !(await recordUpdateContext(tx,'LEAD',version.message.leadId,true)).canRead(auth.actor)) serviceDenied();
    const outcome = (await readAdmittedOrdinaryEmailReceipts(tx,messageId)).find(row => row.snapshotHash === binding.snapshotHash);
    if (!outcome?.outcome) return null;
    const state = outcome.outcome === 'ACCEPTED' ? 'SENT' : outcome.outcome === 'UNCERTAIN' ? 'UNCERTAIN' : 'ERROR';
    const entry = { event: 'SERVICE_NATIVE_'+state,attemptId: outcome.id,at: (await auth.finish()).toISOString(),delivered: false };
    if (binding.executionId) {
      const row = await tx.workflowExecution.findUniqueOrThrow({ where: { id: binding.executionId } });
      if (row.state !== state && row.state !== 'SENT') await tx.workflowExecution.update({ where: { id: row.id },data: { state,
        stopReason: null,attemptCount: Math.max(row.attemptCount,1),history: history(row.history,entry) } });
      if (state === 'SENT' && row.step === 'CONFIRMATION' && outcome.recordedAt) {
        const dueAt = new Date(outcome.recordedAt.getTime()+auth.rule.delayMinutes*60000).toISOString();
        const followup = await tx.workflowExecution.findUnique({ where: { enrollmentId_step: { enrollmentId: row.enrollmentId,step: 'FOLLOW_UP' } } });
        if (followup && ['PENDING','PREPARED'].includes(followup.state) && Array.isArray(followup.history)
          && !followup.history.some(value => typeof value === 'object' && value !== null && !Array.isArray(value) && value.event === 'SERVICE_WAIT_STARTED'))
          await tx.workflowExecution.update({ where: { id: followup.id },data: { history: history(followup.history,{ event: 'SERVICE_WAIT_STARTED',dueAt,at: outcome.recordedAt.toISOString() }) } });
      }
      if (!await tx.workflowExecution.count({ where: { enrollmentId: row.enrollmentId,state: { notIn: ['SENT','STOPPED'] } } }))
        await tx.workflowEnrollment.updateMany({ where: { id: row.enrollmentId,state: 'PENDING' },data: { state: 'COMPLETED' } });
    } else {
      const row = await tx.workflowNewsletterRecipient.findUniqueOrThrow({ where: { id: binding.recipientId! } });
      if (row.state !== state && row.state !== 'SENT') await tx.workflowNewsletterRecipient.update({ where: { id: row.id },data: { state,
        attemptCount: Math.max(row.attemptCount,1),receipt: serviceJson({ channel: 'NATIVE_SMTP',attemptId: outcome.id,outcome: outcome.outcome,delivered: false }),history: history(row.history,entry) } });
      const rows = await tx.workflowNewsletterRecipient.findMany({ where: { runId: row.runId },select: { state: true } });
      await tx.workflowNewsletterRun.update({ where: { id: row.runId },data: { state: rows.some(value => value.state === 'UNCERTAIN') ? 'UNCERTAIN'
        : rows.some(value => ['PENDING','PREPARED'].includes(value.state)) ? 'PENDING' : 'COMPLETED' } });
    }
    await auth.finish(); return state;
  },{ timeout: 30000 });
}

/** Receipt/logging authority only: an authenticated durable invocation may
 * record what prevented its already-selected work after revocation/expiry.
 * No draft, decision or transport can be created here. Unchanged holds append
 * no history/audit; known SMTP facts retain precedence over an error message. */
export async function recordWorkflowServiceHold(db: PrismaClient,invocation: ServiceInvocation,id: SourceId,reason: string) {
  if (!/^(WORKFLOW|NEWSLETTER|ORDINARY)_[A-Z_]+$/.test(reason) && reason !== 'RECONCILE_BEFORE_RETRY') reason='WORKFLOW_SERVICE_REVIEW_REQUIRED';
  return db.$transaction(async tx => {
    const command = await tx.workflowServiceInvocation.findUniqueOrThrow({ where: { id: invocation.id },include: { grant: true } });
    if (command.grantId !== invocation.grantId || command.finishedAt) serviceDenied();
    await tx.$queryRaw`SELECT id FROM "WorkflowServiceGrant" WHERE id=${command.grantId}::uuid FOR UPDATE`;
    const sourceId = id.executionId ?? id.recipientId; if (!sourceId || Boolean(id.executionId) === Boolean(id.recipientId)) serviceDenied();
    const row = id.executionId ? await tx.workflowExecution.findUniqueOrThrow({ where: { id: sourceId },include: { enrollment: true } })
      : await tx.workflowNewsletterRecipient.findUniqueOrThrow({ where: { id: sourceId },include: { run: true } });
    const parent = 'enrollment' in row ? row.enrollment : row.run;
    if (parent.automationId !== command.grant.automationId || parent.automationVersion !== command.grant.automationVersion || parent.synthetic) serviceDenied();
    if (row.state === 'SENT' || row.state === 'STOPPED') return;
    const binding = await tx.workflowServiceMessage.findUnique({ where: { messageId: sourceId } });
    if (binding && binding.grantId !== command.grantId) serviceDenied();
    const receipts = binding ? await readAdmittedOrdinaryEmailReceipts(tx,sourceId) : [];
    const receipt = receipts.find(value => value.snapshotHash === binding?.snapshotHash);
    if (receipt && !receipt.outcome && reason === 'RECONCILE_BEFORE_RETRY') {
      const attempt = await tx.ordinaryEmailAttempt.findUniqueOrThrow({ where: { id: receipt.id },include: { decision: true,claim: true } });
      const owner = z.object({ invocationId: z.string().uuid() }).passthrough().parse(attempt.decision.decision);
      const active = await tx.workflowServiceInvocation.findUniqueOrThrow({ where: { id: owner.invocationId } });
      const now = await serviceClock(tx);
      // A concurrent observer must not invalidate the source still used by the
      // one committed sender. This grants no claim/retry: only its own live
      // invocation can proceed, and native DATA still rechecks every guard.
      if (active.id !== invocation.id && !active.finishedAt && active.expiresAt > now
        && (!attempt.claim || attempt.claim.expiresAt > now)) return;
    }
    const state = receipt?.outcome === 'ACCEPTED' ? 'SENT' : receipt?.outcome === 'NOT_SENT' ? 'ERROR'
      : receipt ? 'UNCERTAIN' : ['WORKFLOW_SERVICE_QUOTA','ORDINARY_EMAIL_TRANSPORT_UNAVAILABLE'].includes(reason) ? row.state : 'ERROR';
    if (receipt && !receipt.outcome) reason='RECONCILE_BEFORE_RETRY';
    const last = Array.isArray(row.history) ? row.history.at(-1) : null;
    if (row.state === state && last && typeof last === 'object' && !Array.isArray(last) && last.event === 'SERVICE_HELD' && last.reason === reason) return;
    const entry = { event: 'SERVICE_HELD',reason,nextStep: 'ADMIN_REVIEW_NATIVE_RECEIPT_OR_CONFIGURATION',at: (await serviceClock(tx)).toISOString(),
      ...(receipt ? { nativeAttemptId: receipt.id,nativeOutcome: receipt.outcome } : {}) };
    if (id.executionId) await tx.workflowExecution.update({ where: { id: sourceId },data: { state,stopReason: state === 'SENT' ? null : reason,
      attemptCount: receipt ? Math.max(row.attemptCount,1) : row.attemptCount,history: history(row.history,entry) } });
    else await tx.workflowNewsletterRecipient.update({ where: { id: sourceId },data: { state,
      attemptCount: receipt ? Math.max(row.attemptCount,1) : row.attemptCount,history: history(row.history,entry),
      policySnapshot: serviceJson({ ...('policySnapshot' in row && row.policySnapshot && typeof row.policySnapshot === 'object' && !Array.isArray(row.policySnapshot) ? row.policySnapshot : {}),serviceHold: { reason,nextStep: entry.nextStep } }) } });
    await tx.auditLog.create({ data: { entityType: 'WorkflowServiceGrant',entityId: command.grantId,event: 'workflow_service_held',
      after: { reason,invocationId: invocation.id,sourceId,state } } });
  },{ timeout: 30000 });
}
