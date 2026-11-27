import { Prisma, type PrismaClient } from '@prisma/client';
import { constants, type Stats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import type { AuthSession } from './auth';
import { canonicalSha256 } from './canonical-json';
import { updateActor, type UpdateCredentials } from './record-updates';
import { currentRecordUpdateUser, recordUpdatePermission } from './record-update-context';
import { lockCommunicationDirectory } from './communication-directory-lock';
import { lockRegisteredPrivilegedStepUpKey } from './application-key-registry';
import type { PrivilegedStepUpKey } from './privileged-step-up-token';
import type { OrdinaryObservationSink } from './ordinary-email-observation';
import { ordinaryChannelSchema } from './ordinary-email-candidate';
import { workflowRuleInput, type WorkflowTemplate } from './workflow-automation-contract';
import { validateTemplatePurpose } from './workflow-automations';
import { readNativeNewsletterPolicy, type NativeNewsletterPolicySource } from './workflow-newsletter-policy';
import { serviceCredentialInput, serviceGrantInput, servicePolicySchema, serviceFingerprint,
  parseServiceInvocation, type ServiceCredentialMaterial, type ServiceInvocation } from './workflow-service-contract';

type Tx = Prisma.TransactionClient;
export const serviceJson = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
export function serviceDenied(): never { throw new Error('WORKFLOW_SERVICE_DENIED'); }
export function assertWorkflowServiceEnabled() {
  if (process.env.WORKFLOW_SERVICE_EXECUTION_MODE !== 'enabled' || process.env.WORKFLOW_NATIVE_PREPARATION_MODE !== 'enabled')
    throw new Error('WORKFLOW_SERVICE_DISABLED');
}
export async function serviceClock(tx: Tx) {
  return (await tx.$queryRaw<Array<{ now: Date }>>`SELECT date_trunc('milliseconds',clock_timestamp()) AS now`)[0].now;
}
export type WorkflowServiceRuntime = Readonly<{ credential: ServiceCredentialMaterial; nativeKey: PrivilegedStepUpKey;
  newsletterPolicySource?: NativeNewsletterPolicySource;
  observationSink?: OrdinaryObservationSink;
  /** Server composition, reread at every admission, including immediately before DATA. */
  assertCredentialCurrent: () => Promise<void> }>;

/** Dedicated unattended credential. No provisioning, env-secret fallback,
 * personal cookie or service-account impersonation is accepted. */
export async function readWorkflowServiceCredential(): Promise<ServiceCredentialMaterial> {
  assertWorkflowServiceEnabled();
  const path = process.env.WORKFLOW_SERVICE_KEY_FILE, id = z.string().uuid().parse(process.env.WORKFLOW_SERVICE_CREDENTIAL_ID);
  if (!path || !isAbsolute(path) || typeof process.getuid !== 'function' || await realpath(path) !== resolve(path)) serviceDenied();
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.uid !== process.getuid()
    || (before.mode & 0o777) !== 0o600 || before.size > 128 || before.size < 40) serviceDenied();
  const file = await open(path,constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const privateDescriptor = (stat: Stats) => stat.isFile() && stat.nlink === 1
      && stat.uid === process.getuid!() && (stat.mode & 0o777) === 0o600;
    const initial = await file.stat();
    if (!privateDescriptor(initial) || initial.dev !== before.dev || initial.ino !== before.ino || initial.ctimeMs !== before.ctimeMs) serviceDenied();
    const bytes = Buffer.alloc(129), read = await file.read(bytes,0,129,0), after = await file.stat();
    if (initial.dev !== before.dev || initial.ino !== before.ino || initial.size !== before.size || initial.mtimeMs !== before.mtimeMs
      || read.bytesRead !== initial.size || !privateDescriptor(after) || after.dev !== initial.dev || after.ino !== initial.ino
      || after.size !== initial.size || after.mtimeMs !== initial.mtimeMs || after.ctimeMs !== initial.ctimeMs) serviceDenied();
    const encoded = new TextDecoder('utf-8',{ fatal: true }).decode(bytes.subarray(0,read.bytesRead)).trim(), key = Buffer.from(encoded,'base64');
    if (key.length !== 32 || key.toString('base64') !== encoded) serviceDenied();
    return { id,key };
  } finally { await file.close(); }
}

