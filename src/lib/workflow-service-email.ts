import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { canonicalSha256 } from './canonical-json';
import { loadWorkflowServiceMessageContext } from './approved-communications';
import { prepareOrdinaryEmail } from './ordinary-email-candidate';
import { recordStoredOrdinaryEmailOutcome } from './ordinary-email-store-candidate';
import { transmitOrdinaryEmailCandidate, type OrdinaryAttemptLease, type OrdinaryAttemptRequest } from './ordinary-email-smtp-candidate';
import { createOrdinaryTransportResolver, type OrdinaryTransportSource } from './ordinary-email-transport-binding';
import { admitWorkflowService, assertWorkflowServiceQuota, serviceDenied, type WorkflowServiceRuntime } from './workflow-service-authority';
import { serviceMac, verifyServiceMac, type ServiceInvocation } from './workflow-service-contract';
import { readWorkflowServiceSource } from './workflow-service-planning';
import { writeOrdinaryObservation } from './ordinary-email-observation';

type Tx = Prisma.TransactionClient;
const hash = z.string().regex(/^[a-f0-9]{64}$/), uuid = z.string().uuid();
const decisionSchema = z.object({ protocol: z.literal('FAI_ORDINARY_EMAIL_WORKFLOW_DECISION_V1'), decisionId: uuid,
  messageId: uuid,actorId: z.string().min(1),draftRevision: z.number().int().positive(),draftHash: hash,
  grantId: uuid,grantRevision: z.number().int().positive(),credentialId: uuid,credentialRevision: z.number().int().positive(),
  policyHash: hash,sourceHash: hash,contextHash: hash,channelHash: hash,intentHash: hash,mimeHash: hash,envelopeHash: hash,
  preparedAt: z.string().datetime(),validUntil: z.string().datetime(),invocationId: uuid }).strict();
type NativeRuntime = WorkflowServiceRuntime & { transport: ReturnType<typeof createOrdinaryTransportResolver> };

async function load(tx: Tx, invocation: ServiceInvocation, messageId: string, runtime: NativeRuntime) {
  const auth = await admitWorkflowService(tx,invocation,runtime);
  const binding = await tx.workflowServiceMessage.findUniqueOrThrow({ where: { messageId } });
  if (binding.grantId !== auth.grant.id || binding.policyHash !== auth.grant.policyHash) serviceDenied();
  const source = await readWorkflowServiceSource(tx,auth,{ executionId: binding.executionId,recipientId: binding.recipientId },runtime);
  if (!source || source.sourceHash !== binding.sourceHash || source.messageId !== messageId) serviceDenied();
  const loaded = await loadWorkflowServiceMessageContext(tx,auth,messageId,{ newsletterPolicySource: runtime.newsletterPolicySource });
  if (binding.versionId !== loaded.version.id || binding.snapshotHash !== loaded.version.snapshotHash
    || loaded.snapshot.to[0] !== source.to || loaded.snapshot.subject !== source.subject || loaded.snapshot.body !== source.body) serviceDenied();
  runtime.transport.assertChannel(auth.channel);
  const check = async () => { runtime.transport.assertChannel(auth.channel); await loaded.newsletterCheck?.(); return auth.finish(); };
  await check();
  return { auth,binding,loaded,source,check,material: { snapshot: loaded.snapshot,channel: auth.channel,materials: loaded.materials,authority: 'WORKFLOW' as const } };
}

