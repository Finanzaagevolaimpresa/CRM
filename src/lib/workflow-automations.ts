import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { AuthSession } from './auth';
import { canonicalSha256 } from './canonical-json';
import { updateActor, type UpdateCredentials } from './record-updates';
import { recordUpdatePermission } from './record-update-context';
import { leadVisibilityWhere } from './core-query-policy';
import { readNativeNewsletterPolicy } from './workflow-newsletter-policy';
import {
  SyntheticWorkflowRun, workflowConfiguration, workflowRuleInput, workflowTemplateInput,
  type WorkflowRule, type WorkflowTemplate, type SyntheticWorkflowEvent,
} from './workflow-automation-contract';

type Db = Pick<PrismaClient, '$transaction'>;
type Tx = Prisma.TransactionClient;
async function admin(tx: Tx, session: AuthSession, credentials?: UpdateCredentials) {
  const auth = await updateActor(tx, session, credentials);
  if (auth.actor.role !== 'admin' || !recordUpdatePermission(auth.actor, 'practice_communications.write') || !recordUpdatePermission(auth.actor, 'lead.read'))
    throw new Error('WORKFLOW_DENIED');
  return auth;
}
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

export async function readWorkflowAdministration(db: Db, session: AuthSession) {
  return db.$transaction(async tx => {
    const auth = await admin(tx, session);
    const [templates, rules, tests, people, newsletterRuns, mailboxes, holds] = await Promise.all([
      tx.workflowEmailTemplate.findMany({ orderBy: [{ familyId: 'asc' }, { version: 'desc' }], take: 500 }),
      tx.workflowAutomation.findMany({ orderBy: { updatedAt: 'desc' }, take: 100 }),
      tx.workflowAutomationTest.findMany({ orderBy: { createdAt: 'desc' }, take: 100 }),
      tx.lead.findMany({ where: { deletedAt: null, email: { not: null }, AND: [leadVisibilityWhere(auth.actor)] },
        select: { id: true, firstName: true, lastName: true, companyName: true }, orderBy: { createdAt: 'desc' }, take: 500 }),
      tx.workflowNewsletterRun.findMany({ orderBy: { createdAt: 'desc' }, take: 100,
        select: { id: true, automationId: true, automationVersion: true, synthetic: true, state: true, scheduledAt: true, createdAt: true,
          recipients: { where: { lead: { deletedAt: null, AND: [leadVisibilityWhere(auth.actor)] } },
            select: { id: true, state: true, attemptCount: true, policySnapshot: true, nativeMessageId: true,
              lead: { select: { companyName: true, firstName: true, lastName: true } } } } } }),
      tx.communicationMailbox.findMany({ where: { canSend: true, restricted: false }, select: { id: true, address: true }, orderBy: { address: 'asc' } }),
      tx.auditLog.findMany({ where: { event: { in: ['workflow_capture_held', 'workflow_preparation_held'] } }, select: { id: true, event: true, entityType: true, after: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 100 }),
    ]);
    let nativeNewsletterReady = false;
    try {
      const policy = await readNativeNewsletterPolicy(await auth.finish());
      const epochs = await tx.$queryRaw<Array<{ epoch: string }>>`SELECT epoch FROM "MarketingPreferenceEpoch" WHERE singleton=true AND reconciled=true`;
      nativeNewsletterReady = epochs[0]?.epoch === policy.readiness.epoch;
    } catch { /* Optional capability stays unavailable; no credentials leave the server. */ }
    await auth.finish();
    return { templates, rules: rules.map(rule => ({ ...rule, configuration: workflowConfiguration.parse(rule.configuration) })), tests, people, newsletterRuns, mailboxes, holds, nativeNewsletterReady };
  }, { timeout: 30_000 });
}

export async function saveWorkflowTemplate(db: Db, session: AuthSession, raw: unknown, proof: UpdateCredentials) {
  const input = workflowTemplateInput.parse(raw);
  return db.$transaction(async tx => {
    const auth = await admin(tx, session, proof);
    const latest = await tx.workflowEmailTemplate.findFirst({ where: { familyId: input.familyId }, orderBy: { version: 'desc' } });
    if ((latest?.version ?? 0) !== input.expectedVersion) throw new Error('WORKFLOW_STALE');
    const row = await tx.workflowEmailTemplate.create({ data: { id: input.id, familyId: input.familyId,
      version: input.expectedVersion + 1, name: input.name, purpose: input.purpose, subject: input.subject, body: input.body,
      state: input.state, authorizationReference: input.authorizationReference || null, createdById: auth.actor.id } });
    await tx.auditLog.create({ data: { actorId: auth.actor.id, entityType: 'WorkflowEmailTemplate', entityId: row.id,
      event: 'workflow_template_version_saved', after: { familyId: row.familyId, version: row.version, state: row.state,
        contentHash: canonicalSha256({ subject: row.subject, body: row.body }), authorizationReference: row.authorizationReference } } });
    await auth.finish(); return { id: row.id, version: row.version };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 });
}

export function validateTemplatePurpose(rule: WorkflowRule, templates: readonly WorkflowTemplate[]) {
  const expected = rule.configuration.kind === 'NEWSLETTER' ? 'NEWSLETTER' : rule.configuration.action === 'INTERNAL_NOTICE' ? 'INTERNAL_NOTICE'
    : rule.event === 'APPOINTMENT_BOOKED' ? 'APPOINTMENT' : rule.event === 'DOCUMENT_REQUESTED' ? 'DOCUMENT_REQUEST' : 'CONFIRMATION';
  const confirmation = templates.find(row => row.id === rule.configuration.confirmationTemplateId);
  const followup = templates.find(row => row.id === rule.configuration.followupTemplateId);
  const subsequentPurpose = rule.configuration.action === 'INTERNAL_NOTICE' ? 'INTERNAL_NOTICE' : rule.event === 'APPOINTMENT_BOOKED' ? 'APPOINTMENT' : 'FOLLOW_UP';
  if (!confirmation || confirmation.purpose !== expected || (rule.configuration.followupTemplateId && followup?.purpose !== subsequentPurpose))
    throw new Error('WORKFLOW_TEMPLATE_PURPOSE_MISMATCH');
  if (rule.state !== 'DRAFT' && [confirmation, ...(followup ? [followup] : [])]
    .some(row => row.state !== 'PUBLISHED' || !row.authorizationReference)) throw new Error('WORKFLOW_TEMPLATE_NOT_APPROVED');
}

export async function saveWorkflowRule(db: Db, session: AuthSession, raw: unknown, proof: UpdateCredentials) {
  const input = workflowRuleInput.parse(raw);
  if (input.state === 'ACTIVE' && process.env.WORKFLOW_NATIVE_PREPARATION_MODE !== 'enabled') throw new Error('WORKFLOW_NATIVE_PREPARATION_DISABLED');
  return db.$transaction(async tx => {
    const auth = await admin(tx, session, proof);
    const templates = await tx.workflowEmailTemplate.findMany({ where: {
      id: { in: [input.configuration.confirmationTemplateId, ...(input.configuration.followupTemplateId ? [input.configuration.followupTemplateId] : [])] },
    } });
    validateTemplatePurpose(input, templates as WorkflowTemplate[]);
    if (input.configuration.recipientIds.length) {
      const requested = [...new Set(input.configuration.recipientIds)];
      const available = await tx.lead.count({ where: { id: { in: requested }, deletedAt: null,
        email: { not: null }, AND: [leadVisibilityWhere(auth.actor)] } });
      if (available !== requested.length) throw new Error('WORKFLOW_RECIPIENT_DENIED');
    }
    const existing = await tx.workflowAutomation.findUnique({ where: { id: input.id } });
    if ((existing?.version ?? 0) !== input.expectedVersion) throw new Error('WORKFLOW_STALE');
    const data = { name: input.name, event: input.event, state: input.state, delayMinutes: input.delayMinutes,
      configuration: json(input.configuration), version: input.expectedVersion + 1 };
    const row = existing
      ? await tx.workflowAutomation.update({ where: { id: input.id, version: input.expectedVersion }, data })
      : await tx.workflowAutomation.create({ data: { id: input.id, ...data, createdById: auth.actor.id } });
    await tx.auditLog.create({ data: { actorId: auth.actor.id, entityType: 'WorkflowAutomation', entityId: row.id,
      event: 'workflow_rule_saved', before: existing ? json(existing) : Prisma.JsonNull,
      after: { ...data, liveDispatch: false } } });
    await auth.finish(); return { id: row.id, version: row.version };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 });
}

export function qualifyWorkflow(rule: WorkflowRule, templates: readonly WorkflowTemplate[]) {
  const event: SyntheticWorkflowEvent = { id: 'synthetic-event-1', leadId: 'synthetic-lead-1', receiptId: 'synthetic-receipt-1',
    kind: rule.event, associated: true, occurredAt: '2026-11-26T09:00:00.000Z',
    fields: { firstName: 'Persona sintetica', companyName: 'Impresa di prova', appointmentAt: '27/11/2026 10:00 Europe/Rome',
      documentList: 'Documento sintetico', unsubscribeUrl: 'https://example.test/preferences/withdraw' }, marketingEligible: true };
  // Fixed virtual time keeps all checks isolated from the machine clock and a
  // future scheduled newsletter. No selected real recipient is instantiated.
  const start = rule.configuration.newsletterAt ?? event.occurredAt;
  const end = new Date(new Date(start).getTime() + rule.delayMinutes * 60_000 + 1000).toISOString();
  const make = () => new SyntheticWorkflowRun(rule, templates);
  const baseline = make(); baseline.ingest(event); baseline.runDue(start); baseline.runDue(start);
  const oneConfirmation = baseline.receipts.length === 1;
  const replay = baseline.ingest(event); baseline.runDue(end); baseline.runDue(end);
  const expectedJobs = rule.configuration.followupTemplateId ? 2 : 1;
  const stoppedReply = make(); stoppedReply.ingest(event); stoppedReply.runDue(start);
  stoppedReply.observe(event.id, 'REPLIED', start, 'synthetic-reply'); stoppedReply.runDue(end);
  const stoppedAppointment = make(); stoppedAppointment.ingest(event); stoppedAppointment.runDue(start);
  stoppedAppointment.observe(event.id, 'APPOINTMENT_BOOKED', start, 'synthetic-appointment'); stoppedAppointment.runDue(end);
  const uncertain = make(); uncertain.ingest(event); uncertain.runDue(start, 'UNCERTAIN'); uncertain.runDue(end);
  const uncertainBlocked = uncertain.receipts.length === 1 && uncertain.jobs[0]?.state === 'UNCERTAIN';
  if (uncertain.jobs[0]?.state === 'UNCERTAIN') uncertain.reconcile(uncertain.jobs[0].key, 'ACCEPTED', end, 'synthetic-reconciliation');
  uncertain.runDue(end);
  const held = make(); const heldResult = held.ingest({ ...event, associated: false }); held.runDue(end);
  const newsletter = make(); newsletter.ingest({ ...event, marketingEligible: false }); newsletter.runDue(end);
  const unsubscribed = make(); unsubscribed.ingest(event); unsubscribed.observe(event.id, 'UNSUBSCRIBED', start, 'synthetic-withdrawal'); unsubscribed.runDue(end);
  const cases = [
    { name: 'Conferma una sola volta', passed: oneConfirmation },
    { name: 'Evento ripetuto senza doppio invio', passed: replay === 'REPLAY' && baseline.receipts.length === expectedJobs },
    { name: 'Stop sollecito alla risposta', passed: stoppedReply.receipts.length === 1 },
    { name: 'Stop sollecito all’appuntamento', passed: stoppedAppointment.receipts.length === 1 },
    { name: 'Esito incerto prima della riconciliazione', passed: uncertainBlocked },
    { name: 'Nessun reinvio dopo riconciliazione positiva', passed: uncertain.receipts.filter(row => row.jobKey === uncertain.jobs[0]?.key).length === 1 },
    { name: 'Identità in revisione esclusa', passed: heldResult === 'HELD' && held.receipts.length === 0 },
    { name: 'Disiscrizione rispettata', passed: unsubscribed.receipts.length === 0 },
    ...(rule.configuration.kind === 'NEWSLETTER' ? [{ name: 'Preferenze marketing prima dell’invio', passed: newsletter.receipts.length === 0 }] : []),
  ];
  return { protocol: 'FAI_WORKFLOW_SYNTHETIC_QUALIFICATION_V1', synthetic: true, liveMessagesSent: 0,
    sourceHash: canonicalSha256(json({ rule, templates })), passed: cases.every(value => value.passed), cases,
    jobs: baseline.jobs, receipts: baseline.receipts, log: baseline.log };
}

export async function testWorkflowRule(db: Db, session: AuthSession, raw: unknown) {
  const input = z.object({ id: z.string().uuid(), expectedVersion: z.number().int().positive() }).strict().parse(raw);
  return db.$transaction(async tx => {
    const auth = await admin(tx, session);
    const row = await tx.workflowAutomation.findUnique({ where: { id: input.id } });
    if (!row || row.version !== input.expectedVersion) throw new Error('WORKFLOW_STALE');
    const rule = workflowRuleInput.parse({ id: row.id, expectedVersion: row.version, name: row.name, event: row.event,
      state: row.state, delayMinutes: row.delayMinutes, configuration: row.configuration });
    const templates = await tx.workflowEmailTemplate.findMany({ where: {
      id: { in: [rule.configuration.confirmationTemplateId, ...(rule.configuration.followupTemplateId ? [rule.configuration.followupTemplateId] : [])] },
    } });
    validateTemplatePurpose(rule, templates as WorkflowTemplate[]);
    const result = qualifyWorkflow(rule, templates as WorkflowTemplate[]);
    const test = await tx.workflowAutomationTest.create({ data: { id: randomUUID(), automationId: row.id, automationVersion: row.version,
      result: json(result), performedById: auth.actor.id } });
    await auth.finish(); return { id: test.id, passed: result.passed };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 });
}
