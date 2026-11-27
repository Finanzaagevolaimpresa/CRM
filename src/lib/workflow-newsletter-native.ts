import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { AuthSession } from './auth';
import { updateActor } from './record-updates';
import { recordUpdateContext, recordUpdatePermission } from './record-update-context';
import { MarketingPreferences } from './marketing-preferences/service';
import { PostgresPreferenceStore } from './marketing-preferences/postgres-store';
import { planWorkflowNewsletter, type NewsletterRuntime } from './workflow-newsletters';
import { readNativeNewsletterPolicy, type NativeNewsletterPolicySource } from './workflow-newsletter-policy';
import { lockNativeNewsletterPreference, nativeNewsletterQualification } from './workflow-newsletter-admission';
import { readAdmittedOrdinaryEmailReceipts } from './ordinary-email-receipt-reader';
import { withSerializableTransaction } from './serializable';

const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value));
const denied = () => new Error('NEWSLETTER_NATIVE_DENIED');
function enabled() { if (process.env.WORKFLOW_NATIVE_PREPARATION_MODE !== 'enabled') throw denied(); }
async function admin(tx: Prisma.TransactionClient, session: AuthSession) {
  const auth = await updateActor(tx, session);
  if (auth.actor.role !== 'admin' || !recordUpdatePermission(auth.actor, 'lead.read')
    || !recordUpdatePermission(auth.actor, 'practice_communications.write')) throw denied();
  return auth;
}
const history = (value: Prisma.JsonValue, entry: unknown) => {
  if (!Array.isArray(value)) throw denied(); return json([...value, entry]);
};

export async function planNativeWorkflowNewsletter(db: PrismaClient, session: AuthSession, input: unknown,
  source: NativeNewsletterPolicySource = readNativeNewsletterPolicy) {
  enabled();
  const [row] = await db.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
  const policy = await source(row.now);
  // This runtime can plan only. There is deliberately no generic marketing
  // transport or withFinalHandoff on the PostgreSQL preference store.
  const runtime: NewsletterRuntime = { synthetic: false, unsubscribeUrl: policy.unsubscribeUrl,
    qualificationReference: nativeNewsletterQualification(policy.bindingHash), policyReference: policy.policyReference,
    preferences: new MarketingPreferences(new PostgresPreferenceStore(db), policy.key, async () => {
      const current = await source(new Date()); return current.bindingHash === policy.bindingHash ? current.readiness : null;
    }), transport: async () => { throw new Error('NEWSLETTER_NATIVE_SMTP_REQUIRED'); } };
  return planWorkflowNewsletter(db, session, input, runtime);
}

/** Preparation is reversible DB work. A published template is never evidence
 * that this recipient's exact native message has been approved or sent. */
export async function prepareNativeWorkflowNewsletter(db: PrismaClient, session: AuthSession, raw: unknown,
  source: NativeNewsletterPolicySource = readNativeNewsletterPolicy) {
  enabled();
  const input = z.object({ runId: z.string().uuid(), mailboxId: z.string().uuid(), replyTo: z.string().email() }).strict().parse(raw);
  const ids = await db.$transaction(async tx => {
    const auth = await admin(tx, session), run = await tx.workflowNewsletterRun.findUniqueOrThrow({ where: { id: input.runId } });
    if (run.synthetic || run.scheduledAt > await auth.finish()) throw denied();
    const authority = await tx.ordinaryEmailAuthority.findUnique({ where: { id: 'ordinary-email' } });
    if (!authority?.enabled || authority.userId !== auth.actor.id || authority.mailboxId !== input.mailboxId) throw denied();
    const rows = await tx.workflowNewsletterRecipient.findMany({ where: { runId: run.id }, select: { id: true, state: true } });
    await auth.finish(); return rows;
  });
  let prepared = 0;
  for (const candidate of ids) {
    if (['PREPARED','UNCERTAIN'].includes(candidate.state)) {
      await reconcileNativeNewsletterRecipient(db, session, candidate.id); continue;
    }
    if (candidate.state !== 'PENDING') continue;
    prepared += await withSerializableTransaction(db, async tx => {
      const auth = await admin(tx, session);
      const initial = await tx.workflowNewsletterRecipient.findUniqueOrThrow({ where: { id: candidate.id } });
      const context = await recordUpdateContext(tx, 'LEAD', initial.leadId, true);
      if (!context.canRead(auth.actor)) throw denied();
      await tx.$queryRaw`SELECT id FROM "WorkflowNewsletterRecipient" WHERE id=${initial.id}::uuid FOR UPDATE`;
      const row = await tx.workflowNewsletterRecipient.findUniqueOrThrow({ where: { id: initial.id }, include: { run: { include: { automation: true } }, lead: true } });
      if (row.state !== 'PENDING') { await auth.finish(); return 0; }
      if (row.run.synthetic || row.run.automation.state !== 'ACTIVE') throw denied();
      const config = z.object({ qualificationReference: z.string(), unsubscribeUrl: z.string() }).passthrough().parse(row.run.snapshot);
      const snapshot = z.object({ email: z.string().email(), firstName: z.string(), companyName: z.string(),
        rendered: z.object({ ok: z.literal(true), subject: z.string(), body: z.string(), hash: z.string() }) }).passthrough().parse(row.snapshot);
      if (snapshot.email !== row.lead.email?.trim().toLowerCase() || snapshot.firstName !== row.lead.firstName
        || snapshot.companyName !== (row.lead.companyName ?? '')) throw denied();
      const check = await lockNativeNewsletterPreference(tx, snapshot.email, config.qualificationReference, source);
      const policySnapshot = await check();
      const { saveApprovedMessageDraftInTransaction } = await import('./approved-communications');
      const draft = await saveApprovedMessageDraftInTransaction(tx, session, { messageId: row.id, expectedRevision: 0,
        context: { kind: 'LEAD', id: row.leadId }, mailboxId: input.mailboxId, replyTo: input.replyTo,
        to: [snapshot.email], cc: [], bcc: [], subject: snapshot.rendered.subject, body: snapshot.rendered.body,
        attachmentVersionIds: [], classification: 'ORDINARY' });
      await tx.workflowNewsletterRecipient.update({ where: { id: row.id }, data: { state: 'PREPARED',
        nativeMessageId: draft.id, nativeRevision: draft.revision, nativeSnapshotHash: draft.snapshotHash,
        policySnapshot: json(policySnapshot), receipt: { channel: 'NATIVE_EMAIL_DRAFT', sent: false },
        history: history(row.history, { event: 'NATIVE_DRAFT_PREPARED', messageId: draft.id, revision: draft.revision,
          snapshotHash: draft.snapshotHash, at: (await auth.finish()).toISOString() }) } });
      await check(); await auth.finish(); return 1;
    });
  }
  return { prepared, examined: ids.length, providerCalls: 0 as const };
}