async function currentNativeAuthority(tx: Tx, ownerId: string) {
  const [binding] = await tx.$queryRaw<Array<{ userId: string; mailboxId: string; revision: number; enabled: boolean }>>`
    SELECT "userId","mailboxId","revision","enabled" FROM "OrdinaryEmailAuthority" WHERE id='ordinary-email' FOR SHARE`;
  if (!binding?.enabled || binding.userId !== ownerId) serviceDenied();
  await tx.$queryRaw`SELECT id FROM "CommunicationMailbox" WHERE id=${binding.mailboxId}::uuid FOR SHARE`;
  const box = await tx.communicationMailbox.findUnique({ where: { id: binding.mailboxId } });
  const [qualified] = await tx.$queryRaw<Array<{ revision: number; mailboxRevision: number; enabled: boolean; qualificationReference: string }>>`
    SELECT revision,"mailboxRevision",enabled,"qualificationReference" FROM "OrdinaryEmailChannel" WHERE "mailboxId"=${binding.mailboxId}::uuid FOR SHARE`;
  if (!box || !box.canSend || box.restricted || box.kind !== 'MAILBOX' || box.canonicalMailboxId || !qualified?.enabled
    || qualified.mailboxRevision !== box.revision) serviceDenied();
  const channel = ordinaryChannelSchema.parse({ purpose: 'ORDINARY_SMTP',mailboxId: box.id,mailboxRevision: box.revision,address: box.address,
    providerReference: box.providerReference,configurationReference: box.configurationReference,
    channelRevision: qualified.revision,qualificationReference: qualified.qualificationReference });
  return { binding,box,channel };
}
function permission(actor: NonNullable<Awaited<ReturnType<typeof currentRecordUpdateUser>>>) {
  const required = ['lead.read','practice_communications.read','practice_communications.write','practice_communications.mark_used'] as const;
  if (actor.role !== 'admin' || !required.every(value => recordUpdatePermission(actor,value))) serviceDenied();
}
async function ruleAndTemplates(tx: Tx, automationId: string) {
  await tx.$queryRaw`SELECT id FROM "WorkflowAutomation" WHERE id=${automationId}::uuid FOR SHARE`;
  const row = await tx.workflowAutomation.findUniqueOrThrow({ where: { id: automationId } });
  const rule = workflowRuleInput.parse({ expectedVersion: row.version, id: row.id, name: row.name,event: row.event,
    state: row.state, delayMinutes: row.delayMinutes,configuration: row.configuration });
  if (row.state !== 'ACTIVE') serviceDenied();
  const templates = await tx.workflowEmailTemplate.findMany({ where: { id: { in: [rule.configuration.confirmationTemplateId,
    ...(rule.configuration.followupTemplateId ? [rule.configuration.followupTemplateId] : [])] } }, orderBy: { id: 'asc' } });
  validateTemplatePurpose(rule,templates as WorkflowTemplate[]);
  return { row,rule,templateHashes: templates.map(template => ({ id: template.id,version: template.version,
    hash: canonicalSha256({ purpose: template.purpose,subject: template.subject,body: template.body,authorizationReference: template.authorizationReference }) })) };
}

