import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { currentPreference, emailContactKey, eventSchema } from './marketing-preferences/policy';
import { readNativeNewsletterPolicy, type NativeNewsletterPolicySource } from './workflow-newsletter-policy';

type Tx = Prisma.TransactionClient;
const denied = () => new Error('NEWSLETTER_NATIVE_ADMISSION_DENIED');
export const nativeNewsletterQualification = (hash: string) => 'native-newsletter:' + hash;

async function nativeNewsletterTablesPresent(tx: Tx) {
  const [tables] = await tx.$queryRaw<Array<{ count: number }>>`SELECT count(*)::integer AS count FROM
    (VALUES (to_regclass(format('%I.%I',current_schema(),'WorkflowAutomation'))),
      (to_regclass(format('%I.%I',current_schema(),'WorkflowNewsletterRun'))),
      (to_regclass(format('%I.%I',current_schema(),'WorkflowNewsletterRecipient')))) relations(value) WHERE value IS NOT NULL`;
  if (tables.count === 0) return false;
  if (tables.count !== 3) throw new Error('NEWSLETTER_PERSISTENCE_INCOMPLETE');
  const [columns] = await tx.$queryRaw<Array<{ count: number }>>`SELECT count(*)::integer AS count FROM pg_attribute
    WHERE attrelid=to_regclass(format('%I.%I',current_schema(),'WorkflowNewsletterRecipient')) AND NOT attisdropped
      AND attname IN ('nativeMessageId','nativeRevision','nativeSnapshotHash')`;
  if (columns.count !== 3) throw new Error('NEWSLETTER_PERSISTENCE_INCOMPLETE');
  return true;
}

/** No generic external handoff is added to PostgresPreferenceStore. This lock
 * is used only in the bounded native SMTP authorization transaction, which
 * holds it through DATA and invokes the returned check again after 354. */
export async function lockNativeNewsletterPreference(tx: Tx, email: string, qualificationReference: string,
  source: NativeNewsletterPolicySource = readNativeNewsletterPolicy) {
  const clock = async () => (await tx.$queryRaw<Array<{ now: Date }>>`SELECT date_trunc('milliseconds',clock_timestamp()) AS now`)[0].now;
  const initial = await source(await clock()), contactKey = emailContactKey(email, initial.key);
  if (qualificationReference !== nativeNewsletterQualification(initial.bindingHash)) throw denied();
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${contactKey},1300))`;
  const subjects = await tx.$queryRaw<Array<{ revision: number; quarantined: boolean }>>`
    SELECT revision,quarantined FROM "MarketingPreferenceSubject" WHERE "contactKey"=${contactKey} FOR UPDATE`;
  const epochs = await tx.$queryRaw<Array<{ epoch: string }>>`SELECT epoch FROM "MarketingPreferenceEpoch" WHERE singleton=true AND reconciled=true FOR SHARE`;
  if (!subjects[0] || !epochs[0]) throw denied();
  const check = async () => {
    if (process.env.WORKFLOW_NATIVE_PREPARATION_MODE !== 'enabled') throw denied();
    const now = await clock(), policy = await source(now);
    if (policy.bindingHash !== initial.bindingHash || emailContactKey(email, policy.key) !== contactKey
      || policy.readiness.epoch !== epochs[0].epoch) throw denied();
    const rows = await tx.$queryRaw<Array<{ payload: unknown; eventHash: string; recordedAt: Date }>>`
      SELECT payload,"eventHash","recordedAt" FROM "MarketingPreferenceEvent" WHERE "contactKey"=${contactKey}`;
    const decision = currentPreference({ contactKey, ...subjects[0], epoch: epochs[0].epoch,
      events: rows.map(row => ({ ...eventSchema.parse(row.payload), eventHash: row.eventHash, recordedAt: row.recordedAt.toISOString() })) },
    policy.readiness, now.toISOString());
    if (!decision.eligible) throw denied();
    return { decision, epoch: epochs[0].epoch, keyFingerprint: policy.readiness.keyFingerprint,
      approvalReference: policy.policyReference, qualificationReference, checkedAt: now.toISOString() };
  };
  await check(); return check;
}

export async function assertNewsletterMessageAction(tx: Tx, input: { messageId: string; revision: number; snapshotHash: string; edit?: boolean },
  source: NativeNewsletterPolicySource = readNativeNewsletterPolicy) {
  if (!await nativeNewsletterTablesPresent(tx)) return null;
  const row = await tx.workflowNewsletterRecipient.findUnique({ where: { nativeMessageId: input.messageId }, include: { run: { include: { automation: true } }, lead: true } });
  if (!row) return null;
  if (input.edit || process.env.WORKFLOW_NATIVE_PREPARATION_MODE !== 'enabled' || row.run.synthetic || row.state !== 'PREPARED'
    || row.nativeRevision !== input.revision || row.nativeSnapshotHash !== input.snapshotHash || row.run.automation.state !== 'ACTIVE'
    || row.lead.deletedAt) throw denied();
  const snapshot = z.object({ email: z.string().email(), firstName: z.string(), companyName: z.string() }).passthrough().parse(row.snapshot);
  if (snapshot.email !== row.lead.email?.trim().toLowerCase() || snapshot.firstName !== row.lead.firstName
    || snapshot.companyName !== (row.lead.companyName ?? '')) throw denied();
  const config = z.object({ qualificationReference: z.string() }).passthrough().parse(row.run.snapshot);
  return lockNativeNewsletterPreference(tx, snapshot.email, config.qualificationReference, source);
}

/** A manually exported message cannot preserve a marketing withdrawal fence.
 * Its exact approval remains available; submission must use native SMTP. */
export async function denyManualNewsletterTransport(tx: Tx, messageId: string) {
  if (!await nativeNewsletterTablesPresent(tx)) return;
  if (await tx.workflowNewsletterRecipient.findUnique({ where: { nativeMessageId: messageId }, select: { id: true } }))
    throw new Error('NEWSLETTER_NATIVE_SMTP_REQUIRED');
}
