import { Prisma, type PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AuthSession } from './auth';
import { updateActor } from './record-updates';
import { recordUpdateContext, recordUpdatePermission } from './record-update-context';
import { leadVisibilityWhere } from './core-query-policy';
import { canonicalSha256 } from './canonical-json';
import { assertSyntheticCatalogDatabase } from './service-catalog-v2-persistence';
import { renderWorkflowTemplate, workflowRuleInput, type WorkflowTemplate } from './workflow-automation-contract';
import type { MarketingPreferences } from './marketing-preferences/service';
import type { Decision } from './marketing-preferences/policy';

type Tx = Prisma.TransactionClient;
const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value));
const history = (before: Prisma.JsonValue, event: object) => {
  if (!Array.isArray(before)) throw new Error('NEWSLETTER_HISTORY_INVALID');
  return json([...before, event]);
};
const runState = (rows: ReadonlyArray<{ state: string }>) => rows.some(row => ['SENDING', 'UNCERTAIN'].includes(row.state)) ? 'UNCERTAIN'
  : rows.some(row => ['PENDING','PREPARED'].includes(row.state)) ? 'PENDING' : 'COMPLETED';
async function transaction<T>(db: PrismaClient, operation: (tx: Tx) => Promise<T>) {
  // This wrapper contains DB work only. Transport invocation is outside it and
  // is never retried when a transaction or provider result is uncertain.
  for (let attempt = 0; ; attempt++) {
    try { return await db.$transaction(operation, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 }); }
    catch (error) {
      const aborted = error instanceof Prisma.PrismaClientKnownRequestError && (error.code === 'P2034'
        || error.code === 'P2010' && ['40001', '40P01'].includes(String(error.meta?.code)));
      if (!aborted || attempt >= 2) throw error;
    }
  }
}
async function admin(tx: Tx, session: AuthSession) {
  const auth = await updateActor(tx, session);
  if (auth.actor.role !== 'admin' || !recordUpdatePermission(auth.actor, 'practice_communications.write') || !recordUpdatePermission(auth.actor, 'lead.read')) throw new Error('NEWSLETTER_DENIED');
  return auth;
}
async function runtimeAllowed(db: PrismaClient, synthetic: boolean) {
  if (synthetic) {
    if (process.env.APP_ENV !== 'test') throw new Error('NEWSLETTER_SYNTHETIC_ONLY');
    await assertSyntheticCatalogDatabase(db);
  } else if (process.env.WORKFLOW_NATIVE_PREPARATION_MODE !== 'enabled') throw new Error('WORKFLOW_NATIVE_PREPARATION_DISABLED');
}
export type NewsletterTransportResult = Readonly<{ outcome: 'SENT' | 'ERROR' | 'UNCERTAIN'; evidence: string; delivered: false }>;
export type NewsletterRuntime = Readonly<{
  synthetic: boolean;
  preferences: Pick<MarketingPreferences, 'select' | 'atFinalHandoff'>;
  unsubscribeUrl: string;
  qualificationReference: string;
  policyReference: string;
  // A production composition must supply a separately authorized native sender.
  // This release supplies only the synthetic adapter, never a real transport.
  transport: (request: Readonly<{ requestKey: string; attemptKey: string; attempt: number; recipient: string; subject: string; body: string }>) => Promise<NewsletterTransportResult>;
}>;
const recipientSnapshot = z.object({ email: z.string().email(), firstName: z.string(), companyName: z.string(),
  rendered: z.object({ ok: z.literal(true), subject: z.string(), body: z.string(), hash: z.string() }) });

/** Configured recipients become an immutable run; changing a rule never changes
 * this run. Planning does not infer consent from selecting a checkbox. */