export async function registerWorkflowServiceCredential(db: PrismaClient, session: AuthSession, raw: unknown, proof: UpdateCredentials) {
  assertWorkflowServiceEnabled(); const input = serviceCredentialInput.parse(raw);
  return db.$transaction(async tx => {
    const auth = await updateActor(tx,session,proof); permission(auth.actor);
    await currentNativeAuthority(tx,auth.actor.id);
    const now = await auth.finish();
    if (Date.parse(input.validUntil) <= now.getTime() || Date.parse(input.validUntil) > now.getTime()+31*86400000) serviceDenied();
    const row = await tx.workflowServiceCredential.create({ data: { id: input.id,keyFingerprint: input.keyFingerprint,state: 'ACTIVE',
      validUntil: new Date(input.validUntil),qualificationReference: input.qualificationReference,createdById: auth.actor.id } });
    await tx.auditLog.create({ data: { actorId: auth.actor.id,entityType: 'WorkflowServiceCredential',entityId: row.id,
      event: 'workflow_service_credential_registered',after: { fingerprint: input.keyFingerprint,qualificationReference: input.qualificationReference,validUntil: input.validUntil } } });
    await auth.finish(); return { id: row.id };
  },{ timeout: 30000 });
}
export async function issueWorkflowServiceGrant(db: PrismaClient, session: AuthSession, raw: unknown, proof: UpdateCredentials,
  policySource: NativeNewsletterPolicySource = readNativeNewsletterPolicy) {
  assertWorkflowServiceEnabled(); const input = serviceGrantInput.parse(raw);
  return db.$transaction(async tx => {
    const auth = await updateActor(tx,session,proof); permission(auth.actor);
    const native = await currentNativeAuthority(tx,auth.actor.id), facts = await ruleAndTemplates(tx,input.automationId);
    await tx.$queryRaw`SELECT id FROM "WorkflowServiceCredential" WHERE id=${input.credentialId}::uuid FOR SHARE`;
    const credential = await tx.workflowServiceCredential.findUniqueOrThrow({ where: { id: input.credentialId } }), now = await auth.finish();
    const from = new Date(input.validFrom), until = new Date(input.validUntil);
    if (facts.row.version !== input.expectedVersion || facts.row.createdById !== auth.actor.id || credential.state !== 'ACTIVE'
      || credential.createdById !== auth.actor.id || from.getTime() < now.getTime()-60000 || until <= from || until.getTime()-from.getTime()>31*86400000
      || until <= now || until > credential.validUntil || input.maxPerDay > input.maxMessages) serviceDenied();
    const newsletter = facts.row.event === 'NEWSLETTER' ? await policySource(now) : null;
    if (newsletter) {
      const [epoch] = await tx.$queryRaw<Array<{ epoch: string }>>`SELECT epoch FROM "MarketingPreferenceEpoch" WHERE singleton=true AND reconciled=true FOR SHARE`;
      if (epoch?.epoch !== newsletter.readiness.epoch || Date.parse(facts.rule.configuration.newsletterAt!) < from.getTime()
        || Date.parse(facts.rule.configuration.newsletterAt!) >= until.getTime()) serviceDenied();
    }
    const policy = servicePolicySchema.parse({ protocol: 'FAI_WORKFLOW_SERVICE_POLICY_V1',automationId: facts.row.id,
      automationVersion: facts.row.version,ruleHash: canonicalSha256(facts.rule),event: facts.row.event,action: facts.rule.configuration.action,templateHashes: facts.templateHashes,
      authorityRevision: native.binding.revision,mailboxId: native.box.id,mailboxRevision: native.box.revision,channelRevision: native.channel.channelRevision,
      qualificationReference: native.channel.qualificationReference,credentialId: credential.id,credentialRevision: credential.revision,
      keyFingerprint: credential.keyFingerprint,approvalReference: input.approvalReference,scope: 'LEAD_ONLY_ONE_RECIPIENT_NO_ATTACHMENTS',
      newsletterPolicyHash: newsletter?.bindingHash ?? null });
    const row = await tx.workflowServiceGrant.create({ data: { id: input.id,automationId: facts.row.id,automationVersion: facts.row.version,
      credentialId: credential.id,credentialRevision: credential.revision,issuedById: auth.actor.id,issuedSessionId: auth.registry.id,state: 'ACTIVE',
      validFrom: from,validUntil: until,maxMessages: input.maxMessages,maxPerDay: input.maxPerDay,policy: serviceJson(policy),policyHash: canonicalSha256(policy) } });
    await tx.auditLog.create({ data: { actorId: auth.actor.id,entityType: 'WorkflowServiceGrant',entityId: row.id,event: 'workflow_service_grant_issued',
      after: { policyHash: row.policyHash,version: row.automationVersion,maxMessages: row.maxMessages,maxPerDay: row.maxPerDay,
        validFrom: from.toISOString(),validUntil: until.toISOString(),approvalReference: input.approvalReference } } });
    await auth.finish(); return { id: row.id,policyHash: row.policyHash };
  },{ timeout: 30000 });
}
export async function revokeWorkflowServiceAuthority(db: PrismaClient, session: AuthSession, raw: unknown, proof: UpdateCredentials) {
  // Revocation must remain available while execution is disabled.
  const input = z.object({ id: z.string().uuid(),kind: z.enum(['GRANT','CREDENTIAL']),expectedRevision: z.number().int().positive() }).strict().parse(raw);
  return db.$transaction(async tx => {
    const auth = await updateActor(tx,session,proof); permission(auth.actor);
    const now = await auth.finish();
    const table = input.kind === 'GRANT' ? 'WorkflowServiceGrant' : 'WorkflowServiceCredential';
    await tx.$queryRaw(Prisma.sql`SELECT id FROM ${Prisma.raw('"'+table+'"')} WHERE id=${input.id}::uuid FOR UPDATE`);
    const changed = input.kind === 'GRANT'
      ? await tx.workflowServiceGrant.updateMany({ where: { id: input.id,state: 'ACTIVE',revision: input.expectedRevision },data: { state: 'REVOKED',revision: { increment: 1 },revokedAt: now } })
      : await tx.workflowServiceCredential.updateMany({ where: { id: input.id,state: 'ACTIVE',revision: input.expectedRevision },data: { state: 'REVOKED',revision: { increment: 1 } } });
    if (changed.count !== 1) serviceDenied();
    await tx.auditLog.create({ data: { actorId: auth.actor.id,entityType: table,entityId: input.id,event: 'workflow_service_authority_revoked',after: { revision: input.expectedRevision+1 } } });
    await auth.finish();
  },{ timeout: 30000 });
}