/** Only admitted native SMTP receipts for the immutable revision can change
 * PREPARED into SENT. Missing/uncertain evidence never permits another send. */
export async function reconcileNativeNewsletterRecipient(db: PrismaClient, session: AuthSession, recipientId: string) {
  enabled(); z.string().uuid().parse(recipientId);
  return db.$transaction(async tx => {
    const auth = await admin(tx, session), initial = await tx.workflowNewsletterRecipient.findUniqueOrThrow({ where: { id: recipientId } });
    if (!(await recordUpdateContext(tx, 'LEAD', initial.leadId, true)).canRead(auth.actor)) throw denied();
    await tx.$queryRaw`SELECT id FROM "WorkflowNewsletterRecipient" WHERE id=${initial.id}::uuid FOR UPDATE`;
    const row = await tx.workflowNewsletterRecipient.findUniqueOrThrow({ where: { id: initial.id }, include: { run: true } });
    if (row.run.synthetic || !row.nativeMessageId || !row.nativeRevision || !row.nativeSnapshotHash) throw denied();
    if (row.state === 'SENT') { await auth.finish(); return { state: row.state, reconciled: true }; }
    const receipts = await readAdmittedOrdinaryEmailReceipts(tx, row.nativeMessageId);
    const receipt = receipts.find(item => item.revision === row.nativeRevision && item.snapshotHash === row.nativeSnapshotHash);
    if (!receipt) { await auth.finish(); return { state: row.state, reconciled: false }; }
    const state = receipt.outcome === 'ACCEPTED' ? 'SENT' : receipt.outcome === 'UNCERTAIN' ? 'UNCERTAIN' : 'ERROR';
    if (row.state !== state) await tx.workflowNewsletterRecipient.update({ where: { id: row.id }, data: { state,
      attemptCount: Math.max(row.attemptCount, 1), receipt: json({ channel: 'NATIVE_SMTP', attemptId: receipt.id,
        outcome: receipt.outcome, delivered: false, revision: row.nativeRevision, snapshotHash: row.nativeSnapshotHash }),
      history: history(row.history, { event: 'NATIVE_' + state, attemptId: receipt.id, at: (await auth.finish()).toISOString(), delivered: false }) } });
    const recipients = await tx.workflowNewsletterRecipient.findMany({ where: { runId: row.runId }, select: { state: true } });
    const runState = recipients.some(item => ['SENDING','UNCERTAIN'].includes(item.state)) ? 'UNCERTAIN'
      : recipients.some(item => ['PENDING','PREPARED'].includes(item.state)) ? 'PENDING' : 'COMPLETED';
    if (row.run.state !== runState) await tx.workflowNewsletterRun.update({ where: { id: row.runId }, data: { state: runState } });
    await auth.finish(); return { state, reconciled: true };
  });
}
