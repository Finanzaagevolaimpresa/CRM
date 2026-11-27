import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { OrdinaryTransportSource } from './ordinary-email-transport-binding';
import { admitWorkflowService, assertWorkflowServiceEnabled, beginWorkflowServiceInvocation, serviceClock, serviceJson,
  type WorkflowServiceRuntime } from './workflow-service-authority';
import { serviceMac, type ServiceInvocation } from './workflow-service-contract';
import { executeWorkflowServiceMessage } from './workflow-service-email';
import { executeWorkflowServiceNotice, planWorkflowService, prepareWorkflowServiceMessage, reconcileWorkflowServiceMessage,recordWorkflowServiceHold } from './workflow-service-planning';

export type WorkflowServiceResult = { protocol: 'FAI_WORKFLOW_SERVICE_RESULT_V1'; prepared: number; accepted: number; uncertain: number;
  held: number; examined: number;internalDelivered: number };

/** One authenticated, durable bounded invocation for both individual sequences
 * and timed newsletters. No human token, fake session or per-message approval.
 * Production and loopback tests compose exactly this executor. */
export async function runWorkflowServiceOnce(db: PrismaClient, raw: unknown, proof: string, runtime: WorkflowServiceRuntime,
  transport: OrdinaryTransportSource, signal = new AbortController().signal) {
  assertWorkflowServiceEnabled();
  const started = await beginWorkflowServiceInvocation(db,raw,proof,runtime);
  if (started.replay) return { replay: true,result: started.result };
  const invocation = started.invocation;
  const result: WorkflowServiceResult = { protocol: 'FAI_WORKFLOW_SERVICE_RESULT_V1',prepared: 0,accepted: 0,uncertain: 0,held: 0,examined: 0,internalDelivered: 0 };
  const previous = await db.$transaction(async tx => {
    const auth = await admitWorkflowService(tx,invocation,runtime);
    // Previously recorded wire facts are projected before selecting new work.
    const rows = await tx.workflowServiceMessage.findMany({ where: { grantId: auth.grant.id,
      OR: [{ execution: { state: { in: ['PREPARED','UNCERTAIN'] } } },{ recipient: { state: { in: ['PREPARED','UNCERTAIN'] } } }] },
      select: { messageId: true },take: invocation.limit,orderBy: { createdAt: 'asc' } });
    await planWorkflowService(tx,auth,runtime,invocation.limit); return rows;
  },{ timeout: 30000 });
  for (const row of previous) await reconcileWorkflowServiceMessage(db,invocation,row.messageId,runtime);
  const candidates = await db.$transaction(async tx => {
    const auth = await admitWorkflowService(tx,invocation,runtime), now = await auth.finish();
    if (auth.policy.event === 'NEWSLETTER') {
      const rows = await tx.workflowNewsletterRecipient.findMany({ where: { runId: auth.grant.id,state: { in: ['PENDING','PREPARED'] },run: { scheduledAt: { lte: now } } },
        select: { id: true },orderBy: [{ updatedAt: 'asc' },{ id: 'asc' }],take: invocation.limit });
      return rows.map(row => ({ executionId: null,recipientId: row.id,action: auth.policy.action }));
    }
    const rows = await tx.workflowExecution.findMany({ where: { enrollment: { automationId: auth.grant.automationId,
      automationVersion: auth.grant.automationVersion,synthetic: false,state: 'PENDING' },state: { in: ['PENDING','PREPARED'] },dueAt: { lte: now } },
      select: { id: true },orderBy: [{ dueAt: 'asc' },{ id: 'asc' }],take: invocation.limit });
    return rows.map(row => ({ executionId: row.id,recipientId: null,action: auth.policy.action }));
  },{ timeout: 30000 });
  for (const candidate of candidates) {
    if (signal.aborted) break;
    result.examined++;
    try {
      if (candidate.action === 'INTERNAL_NOTICE') {
        if (await executeWorkflowServiceNotice(db,invocation,candidate,runtime)) result.internalDelivered++;
        continue;
      }
      const messageId = await prepareWorkflowServiceMessage(db,invocation,candidate,runtime);
      if (!messageId) continue;
      result.prepared++;
      const outcome = await executeWorkflowServiceMessage(db,invocation,messageId,runtime,transport,signal);
      if (outcome.state === 'ACCEPTED') result.accepted++;
      else if (['UNCERTAIN','UNRESOLVED_RESERVATION'].includes(outcome.state)) result.uncertain++;
      await reconcileWorkflowServiceMessage(db,invocation,messageId,runtime);
      if (['UNRESOLVED_RESERVATION','EXISTING_ATTEMPT'].includes(outcome.state))
        await recordWorkflowServiceHold(db,invocation,candidate,'RECONCILE_BEFORE_RETRY');
    } catch (error) {
      // Persist a sanitized hold. No retry here, especially around a committed
      // reservation, lost response or transport callback.
      result.held++;
      const reason = error instanceof Error && /^(WORKFLOW|NEWSLETTER|ORDINARY)_[A-Z_]+$/.test(error.message) ? error.message : 'WORKFLOW_SERVICE_REVIEW_REQUIRED';
      await recordWorkflowServiceHold(db,invocation,candidate,reason);
      // Global authority failures terminate the process even when detected
      // between reservation and DATA. They are never an individual grant hold.
      // Unknown DB/programming failures are not a successful delivery result.
      if (['WORKFLOW_SERVICE_DISABLED','WORKFLOW_SERVICE_CREDENTIAL_DENIED','WORKFLOW_SERVICE_CREDENTIAL_CHANGED',
        'WORKFLOW_NATIVE_KEY_UNAVAILABLE','WORKFLOW_SERVICE_REVIEW_REQUIRED'].includes(reason)) throw error;
    }
  }
  await db.$transaction(async tx => {
    // Recording the outcome of an authenticated invocation remains possible
    // after revocation; it cannot submit any message or extend its authority.
    const previous = await tx.workflowServiceInvocation.findUniqueOrThrow({ where: { id: invocation.id } });
    if (previous.finishedAt) throw new Error('WORKFLOW_SERVICE_INVOCATION_FINISHED');
    await tx.workflowServiceInvocation.update({ where: { id: invocation.id },data: { finishedAt: await serviceClock(tx),result: serviceJson(result) } });
  });
  return { replay: false,result };
}