const admitted = new WeakMap<object,Tx>();
export type WorkflowServiceAdmission = Awaited<ReturnType<typeof admitWorkflowService>>;
export function assertServiceAdmission(tx: Tx, value: WorkflowServiceAdmission) {
  if (admitted.get(value) !== tx) serviceDenied();
}
/** No InternalSession is created or resolved here. The historic issuing session
 * is provenance; authority is the current, revocable grant plus service proof. */
export async function admitWorkflowService(tx: Tx, invocation: ServiceInvocation, runtime: WorkflowServiceRuntime) {
  assertWorkflowServiceEnabled();
  if (!await lockRegisteredPrivilegedStepUpKey(tx,runtime.nativeKey)) throw new Error('WORKFLOW_NATIVE_KEY_UNAVAILABLE');
  await lockCommunicationDirectory(tx);
  await tx.$queryRaw`SELECT id FROM "WorkflowServiceCredential" WHERE id=${runtime.credential.id}::uuid FOR SHARE`;
  const credential = await tx.workflowServiceCredential.findUniqueOrThrow({ where: { id: runtime.credential.id } });
  if (credential.state !== 'ACTIVE' || credential.keyFingerprint !== serviceFingerprint(runtime.credential.key) || credential.validUntil <= await serviceClock(tx))
    throw new Error('WORKFLOW_SERVICE_CREDENTIAL_DENIED');
  // One grant lock serializes quota reservations and is held through native DATA.
  await tx.$queryRaw`SELECT id FROM "WorkflowServiceGrant" WHERE id=${invocation.grantId}::uuid FOR UPDATE`;
  const grant = await tx.workflowServiceGrant.findUniqueOrThrow({ where: { id: invocation.grantId } });
  const actor = await currentRecordUpdateUser(tx,grant.issuedById); if (!actor) serviceDenied(); permission(actor);
  const native = await currentNativeAuthority(tx,actor.id), facts = await ruleAndTemplates(tx,grant.automationId);
  const policy = servicePolicySchema.parse(grant.policy);
  if (grant.state !== 'ACTIVE' || credential.state !== 'ACTIVE' || grant.credentialId !== credential.id || grant.credentialRevision !== credential.revision
    || policy.credentialRevision !== credential.revision || policy.credentialId !== credential.id || credential.keyFingerprint !== serviceFingerprint(runtime.credential.key)
    || policy.keyFingerprint !== credential.keyFingerprint || policy.automationId !== facts.row.id || policy.automationVersion !== facts.row.version
    || policy.event !== facts.rule.event || policy.action !== facts.rule.configuration.action
    || grant.automationVersion !== facts.row.version || facts.row.createdById !== actor.id || policy.ruleHash !== canonicalSha256(facts.rule)
    || canonicalSha256(policy.templateHashes) !== canonicalSha256(facts.templateHashes) || grant.policyHash !== canonicalSha256(policy)
    || policy.authorityRevision !== native.binding.revision || policy.mailboxId !== native.box.id || policy.mailboxRevision !== native.box.revision
    || policy.channelRevision !== native.channel.channelRevision || policy.qualificationReference !== native.channel.qualificationReference) serviceDenied();
  const finish = async () => {
    assertWorkflowServiceEnabled(); await runtime.assertCredentialCurrent();
    const now = await serviceClock(tx);
    if (now >= credential.validUntil) throw new Error('WORKFLOW_SERVICE_CREDENTIAL_DENIED');
    if (now < grant.validFrom || now >= grant.validUntil || now >= new Date(invocation.expiresAt)) serviceDenied();
    if (policy.newsletterPolicyHash) {
      const current = await (runtime.newsletterPolicySource ?? readNativeNewsletterPolicy)(now);
      if (current.bindingHash !== policy.newsletterPolicyHash) serviceDenied();
    }
    return now;
  };
  await finish();
  const value = { actor,grant,policy,rule: facts.rule,channel: native.channel,box: native.box,finish,invocation };
  admitted.set(value,tx); return value;
}