async function reserve(db: PrismaClient, invocation: ServiceInvocation, messageId: string, runtime: NativeRuntime) {
  return db.$transaction(async tx => {
    const value = await load(tx,invocation,messageId,runtime);
    // Any committed native decision (including NOT_SENT) requires human
    // reconciliation before a new grant/message. No automatic resend path.
    if (await tx.ordinaryEmailDecision.findFirst({ where: { messageId } })) return null;
    if (value.loaded.row.state !== 'DRAFT' || await tx.communicationAttempt.count({ where: { messageId } })) serviceDenied();
    await assertWorkflowServiceQuota(tx,value.auth);
    const now = await value.check(), prepared = prepareOrdinaryEmail(value.material.snapshot,value.material.channel,value.material.materials,now,'WORKFLOW');
    const decision = decisionSchema.parse({ protocol: 'FAI_ORDINARY_EMAIL_WORKFLOW_DECISION_V1',decisionId: randomUUID(),messageId,
      actorId: value.auth.actor.id,draftRevision: value.loaded.version.revision,draftHash: value.loaded.version.snapshotHash,
      grantId: value.auth.grant.id,grantRevision: value.auth.grant.revision,credentialId: runtime.credential.id,
      credentialRevision: value.auth.grant.credentialRevision,policyHash: value.binding.policyHash,sourceHash: value.binding.sourceHash,
      contextHash: value.loaded.contextHash,channelHash: canonicalSha256(value.material.channel),intentHash: prepared.intentHash,mimeHash: prepared.mimeHash,
      envelopeHash: canonicalSha256(prepared.envelope),preparedAt: now.toISOString(),invocationId: invocation.id,
      validUntil: new Date(Math.min(now.getTime()+60000,Date.parse(invocation.expiresAt),value.auth.grant.validUntil.getTime())).toISOString() });
    const decisionHash = canonicalSha256(decision), proof = serviceMac('decision',decision,runtime.credential.key), attemptId = randomUUID();
    // Database trigger checks binding, discriminator and total/day quotas while
    // holding the same grant lock. This is not CommunicationApproval.
    await tx.$executeRaw`INSERT INTO "OrdinaryEmailDecision" (id,"messageId","versionId","actorId","sessionId","serviceMessageId",decision,"decisionHash",proof,"envelopeHash")
      VALUES (${decision.decisionId}::uuid,${messageId}::uuid,${value.loaded.version.id}::uuid,${decision.actorId},NULL,${messageId}::uuid,
      ${JSON.stringify(decision)}::jsonb,${decisionHash},${proof},${decision.envelopeHash})`;
    await tx.$executeRaw`INSERT INTO "OrdinaryEmailAttempt" (id,"requestId","decisionId","messageId")
      VALUES (${attemptId}::uuid,${randomUUID()}::uuid,${decision.decisionId}::uuid,${messageId}::uuid)`;
    await tx.approvedCommunication.update({ where: { id: messageId },data: { state: 'SENDING' } });
    await tx.communicationEvent.create({ data: { messageId,actorId: value.auth.actor.id,event: 'WORKFLOW_SERVICE_DECISION',
      evidence: { grantId: decision.grantId,grantRevision: decision.grantRevision,decisionId: decision.decisionId,
        policyHash: decision.policyHash,decisionHash,personalApproval: false,authorityKind: 'WORKFLOW_SERVICE' } } });
    await value.check(); return { attemptId };
  },{ timeout: 30000 });
}

async function current(tx: Tx, invocation: ServiceInvocation, attemptId: string, runtime: NativeRuntime) {
  const initial = await tx.ordinaryEmailAttempt.findUniqueOrThrow({ where: { id: uuid.parse(attemptId) } });
  const value = await load(tx,invocation,initial.messageId,runtime);
  await tx.$queryRaw`SELECT id FROM "OrdinaryEmailAttempt" WHERE id=${attemptId}::uuid FOR UPDATE`;
  const row = await tx.ordinaryEmailAttempt.findUniqueOrThrow({ where: { id: attemptId },include: { decision: true } });
  const decision = decisionSchema.parse(row.decision.decision);
  if (row.messageId !== initial.messageId || value.loaded.row.state !== 'SENDING' || row.decision.sessionId !== null
    || row.decision.serviceMessageId !== row.messageId || row.decision.versionId !== value.loaded.version.id
    || row.decision.actorId !== value.auth.actor.id || row.decision.id !== decision.decisionId
    || row.decision.decisionHash !== canonicalSha256(decision) || decision.grantId !== value.auth.grant.id
    || decision.grantRevision !== value.auth.grant.revision || decision.credentialId !== runtime.credential.id
    || decision.credentialRevision !== value.auth.grant.credentialRevision || decision.policyHash !== value.binding.policyHash
    || decision.sourceHash !== value.binding.sourceHash || decision.messageId !== row.messageId
    || decision.actorId !== value.auth.actor.id || decision.invocationId !== invocation.id
    || decision.draftRevision !== value.loaded.version.revision || decision.draftHash !== value.loaded.version.snapshotHash
    || decision.contextHash !== value.loaded.contextHash || decision.channelHash !== canonicalSha256(value.material.channel)) serviceDenied();
  verifyServiceMac('decision',decision,row.decision.proof,runtime.credential.key);
  const prepared = prepareOrdinaryEmail(value.material.snapshot,value.material.channel,value.material.materials,new Date(decision.preparedAt),'WORKFLOW');
  if (decision.intentHash !== prepared.intentHash || decision.mimeHash !== prepared.mimeHash
    || decision.envelopeHash !== canonicalSha256(prepared.envelope) || row.decision.envelopeHash !== decision.envelopeHash) serviceDenied();
  const check = async () => {
    const now = await value.check();
    if (now >= new Date(decision.validUntil) || Date.parse(decision.validUntil)-Date.parse(decision.preparedAt)>60000) serviceDenied();
    return now;
  };
  await check(); return { ...value,row,decision,prepared,check };
}