export async function planWorkflowNewsletter(db: PrismaClient, session: AuthSession, raw: unknown, runtime: NewsletterRuntime) {
  const input = z.object({ id: z.string().uuid(), automationId: z.string().uuid() }).strict().parse(raw);
  await runtimeAllowed(db, runtime.synthetic);
  const unsubscribe = new URL(runtime.unsubscribeUrl);
  if (unsubscribe.protocol !== 'https:' || unsubscribe.username || unsubscribe.password || !runtime.qualificationReference.trim() || !runtime.policyReference.trim()
    || runtime.synthetic && !unsubscribe.hostname.endsWith('.test')) throw new Error('NEWSLETTER_RUNTIME_INVALID');
  return transaction(db, async tx => {
    const auth = await admin(tx, session);
    const existing = await tx.workflowNewsletterRun.findUnique({ where: { id: input.id } });
    if (existing) {
      if (existing.automationId !== input.automationId || existing.createdById !== auth.actor.id || existing.synthetic !== runtime.synthetic)
        throw new Error('NEWSLETTER_COMMAND_CONFLICT');
      await auth.finish(); return { id: existing.id, replay: true };
    }
    const automation = await tx.workflowAutomation.findUniqueOrThrow({ where: { id: input.automationId } });
    const rule = workflowRuleInput.parse({ id: automation.id, name: automation.name, event: automation.event, state: automation.state,
      expectedVersion: automation.version, delayMinutes: automation.delayMinutes, configuration: automation.configuration });
    if (rule.event !== 'NEWSLETTER' || rule.state !== (runtime.synthetic ? 'TEST_READY' : 'ACTIVE')) throw new Error('NEWSLETTER_NOT_READY');
    const template = await tx.workflowEmailTemplate.findUniqueOrThrow({ where: { id: rule.configuration.confirmationTemplateId } });
    if (template.purpose !== 'NEWSLETTER' || template.state !== 'PUBLISHED' || !template.authorizationReference) throw new Error('NEWSLETTER_TEMPLATE_NOT_APPROVED');
    const leads = await tx.lead.findMany({ where: { id: { in: rule.configuration.recipientIds }, deletedAt: null,
      email: { not: null }, AND: [leadVisibilityWhere(auth.actor)] } });
    if (leads.length !== rule.configuration.recipientIds.length || !leads.length) throw new Error('NEWSLETTER_RECIPIENT_DENIED');
    if (runtime.synthetic && leads.some(lead => !/@[^@]+\.(test|invalid)$/i.test(lead.email!))) throw new Error('NEWSLETTER_SYNTHETIC_RECIPIENT_REQUIRED');
    const run = await tx.workflowNewsletterRun.create({ data: { id: input.id, automationId: rule.id, automationVersion: automation.version,
      synthetic: runtime.synthetic, scheduledAt: new Date(rule.configuration.newsletterAt!),
      snapshot: json({ rule, template, qualificationReference: runtime.qualificationReference, policyReference: runtime.policyReference, unsubscribeUrl: runtime.unsubscribeUrl }), createdById: auth.actor.id } });
    const seenEmails = new Set<string>();
    for (const lead of leads) {
      const email = lead.email!.trim().toLowerCase();
      const rendered = renderWorkflowTemplate(template as WorkflowTemplate, { firstName: lead.firstName,
        companyName: lead.companyName ?? '', unsubscribeUrl: runtime.unsubscribeUrl });
      const duplicateEmail = rendered.ok && seenEmails.has(email);
      if (rendered.ok) seenEmails.add(email);
      await tx.workflowNewsletterRecipient.create({ data: { id: randomUUID(), runId: run.id, leadId: lead.id,
        state: !rendered.ok ? 'ERROR' : duplicateEmail ? 'BLOCKED' : 'PENDING',
        requestKey: canonicalSha256({ runId: run.id, email, leadId: lead.id }),
        snapshot: json({ email, firstName: lead.firstName, companyName: lead.companyName ?? '', rendered }),
        history: json([{ event: duplicateEmail ? 'DUPLICATE_EMAIL' : rendered.ok ? 'PLANNED' : 'MISSING_FIELDS', at: (await auth.finish()).toISOString() }]) } });
    }
    await auth.finish(); return { id: run.id, replay: false };
  });
}

async function recordBlocked(db: PrismaClient, session: AuthSession, id: string, decision: Decision | { reason: string }, ticket: unknown = null) {
  return transaction(db, async tx => {
    const auth = await admin(tx, session);
    await tx.$queryRaw`SELECT id FROM "WorkflowNewsletterRecipient" WHERE id=${id}::uuid FOR UPDATE`;
    const row = await tx.workflowNewsletterRecipient.findUniqueOrThrow({ where: { id } });
    if (!(await recordUpdateContext(tx, 'LEAD', row.leadId)).canRead(auth.actor)) throw new Error('NEWSLETTER_RECIPIENT_DENIED');
    if (row.state !== 'PENDING') return;
    const now = await auth.finish();
    await tx.workflowNewsletterRecipient.update({ where: { id }, data: { state: 'BLOCKED', policySnapshot: json({ decision, ticket }),
      history: history(row.history, { event: 'BLOCKED', reason: decision.reason, at: now.toISOString() }) } });
  });
}