export async function beginWorkflowServiceInvocation(db: PrismaClient, raw: unknown, proof: string, runtime: WorkflowServiceRuntime) {
  assertWorkflowServiceEnabled();
  return db.$transaction(async tx => {
    const verified = parseServiceInvocation(raw,proof,runtime.credential.key,await serviceClock(tx));
    const auth = await admitWorkflowService(tx,verified.input,runtime);
    const previous = await tx.workflowServiceInvocation.findUnique({ where: { id: verified.input.id } });
    if (previous) {
      if (previous.grantId !== auth.grant.id || previous.requestHash !== verified.requestHash) serviceDenied();
      return { invocation: verified.input,replay: true,result: previous.result };
    }
    await tx.workflowServiceInvocation.create({ data: { id: verified.input.id,grantId: auth.grant.id,requestHash: verified.requestHash,
      expiresAt: new Date(verified.input.expiresAt),startedAt: await auth.finish() } });
    return { invocation: verified.input,replay: false,result: null };
  },{ timeout: 30000 });
}

/** Native personal/manual entry points cannot convert delegated drafts into a
 * personal decision or export a message beyond its grant. Legacy schema has no
 * such binding; a partial schema remains an error rather than being hidden. */
async function workflowServiceTablesPresent(tx: Tx) {
  const [schema] = await tx.$queryRaw<Array<{ count: number;discriminator: boolean }>>`SELECT count(*)::integer AS count,
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass(format('%I.%I',current_schema(),'OrdinaryEmailDecision'))
      AND attname='serviceMessageId' AND NOT attisdropped) AS discriminator FROM
    (VALUES (to_regclass(format('%I.%I',current_schema(),'WorkflowServiceCredential'))),
      (to_regclass(format('%I.%I',current_schema(),'WorkflowServiceGrant'))),
      (to_regclass(format('%I.%I',current_schema(),'WorkflowServiceInvocation'))),
      (to_regclass(format('%I.%I',current_schema(),'WorkflowServiceMessage'))),
      (to_regclass(format('%I.%I',current_schema(),'WorkflowServiceNotice')))) relations(value) WHERE value IS NOT NULL`;
  if (schema.count === 0 && !schema.discriminator) return false;
  if (schema.count !== 5 || !schema.discriminator) throw new Error('WORKFLOW_SERVICE_PERSISTENCE_INCOMPLETE');
  return true;
}
export async function denyPersonalServiceMessage(tx: Tx, messageId: string) {
  if (!await workflowServiceTablesPresent(tx)) return;
  if (await tx.workflowServiceMessage.findUnique({ where: { messageId },select: { messageId: true } }))
    throw new Error('WORKFLOW_SERVICE_MESSAGE_REQUIRES_GRANT');
}