async function take(db: PrismaClient, invocation: ServiceInvocation, request: OrdinaryAttemptRequest, runtime: NativeRuntime): Promise<OrdinaryAttemptLease> {
  return db.$transaction(async tx => {
    const value = await current(tx,invocation,request.attemptId,runtime);
    if (value.row.state !== 'RESERVED' || request.intentHash !== value.prepared.intentHash || request.mimeHash !== value.prepared.mimeHash
      || request.envelopeHash !== value.decision.envelopeHash || canonicalSha256(request.channel) !== canonicalSha256(value.material.channel)) serviceDenied();
    const now = await value.check(), expiresAt = new Date(Math.min(now.getTime()+15000,Date.parse(value.decision.validUntil))), leaseId = randomUUID();
    await tx.$executeRaw`INSERT INTO "OrdinaryEmailClaim" (id,"attemptId","expiresAt","createdAt") VALUES (${leaseId}::uuid,${request.attemptId}::uuid,${expiresAt},${now})`;
    await tx.$executeRaw`UPDATE "OrdinaryEmailAttempt" SET state='CLAIMED' WHERE id=${request.attemptId}::uuid`;
    if (await value.check() >= expiresAt) serviceDenied();
    return Object.freeze({ attemptId: request.attemptId,leaseId,expiresAt: expiresAt.toISOString(),committed: true as const });
  },{ timeout: 30000 });
}
async function leaseCheck(tx: Tx, invocation: ServiceInvocation, lease: OrdinaryAttemptLease, runtime: NativeRuntime) {
  const value = await current(tx,invocation,lease.attemptId,runtime);
  const claim = await tx.ordinaryEmailClaim.findUnique({ where: { id: lease.leaseId } });
  const check = async () => {
    const now = await value.check();
    if (value.row.state !== 'CLAIMED' || !claim || claim.attemptId !== lease.attemptId || !lease.committed
      || claim.expiresAt.toISOString() !== lease.expiresAt || claim.expiresAt <= now) serviceDenied();
  };
  await check(); return check;
}

/** Both sequences and newsletters reach this same native transport. A socket
 * is possible only after a committed decision, unique attempt and one-use
 * claim. The bounded native DATA transaction retains current grant, source,
 * native authority, channel and marketing locks and checks again after 354. */
export async function executeWorkflowServiceMessage(db: PrismaClient, invocation: ServiceInvocation, messageId: string,
  runtime: WorkflowServiceRuntime, source: OrdinaryTransportSource, signal: AbortSignal) {
  const composed = { ...runtime,transport: createOrdinaryTransportResolver(runtime.nativeKey,source) };
  const reserved = await reserve(db,invocation,messageId,composed);
  if (!reserved) return { state: 'EXISTING_ATTEMPT' as const };
  const material = await db.$transaction(async tx => {
    const value = await current(tx,invocation,reserved.attemptId,composed);
    if (value.row.state !== 'RESERVED') serviceDenied();
    return { ...value.material,preparedAt: new Date(value.decision.preparedAt) };
  },{ timeout: 30000 });
  let lease: OrdinaryAttemptLease | null = null;
  const outcome = await transmitOrdinaryEmailCandidate(material,reserved.attemptId,{ deadline: performance.now()+15000,signal },{
    takeCommittedAttempt: async request => { lease = await take(db,invocation,request,composed); return lease; },
    assertCurrent: value => db.$transaction(async tx => { await leaseCheck(tx,invocation,value,composed); },{ timeout: 20000 }),
    withCurrentAuthorization: (value,operation) => db.$transaction(async tx => operation(await leaseCheck(tx,invocation,value,composed)),{ timeout: 20000 }),
    readQualifiedTransport: composed.transport.readQualifiedTransport,connectTls: composed.transport.connectTls,
    observeOutcome: runtime.observationSink ?? writeOrdinaryObservation,
  });
  if (lease) await recordStoredOrdinaryEmailOutcome(db,lease,outcome);
  // Missing claim/outcome is left RESERVED/CLAIMED for reconciliation. Neither
  // an exception nor a new invocation permits the executor to submit it again.
  return { state: lease ? outcome.outcome : 'UNRESOLVED_RESERVATION' as const };
}