/** The same durable claim/reconciliation path is used by synthetic qualification
 * and a future authorized transport. A SENDING row after a lost process is an
 * uncertain attempt, never authority to invoke the adapter again. */
export async function executeWorkflowNewsletter(db: PrismaClient, session: AuthSession, raw: unknown, runtime: NewsletterRuntime) {
  const input = z.object({ runId: z.string().uuid(), now: z.string().datetime({ offset: true }).optional() }).strict().parse(raw);
  await runtimeAllowed(db, runtime.synthetic);
  const run = await transaction(db, async tx => {
    const auth = await admin(tx, session), row = await tx.workflowNewsletterRun.findUniqueOrThrow({ where: { id: input.runId } });
    if (row.synthetic !== runtime.synthetic) throw new Error('NEWSLETTER_RUNTIME_MISMATCH');
    const currentRule = await tx.workflowAutomation.findUnique({ where: { id: row.automationId } });
    if (currentRule?.state !== (runtime.synthetic ? 'TEST_READY' : 'ACTIVE')) throw new Error('NEWSLETTER_RULE_PAUSED');
    const configuration = z.object({ qualificationReference: z.string(), policyReference: z.string(), unsubscribeUrl: z.string() }).passthrough().parse(row.snapshot);
    if (configuration.qualificationReference !== runtime.qualificationReference || configuration.policyReference !== runtime.policyReference || configuration.unsubscribeUrl !== runtime.unsubscribeUrl)
      throw new Error('NEWSLETTER_RUNTIME_CHANGED');
    const clock = await auth.finish();
    if (row.scheduledAt > (runtime.synthetic && input.now ? new Date(input.now) : clock)) throw new Error('NEWSLETTER_NOT_DUE');
    return row;
  });
  const recipients = await db.workflowNewsletterRecipient.findMany({ where: { runId: run.id }, orderBy: { id: 'asc' } });
  let executed = 0;
  for (const candidate of recipients) {
    if (candidate.state !== 'PENDING') continue;
    const snapshot = recipientSnapshot.parse(candidate.snapshot);
    const selected = await runtime.preferences.select(snapshot.email);
    if (!selected.decision.eligible || !selected.ticket) { await recordBlocked(db, session, candidate.id, selected.decision); continue; }
    const handoff = await runtime.preferences.atFinalHandoff(snapshot.email, selected.ticket, async () => {
      const claimed = await transaction(db, async tx => {
        const auth = await admin(tx, session);
        const context = await recordUpdateContext(tx, 'LEAD', candidate.leadId, true);
        if (!context.canRead(auth.actor)) throw new Error('NEWSLETTER_RECIPIENT_DENIED');
        const lead = await tx.lead.findUniqueOrThrow({ where: { id: candidate.leadId } });
        if (snapshot.email !== lead.email?.trim().toLowerCase() || snapshot.firstName !== lead.firstName || snapshot.companyName !== (lead.companyName ?? ''))
          throw new Error('NEWSLETTER_RECIPIENT_CHANGED');
        await tx.$queryRaw`SELECT id FROM "WorkflowNewsletterRecipient" WHERE id=${candidate.id}::uuid FOR UPDATE`;
        const row = await tx.workflowNewsletterRecipient.findUniqueOrThrow({ where: { id: candidate.id } });
        if (row.state !== 'PENDING') { await auth.finish(); return null; }
        const now = await auth.finish();
        return tx.workflowNewsletterRecipient.update({ where: { id: row.id, state: 'PENDING' }, data: { state: 'SENDING', attemptCount: row.attemptCount + 1,
          policySnapshot: json({ decision: selected.decision, ticket: selected.ticket, qualificationReference: runtime.qualificationReference, policyReference: runtime.policyReference }),
          history: history(row.history, { event: 'CLAIMED', at: now.toISOString(), requestKey: row.requestKey }) } });
      });
      if (!claimed) return false;
      let result: NewsletterTransportResult;
      try { result = await runtime.transport({ requestKey: claimed.requestKey,
        attemptKey: canonicalSha256({ requestKey: claimed.requestKey, attempt: claimed.attemptCount }), attempt: claimed.attemptCount,
        recipient: snapshot.email, subject: snapshot.rendered.subject, body: snapshot.rendered.body }); }
      catch { result = { outcome: 'UNCERTAIN', evidence: 'TRANSPORT_OUTCOME_UNCERTAIN', delivered: false }; }
      result = z.object({ outcome: z.enum(['SENT', 'ERROR', 'UNCERTAIN']), evidence: z.string().min(1).max(500), delivered: z.literal(false) }).strict().parse(result);
      await transaction(db, async tx => {
        const auth = await admin(tx, session);
        await tx.$queryRaw`SELECT id FROM "WorkflowNewsletterRecipient" WHERE id=${claimed.id}::uuid FOR UPDATE`;
        const current = await tx.workflowNewsletterRecipient.findUniqueOrThrow({ where: { id: claimed.id } });
        if (current.state !== 'SENDING') throw new Error('NEWSLETTER_ATTEMPT_CONFLICT');
        const now = await auth.finish(), receipt = { id: canonicalSha256({ requestKey: claimed.requestKey, attempt: claimed.attemptCount }),
          synthetic: runtime.synthetic, ...result, at: now.toISOString(), requestKey: claimed.requestKey };
        await tx.workflowNewsletterRecipient.update({ where: { id: claimed.id }, data: { state: result.outcome, receipt,
          history: history(current.history, { event: result.outcome, receiptId: receipt.id, receipt, at: now.toISOString() }) } });
        await auth.finish();
      });
      return true;
    });
    if (!handoff.admitted) await recordBlocked(db, session, candidate.id, { reason: handoff.reason }, selected.ticket);
    else if (handoff.value) executed++;
  }
  await transaction(db, async tx => {
    const auth = await admin(tx, session);
    const states = await tx.workflowNewsletterRecipient.findMany({ where: { runId: run.id }, select: { state: true } });
    const state = runState(states);
    await tx.workflowNewsletterRun.update({ where: { id: run.id }, data: { state } }); await auth.finish();
  });
  return { runId: run.id, executed };
}