/** Called only after native message/content scope admission. */
export async function readWorkflowServiceMessageAuthority(tx: Tx,messageId: string) {
  if (!await workflowServiceTablesPresent(tx)) return null;
  const row = await tx.workflowServiceMessage.findUnique({ where: { messageId },select: { grant: {
    select: { id: true,state: true,automationVersion: true,validFrom: true,validUntil: true } } } });
  return row?.grant ?? null;
}

export async function readWorkflowServiceAdministration(db: PrismaClient, session: AuthSession) {
  return db.$transaction(async tx => {
    const auth = await updateActor(tx,session); permission(auth.actor);
    const [credentials,grants] = await Promise.all([
      tx.workflowServiceCredential.findMany({ orderBy: { createdAt: 'desc' },take: 100,
        select: { id: true,keyFingerprint: true,state: true,revision: true,validUntil: true,qualificationReference: true } }),
      tx.workflowServiceGrant.findMany({ orderBy: { approvedAt: 'desc' },take: 100,
        select: { id: true,automationId: true,automationVersion: true,state: true,revision: true,validFrom: true,validUntil: true,
          maxMessages: true,maxPerDay: true,policyHash: true,policy: true,notices: { select: { executionId: true } },messages: { select: { decision: { select: { id: true } } } } } }),
    ]);
    await auth.finish(); return { credentials,grants: grants.map(row => ({ ...row,policy: undefined,
      approvalReference: servicePolicySchema.parse(row.policy).approvalReference,used: row.messages.filter(message => message.decision).length+row.notices.length,messages: undefined,notices: undefined })) };
  },{ timeout: 30000 });
}

export async function assertWorkflowServiceQuota(tx: Tx,auth: WorkflowServiceAdmission) {
  assertServiceAdmission(tx,auth);
  const [used] = await tx.$queryRaw<Array<{ total: number;day: number }>>`SELECT count(*)::integer AS total,
    count(*) FILTER (WHERE q.at>=date_trunc('day',clock_timestamp(),'UTC'))::integer AS day FROM (
      SELECT d."createdAt" AS at FROM "OrdinaryEmailDecision" d JOIN "WorkflowServiceMessage" s ON s."messageId"=d."serviceMessageId" WHERE s."grantId"=${auth.grant.id}::uuid
      UNION ALL SELECT n."createdAt" FROM "WorkflowServiceNotice" n WHERE n."grantId"=${auth.grant.id}::uuid) q`;
  if (used.total >= auth.grant.maxMessages || used.day >= auth.grant.maxPerDay) throw new Error('WORKFLOW_SERVICE_QUOTA');
}