/** Service-side command constructor. The dedicated key signs only a bounded
 * grant invocation, not an arbitrary recipient, body, provider or SQL action. */
export function createWorkflowServiceCommand(grantId: string, runtime: WorkflowServiceRuntime, now = new Date(), limit = 20) {
  const invocation: ServiceInvocation = { protocol: 'FAI_WORKFLOW_SERVICE_INVOCATION_V1',id: randomUUID(),grantId,
    issuedAt: now.toISOString(),expiresAt: new Date(now.getTime()+300000).toISOString(),limit };
  return { invocation,proof: serviceMac('invocation',invocation,runtime.credential.key) };
}

/** A stale/revoked individual grant cannot stop unrelated work in the explicit
 * process. Global credential/key/gate failures and unknown errors stay fatal.
 * This is iteration only, never a retry of a failed command or SMTP attempt. */
export async function dispatchWorkflowServiceGrants<T>(grants: readonly { id: string }[],operation: (id: string) => Promise<T>,
  report: (value: { result: T }|{ held: string }) => void) {
  const localDenials = new Set(['WORKFLOW_SERVICE_DENIED','WORKFLOW_SOURCE_CHANGED','WORKFLOW_RULE_PAUSED',
    'WORKFLOW_SERVICE_QUOTA','NEWSLETTER_POLICY_UNAVAILABLE','NEWSLETTER_NATIVE_ADMISSION_DENIED','ORDINARY_EMAIL_TRANSPORT_UNAVAILABLE']);
  for (const grant of grants) {
    try { report({ result: await operation(grant.id) }); }
    catch (error) {
      if (!(error instanceof Error) || !localDenials.has(error.message)) throw error;
      report({ held: error.message });
    }
  }
}
