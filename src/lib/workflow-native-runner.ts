import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { AuthSession } from './auth';
import { updateActor } from './record-updates';
import { currentRecordUpdateUser, recordUpdateContext, recordUpdatePermission } from './record-update-context';
import { enrollWorkflowReceiptInTransaction, prepareNativeWorkflowEnrollment, reconcileNativeWorkflowExecution } from './workflow-executions';
import { leadVisibilityWhere } from './core-query-policy';
import { lockCommunicationDirectory } from './communication-directory-lock';
import { recoverWorkflowOperationalEvents } from './workflow-operational-capture';

/** Native projection/duplicate resolution calls this after recording its result.
 * Default-off import has no effect. Rule author authority admits intent only;
 * a real session is still required to prepare/approve/send a native message. */
export async function captureWorkflowLeadReceipt(tx: Prisma.TransactionClient, inboxEventId: string) {
  if (process.env.WORKFLOW_NATIVE_PREPARATION_MODE !== 'enabled') return { captured: 0 };
  await lockCommunicationDirectory(tx);
  const receipt = await tx.secureLeadGatewayReceipt.findUnique({ where: { inboxEventId } });
  if (!receipt) return { captured: 0 };
  await tx.$queryRaw`SELECT id FROM "OrdinaryEmailAuthority" WHERE id='ordinary-email' FOR SHARE`;
  const authority = await tx.ordinaryEmailAuthority.findUnique({ where: { id: 'ordinary-email' } });
  if (!authority?.enabled) return { captured: 0 };
  const rules = await tx.workflowAutomation.findMany({ where: { event: 'LEAD_ACCEPTED', state: 'ACTIVE', createdById: authority.userId } });
  if (!rules.length) return { captured: 0 };
  if (rules.length !== 1) {
    await tx.auditLog.create({ data: { entityType: 'SecureLeadGatewayReceipt', entityId: receipt.id,
      event: 'workflow_capture_held', after: { reason: 'MULTIPLE_ACTIVE_ACQUISITION_RULES', receiptId: receipt.id } } });
    return { captured: 0 };
  }
  await tx.$queryRaw`SELECT id FROM "WorkflowAutomation" WHERE id=${rules[0].id}::uuid FOR SHARE`;
  const rule = await tx.workflowAutomation.findUniqueOrThrow({ where: { id: rules[0].id } });
  if (rule.state !== 'ACTIVE') return { captured: 0 };
  const author = await currentRecordUpdateUser(tx, rule.createdById);
  const projection = await tx.leadProjectionLedger.findUnique({ where: { inboxEventId }, include: { duplicateCase: { select: { resolvedAt: true } } } });
  const effectiveAt = projection?.state.startsWith('RESOLVED_') ? projection.duplicateCase?.resolvedAt : projection?.completedAt;
  if (!effectiveAt || effectiveAt < rule.updatedAt || !projection || !['PROJECTED_NEW', 'RESOLVED_NEW', 'RESOLVED_EXISTING'].includes(projection.state)) return { captured: 0 };
  if (!author || author.role !== 'admin' || !recordUpdatePermission(author, 'practice_communications.write') || !recordUpdatePermission(author, 'lead.read')) {
    await tx.auditLog.create({ data: { entityType: 'WorkflowAutomation', entityId: rule.id,
      event: 'workflow_capture_held', after: { reason: 'RULE_AUTHORITY_UNAVAILABLE', receiptId: receipt.id } } });
    return { captured: 0 };
  }
  const result = await enrollWorkflowReceiptInTransaction(tx, { actor: author, finish: async () => {
    const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`; return clock.now;
  } }, { automationId: rule.id, receiptId: receipt.id }, false);
  await tx.auditLog.create({ data: { actorId: author.id, entityType: 'WorkflowEnrollment', entityId: result.id,
    event: 'workflow_projection_hook_recorded', after: { receiptId: receipt.id, ruleAuthorId: author.id, replay: result.replay, providerCalls: 0 } } });
  return { captured: result.replay ? 0 : 1 };
}

async function captureFailure(db: PrismaClient, entityType: string, entityId: string) {
  try { await db.auditLog.create({ data: { entityType, entityId, event: 'workflow_capture_held',
    after: { reason: 'CAPTURE_REQUIRES_RECOVERY', providerCalls: 0 } } }); } catch { /* Native source already committed; recovery uses its durable ledger. */ }
}
export async function captureWorkflowLeadReceiptAfterCommit(db: PrismaClient, inboxEventId: string) {
  if (process.env.WORKFLOW_NATIVE_PREPARATION_MODE !== 'enabled') return;
  try { await db.$transaction(tx => captureWorkflowLeadReceipt(tx, inboxEventId), { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 }); }
  catch { await captureFailure(db, 'BusinessInboxEvent', inboxEventId); }
}
export async function captureWorkflowDuplicateResolutionAfterCommit(db: PrismaClient, caseId: string) {
  if (process.env.WORKFLOW_NATIVE_PREPARATION_MODE !== 'enabled') return;
  try {
    const row = await db.leadDuplicateCase.findUnique({ where: { id: caseId }, include: { projectionLedger: { select: { inboxEventId: true } } } });
    if (row) await captureWorkflowLeadReceiptAfterCommit(db, row.projectionLedger.inboxEventId);
  } catch { await captureFailure(db, 'LeadDuplicateCase', caseId); }
}

/** Explicit one-shot preparation with the current native sender authority.
 * It opens no socket and starts no worker. Subsequent actual email dispatch
 * remains in the existing exact-message approval/transport pipeline. */
export async function prepareWorkflowPendingOnce(db: PrismaClient, session: AuthSession, raw: unknown) {
  if (process.env.WORKFLOW_NATIVE_PREPARATION_MODE !== 'enabled') throw new Error('WORKFLOW_NATIVE_PREPARATION_DISABLED');
  const input = z.object({ mailboxId: z.string().uuid().optional(), replyTo: z.string().email().optional(),
    automationId: z.string().uuid().optional(), limit: z.number().int().min(1).max(50).default(20) }).strict().parse(raw);
  const recoverable = await db.$transaction(async tx => {
    const auth = await updateActor(tx, session);
    if (auth.actor.role !== 'admin' || !recordUpdatePermission(auth.actor, 'practice_communications.write') || !recordUpdatePermission(auth.actor, 'lead.read')) throw new Error('WORKFLOW_DENIED');
    const authority = await tx.ordinaryEmailAuthority.findUnique({ where: { id: 'ordinary-email' } });
    if (!authority?.enabled || authority.userId !== auth.actor.id) throw new Error('WORKFLOW_SENDER_AUTHORITY_REQUIRED');
    const rules = await tx.workflowAutomation.findMany({ where: { event: 'LEAD_ACCEPTED', state: 'ACTIVE', createdById: authority.userId } });
    if (rules.length !== 1 || input.automationId && input.automationId !== rules[0].id) { await auth.finish(); return []; }
    const rule = rules[0];
    const rows = await tx.secureLeadGatewayReceipt.findMany({ where: { workflowEnrollments: { none: { automationId: rule.id } },
      inboxEvent: { state: 'PROCESSED', leadProjectionLedger: { is: { state: { in: ['PROJECTED_NEW', 'RESOLVED_NEW', 'RESOLVED_EXISTING'] },
        OR: [{ state: 'PROJECTED_NEW', completedAt: { gte: rule.updatedAt } },
          { state: { in: ['RESOLVED_NEW', 'RESOLVED_EXISTING'] }, duplicateCase: { is: { resolvedAt: { gte: rule.updatedAt } } } }],
        lead: { deletedAt: null, AND: [leadVisibilityWhere(auth.actor)] } } } } },
      select: { inboxEventId: true }, orderBy: { createdAt: 'asc' }, take: input.limit });
    await auth.finish(); return rows;
  });
  for (const source of recoverable) await db.$transaction(tx => captureWorkflowLeadReceipt(tx, source.inboxEventId), { timeout: 30_000 });
  await recoverWorkflowOperationalEvents(db, session, { automationId: input.automationId, limit: input.limit });
  const ids = await db.$transaction(async tx => {
    const auth = await updateActor(tx, session);
    if (auth.actor.role !== 'admin' || !recordUpdatePermission(auth.actor, 'practice_communications.write') || !recordUpdatePermission(auth.actor, 'lead.read')) throw new Error('WORKFLOW_DENIED');
    const now = await auth.finish();
    const rows = await tx.workflowEnrollment.findMany({ where: { synthetic: false, state: 'PENDING',
      executions: { some: { OR: [{ state: 'PENDING', dueAt: { lte: now } }, { state: { in: ['PREPARED', 'UNCERTAIN'] }, recipientUserId: null }] } },
      ...(input.automationId ? { automationId: input.automationId } : {}), lead: { deletedAt: null, AND: [leadVisibilityWhere(auth.actor)] } },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }], take: input.limit, select: { id: true } });
    await auth.finish(); return rows.map(row => row.id);
  });
  const results: Array<{ enrollmentId: string; prepared: number; error: string | null }> = [];
  for (const enrollmentId of ids) {
    try {
      const pendingEvidence = await db.workflowExecution.findMany({ where: { enrollmentId, state: { in: ['PREPARED', 'UNCERTAIN'] }, recipientUserId: null }, select: { id: true } });
      for (const execution of pendingEvidence) await reconcileNativeWorkflowExecution(db, session, execution.id);
      const result = await prepareNativeWorkflowEnrollment(db, session, { enrollmentId, mailboxId: input.mailboxId, replyTo: input.replyTo });
      results.push({ enrollmentId, prepared: result.prepared, error: null });
    } catch (error) {
      const reason = error instanceof Error && /^WORKFLOW_[A-Z_]+$/.test(error.message) ? error.message : 'WORKFLOW_REVIEW_REQUIRED';
      results.push({ enrollmentId, prepared: 0, error: reason });
      await db.$transaction(async tx => {
        const auth = await updateActor(tx, session);
        if (auth.actor.role !== 'admin') throw new Error('WORKFLOW_DENIED');
        await tx.auditLog.create({ data: { actorId: auth.actor.id, entityType: 'WorkflowEnrollment', entityId: enrollmentId,
          event: 'workflow_preparation_held', after: { reason, providerCalls: 0 } } }); await auth.finish();
      });
    }
    await db.$transaction(async tx => {
      const auth = await updateActor(tx, session), enrollment = await tx.workflowEnrollment.findUniqueOrThrow({ where: { id: enrollmentId } });
      if (auth.actor.role !== 'admin' || !(await recordUpdateContext(tx, 'LEAD', enrollment.leadId)).canRead(auth.actor)) throw new Error('WORKFLOW_DENIED');
      await tx.workflowEnrollment.update({ where: { id: enrollmentId }, data: { updatedAt: await auth.finish() } });
    });
  }
  return { results, prepared: results.reduce((sum, result) => sum + result.prepared, 0), providerCalls: 0 as const };
}