export async function reconcileWorkflowNewsletterRecipient(db: PrismaClient, session: AuthSession, raw: unknown) {
  const input = z.object({ id: z.string().uuid(), outcome: z.enum(['SENT', 'NOT_SENT']), evidence: z.string().trim().min(5).max(500) }).strict().parse(raw);
  return transaction(db, async tx => {
    const auth = await admin(tx, session);
    await tx.$queryRaw`SELECT id FROM "WorkflowNewsletterRecipient" WHERE id=${input.id}::uuid FOR UPDATE`;
    const row = await tx.workflowNewsletterRecipient.findUniqueOrThrow({ where: { id: input.id }, include: { run: true } });
    if (!row.run.synthetic) throw new Error('NEWSLETTER_NATIVE_RECONCILIATION_REQUIRED');
    if (!(await recordUpdateContext(tx, 'LEAD', row.leadId)).canRead(auth.actor)) throw new Error('NEWSLETTER_DENIED');
    const previous = Array.isArray(row.history) && row.history.some(item => typeof item === 'object' && item !== null && !Array.isArray(item)
      && item.event === 'RECONCILED_' + input.outcome && item.evidence === input.evidence);
    if (previous) { await auth.finish(); return { state: row.state }; }
    if (!['SENDING', 'UNCERTAIN'].includes(row.state)) throw new Error('NEWSLETTER_RECONCILIATION_INVALID');
    const now = await auth.finish(), state = input.outcome === 'SENT' ? 'SENT' : 'PENDING';
    await tx.workflowNewsletterRecipient.update({ where: { id: row.id }, data: { state,
      history: history(row.history, { event: 'RECONCILED_' + input.outcome, evidence: input.evidence, at: now.toISOString() }) } });
    const states = await tx.workflowNewsletterRecipient.findMany({ where: { runId: row.runId }, select: { state: true } });
    await tx.workflowNewsletterRun.update({ where: { id: row.runId }, data: { state: runState(states) } });
    await auth.finish(); return { state };
  });
}

export function syntheticNewsletterTransport(outcome: NewsletterTransportResult['outcome'] = 'SENT'): NewsletterRuntime['transport'] {
  return async request => ({ outcome, evidence: 'DATABASE_TEST_OUTBOX:' + request.attemptKey, delivered: false });
}
