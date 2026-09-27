import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient, type CommunicationMailbox } from '@prisma/client';
import { z } from 'zod';
import type { AuthSession } from './auth';
import { canViewClientContext, canViewDocument, canViewTechnicalPractice } from './access-control';
import { loadClientReadScope } from './client-read-perimeter';
import { lockAuthoritativeInternalSession } from './internal-session-registry';
import { hasPermission } from './permission-evaluator';
import type { Permission } from './permissions';
import { canonicalSha256 } from './canonical-json';
import { readPrivateDocumentBounded } from './storage';
import { buildApprovedMessagePackage } from './approved-message-package';
import {
  ApprovedCommunicationError, approvedMessageHash, approvedMessageSnapshotSchema,
  communicationContextSchema, DECLARED_FAI_MAILBOXES, mailboxQualification,
  assertExactMessageApproval, assertCanBeginManualMessage, manualMessageEvidenceSchema,
  nextManualMessageState, type CommunicationContext, type ApprovedMessageSnapshot,
  type ApprovedMessageState,
} from './approved-communication-contract';

type Db = Pick<PrismaClient, '$transaction'>;
type Tx = Prisma.TransactionClient;
type Runtime = { readDocument?: typeof readPrivateDocumentBounded; failAudit?: boolean };
const uuid = z.string().uuid(), identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const revision = z.number().int().positive();
const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');
function denied(): never { throw new ApprovedCommunicationError('DENIED'); }
function conflict(): never { throw new ApprovedCommunicationError('CONFLICT'); }
function parse<T extends z.ZodTypeAny>(schema: T, raw: unknown): z.infer<T> {
  const result = schema.safeParse(raw);
  if (!result.success) throw new ApprovedCommunicationError('INVALID');
  return result.data;
}
function json(value: unknown) { return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue; }

async function actor(tx: Tx, claimed: AuthSession, permission: Permission, admin = false) {
  if (!claimed.active || claimed.expiresAt * 1000 <= Date.now() || !uuid.safeParse(claimed.sessionId).success) denied();
  const row = await lockAuthoritativeInternalSession(tx, { sessionId: claimed.sessionId!, userId: claimed.userId });
  if (!row || !row.active || !row.live || row.revokedAt || row.deletedAt || (admin && row.role !== 'admin')) denied();
  const current = { ...claimed, role: row.role, active: row.active, permissionOverrides: [...row.permissionOverrides],
    clientReadScope: await loadClientReadScope(tx, claimed.userId) } satisfies AuthSession;
  if (!hasPermission(current, permission)) denied();
  return current;
}

async function contextScope(tx: Tx, current: AuthSession, context: CommunicationContext, write = false) {
  const technical = context.kind === 'TECHNICAL';
  if (technical) await tx.$queryRaw`SELECT "id" FROM "TechnicalPractice" WHERE "id"=${context.id} FOR SHARE`;
  else await tx.$queryRaw`SELECT "id" FROM "PracticeReadiness" WHERE "id"=${context.id}::uuid FOR SHARE`;
  const practice = technical ? await tx.technicalPractice.findUnique({ where: { id: context.id } })
    : await tx.practiceReadiness.findUnique({ where: { id: context.id } });
  if (!practice || ('deletedAt' in practice && practice.deletedAt) || (write && 'status' in practice && practice.status === 'archiviata')) denied();
  await tx.$queryRaw`SELECT "id" FROM "Client" WHERE "id"=${practice.clientId} FOR SHARE`;
  if (practice.projectId) await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id"=${practice.projectId} FOR SHARE`;
  if (practice.clientServiceId) await tx.$queryRaw`SELECT "id" FROM "ClientService" WHERE "id"=${practice.clientServiceId} FOR SHARE`;
  const [client, project, service] = await Promise.all([
    tx.client.findUnique({ where: { id: practice.clientId } }),
    practice.projectId ? tx.project.findUnique({ where: { id: practice.projectId } }) : null,
    practice.clientServiceId ? tx.clientService.findUnique({ where: { id: practice.clientServiceId } }) : null,
  ]);
  if (!client || client.deletedAt || (practice.projectId && (!project || project.deletedAt || project.clientId !== client.id))
    || (practice.clientServiceId && (!service || service.deletedAt || service.clientId !== client.id || service.projectId !== practice.projectId))
    || (write && service?.status === 'sospeso') || (write && project?.status === 'archiviato')) denied();
  const hydratedProject = project ? { ...project, client } : null;
  const hydratedService = service ? { ...service, client, project: hydratedProject } : null;
  const allowed = technical && 'commercialOwnerId' in practice
    ? canViewTechnicalPractice(current, { ...practice, client })
    : canViewClientContext(current, { clientId: client.id, client, project: hydratedProject, clientService: hydratedService });
  if (!allowed) denied();
  return { context, practice, client, project: hydratedProject, service: hydratedService };
}

function mailboxSnapshot(box: CommunicationMailbox) {
  return { id: box.id, address: box.address, revision: box.revision, configuredRevision: box.configuredRevision,
    configurationReference: box.configurationReference, testedRevision: box.testedRevision, testReference: box.testReference,
    testedAt: box.testedAt?.toISOString() ?? null, enabled: box.enabled && box.canSend,
    method: 'MANUAL_EXTERNAL' as const, responsibleUserId: box.responsibleUserId, restricted: box.restricted };
}
async function mailbox(tx: Tx, id: string, current: AuthSession, classification = 'ORDINARY') {
  await tx.$queryRaw`SELECT "id" FROM "CommunicationMailbox" WHERE "id"=${id}::uuid FOR SHARE`;
  const box = await tx.communicationMailbox.findUnique({ where: { id } });
  if (!box || !DECLARED_FAI_MAILBOXES.some((declared) => declared.address === box.address)) denied();
  if ((box.restricted || classification === 'COMPLAINT') && current.role !== 'admin') denied();
  if (classification === 'SENSITIVE' && !hasPermission(current, 'document.sensitive.read')) denied();
  return box;
}
async function responsibleMailbox(tx: Tx, box: CommunicationMailbox) {
  if (!box.responsibleUserId) throw new ApprovedCommunicationError('SENDER_NOT_READY');
  await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id"=${box.responsibleUserId} FOR SHARE`;
  const user = await tx.user.findUnique({ where: { id: box.responsibleUserId } });
  if (!user?.active || user.deletedAt) throw new ApprovedCommunicationError('SENDER_NOT_READY');
  if (box.canonicalMailboxId) {
    await tx.$queryRaw`SELECT "id" FROM "CommunicationMailbox" WHERE "id"=${box.canonicalMailboxId}::uuid FOR SHARE`;
    const canonical = await tx.communicationMailbox.findUnique({ where: { id: box.canonicalMailboxId } });
    if (!canonical || canonical.canonicalMailboxId || canonical.revision !== box.canonicalRevision
      || canonical.restricted !== box.restricted || !mailboxQualification(mailboxSnapshot(canonical)).tested)
      throw new ApprovedCommunicationError('SENDER_NOT_READY');
  }
}
async function effectiveQualification(tx: Tx, box: CommunicationMailbox) {
  const result = mailboxQualification(mailboxSnapshot(box));
  if (!result.configured) return result;
  try { await responsibleMailbox(tx, box); return result; }
  catch (error) {
    if (!(error instanceof ApprovedCommunicationError)) throw error;
    return { ...result, configured: false, tested: false, enabled: false };
  }
}

async function attachments(tx: Tx, current: AuthSession, scope: Awaited<ReturnType<typeof contextScope>>, ids: string[], runtime: Runtime) {
  const snapshot: ApprovedMessageSnapshot['attachments'] = [], materials = new Map<string, Buffer>();
  let total = 0;
  if (ids.length > 20 || new Set(ids).size !== ids.length) denied();
  for (const versionId of ids.slice().sort()) {
    if (!hasPermission(current, 'document.download')) denied();
    await tx.$queryRaw`SELECT "id" FROM "DocumentVersion" WHERE "id"=${versionId} FOR SHARE`;
    const version = await tx.documentVersion.findUnique({ where: { id: versionId } });
    if (!version) denied();
    await tx.$queryRaw`SELECT "id" FROM "Document" WHERE "id"=${version.documentId} FOR SHARE`;
    const doc = await tx.document.findUnique({ where: { id: version.documentId } });
    if (!doc || doc.deletedAt || doc.clientId !== scope.client.id || !version.checksum
      || ['respinto', 'scaduto', 'archiviato'].includes(doc.status)
      || (doc.validUntil && doc.validUntil.getTime() <= Date.now())
      || (doc.projectId && doc.projectId !== scope.project?.id)
      || (doc.clientServiceId && doc.clientServiceId !== scope.service?.id)
      || !canViewDocument(current, { ...doc, client: scope.client, project: doc.projectId ? scope.project : null,
        clientService: doc.clientServiceId ? scope.service : null }, hasPermission(current, 'document.sensitive.read'))) denied();
    let bytes: Buffer;
    try { bytes = await (runtime.readDocument ?? readPrivateDocumentBounded)(version.storagePath, 20 * 1024 * 1024 - total); }
    catch { denied(); }
    total += bytes.length;
    if (digest(bytes) !== version.checksum) denied();
    snapshot.push({ documentId: doc.id, versionId, sha256: version.checksum, filename: doc.fileName, mimeType: doc.mimeType, bytes: bytes.length });
    materials.set(versionId, bytes);
  }
  return { snapshot, materials };
}

async function event(tx: Tx, current: AuthSession, messageId: string | null, code: string, evidence: unknown, runtime: Runtime = {}, replyId: string | null = null) {
  if (runtime.failAudit) throw new Error('SYNTHETIC_M4_AUDIT_FAILURE');
  await tx.communicationEvent.create({ data: { actorId: current.userId, messageId, replyId, event: code, evidence: json(evidence) } });
  await tx.auditLog.create({ data: { actorId: current.userId, event: `m4_${code.toLowerCase()}`, entityType: 'ApprovedCommunication',
    entityId: messageId ?? replyId, after: { operation: code, evidenceHash: canonicalSha256(evidence) } } });
}

function rowContext(row: { readinessId: string | null; technicalPracticeId: string | null }): CommunicationContext {
  if (row.readinessId && !row.technicalPracticeId) return { kind: 'READINESS', id: row.readinessId };
  if (row.technicalPracticeId && !row.readinessId) return { kind: 'TECHNICAL', id: row.technicalPracticeId };
  return denied();
}
async function messageScope(tx: Tx, current: AuthSession, id: string, write = false) {
  await tx.$queryRaw`SELECT "id" FROM "ApprovedCommunication" WHERE "id"=${id}::uuid FOR UPDATE`;
  const row = await tx.approvedCommunication.findUnique({ where: { id }, include: {
    versions: { orderBy: { revision: 'asc' }, include: { approval: true } },
  } });
  if (!row) denied();
  const scope = await contextScope(tx, current, rowContext(row), write);
  const version = row.versions.find((item) => item.revision === row.currentRevision);
  if (!version || row.clientId !== scope.client.id) denied();
  const snapshot = parse(approvedMessageSnapshotSchema, version.snapshot);
  if (snapshot.messageId !== row.id || snapshot.clientId !== row.clientId || snapshot.revision !== row.currentRevision
    || canonicalSha256(snapshot.context) !== canonicalSha256(rowContext(row)) || snapshot.mailboxId !== row.mailboxId
    || approvedMessageHash(snapshot) !== version.snapshotHash) denied();
  const box = await mailbox(tx, row.mailboxId, current, snapshot.classification);
  return { row, version, snapshot, scope, box };
}

const editSchema = z.object({
  messageId: uuid, expectedRevision: z.number().int().nonnegative(), context: communicationContextSchema,
  mailboxId: uuid, replyTo: z.string().email().max(254), to: z.array(z.string()).min(1).max(20), cc: z.array(z.string()).max(20), bcc: z.array(z.string()).max(20),
  subject: z.string(), body: z.string(), attachmentVersionIds: z.array(identifier).max(20),
  classification: z.enum(['ORDINARY', 'SENSITIVE', 'COMPLAINT']),
}).strict();

export async function saveApprovedMessageDraft(db: Db, claimed: AuthSession, raw: unknown, runtime: Runtime = {}) {
  const input = parse(editSchema, raw);
  return db.$transaction(async tx => {
    const current = await actor(tx, claimed, 'practice_communications.write');
    const scope = await contextScope(tx, current, input.context, true);
    const box = await mailbox(tx, input.mailboxId, current, input.classification);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${input.messageId}, 0))`;
    const existing = await tx.approvedCommunication.findUnique({ where: { id: input.messageId } });
    if (existing) {
      const prior = await messageScope(tx, current, input.messageId, true);
      if (existing.currentRevision !== input.expectedRevision || ['SENDING', 'UNCERTAIN', 'SENT'].includes(existing.state)
        || canonicalSha256(rowContext(existing)) !== canonicalSha256(input.context)) conflict();
      if ((prior.box.restricted && !box.restricted)
        || (prior.snapshot.classification === 'COMPLAINT' && input.classification !== 'COMPLAINT')
        || (prior.snapshot.classification === 'SENSITIVE' && input.classification === 'ORDINARY')) denied();
    } else if (input.expectedRevision !== 0) conflict();
    const files = await attachments(tx, current, scope, input.attachmentVersionIds, runtime);
    const snapshot = parse(approvedMessageSnapshotSchema, { schema: 'fai.approved-email.v1', messageId: input.messageId,
      revision: input.expectedRevision + 1, context: input.context, clientId: scope.client.id, channel: 'EMAIL_MANUAL',
      mailboxId: box.id, mailboxRevision: box.revision, from: box.address, replyTo: input.replyTo,
      to: input.to, cc: input.cc, bcc: input.bcc, subject: input.subject, body: input.body, attachments: files.snapshot, classification: input.classification });
    if (!existing) await tx.approvedCommunication.create({ data: { id: input.messageId, clientId: scope.client.id,
      readinessId: input.context.kind === 'READINESS' ? input.context.id : null,
      technicalPracticeId: input.context.kind === 'TECHNICAL' ? input.context.id : null, mailboxId: box.id, createdById: current.userId } });
    else await tx.approvedCommunication.update({ where: { id: input.messageId }, data: { currentRevision: snapshot.revision, mailboxId: box.id, state: 'DRAFT' } });
    const saved = await tx.communicationVersion.create({ data: { messageId: input.messageId, revision: snapshot.revision,
      snapshot: json(snapshot), snapshotHash: approvedMessageHash(snapshot), createdById: current.userId } });
    await event(tx, current, input.messageId, 'DRAFT_SAVED', { revision: snapshot.revision, snapshotHash: saved.snapshotHash, priorApprovalInvalidated: !!existing }, runtime);
    return { id: input.messageId, revision: snapshot.revision, snapshotHash: saved.snapshotHash };
  }, { timeout: 30_000 });
}

const transitionSchema = z.object({ messageId: uuid, expectedRevision: revision, snapshotHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export async function submitApprovedMessage(db: Db, claimed: AuthSession, raw: unknown) {
  const input = parse(transitionSchema, raw);
  return db.$transaction(async tx => {
    const current = await actor(tx, claimed, 'practice_communications.write');
    const { row, version } = await messageScope(tx, current, input.messageId, true);
    if (row.currentRevision !== input.expectedRevision || version.snapshotHash !== input.snapshotHash || !['DRAFT', 'PENDING'].includes(row.state)) conflict();
    if (row.state === 'PENDING') return;
    await tx.approvedCommunication.update({ where: { id: row.id }, data: { state: 'PENDING' } });
    await event(tx, current, row.id, 'APPROVAL_REQUESTED', { revision: row.currentRevision, snapshotHash: version.snapshotHash });
  });
}

export async function approveExactMessage(db: Db, claimed: AuthSession, raw: unknown, runtime: Runtime = {}) {
  const input = parse(transitionSchema, raw);
  return db.$transaction(async tx => {
    const current = await actor(tx, claimed, 'practice_communications.read', true);
    const { row, version, snapshot, scope, box } = await messageScope(tx, current, input.messageId, true);
    if (row.currentRevision !== input.expectedRevision || version.snapshotHash !== input.snapshotHash || !['PENDING', 'APPROVED'].includes(row.state)) conflict();
    if (snapshot.mailboxRevision !== box.revision || snapshot.from !== box.address) conflict();
    if (!mailboxQualification(mailboxSnapshot(box)).enabled) throw new ApprovedCommunicationError('SENDER_NOT_READY');
    await responsibleMailbox(tx, box);
    const files = await attachments(tx, current, scope, snapshot.attachments.map(a => a.versionId), runtime);
    if (canonicalSha256(files.snapshot) !== canonicalSha256(snapshot.attachments)) conflict();
    if (version.approval) return { approvalId: version.approval.id };
    const approval = await tx.communicationApproval.create({ data: { versionId: version.id, snapshotHash: version.snapshotHash,
      mailboxRevision: box.revision, approverUserId: current.userId, approverSessionId: current.sessionId! } });
    await tx.approvedCommunication.update({ where: { id: row.id }, data: { state: 'APPROVED' } });
    await event(tx, current, row.id, 'EXACT_MESSAGE_APPROVED', { approvalId: approval.id, revision: row.currentRevision, snapshotHash: version.snapshotHash }, runtime);
    return { approvalId: approval.id };
  }, { timeout: 30_000 });
}

export async function prepareManualMessage(db: Db, claimed: AuthSession, raw: unknown, runtime: Runtime = {}) {
  const input = parse(transitionSchema.extend({ requestId: uuid }).strict(), raw);
  return db.$transaction(async tx => {
    const current = await actor(tx, claimed, 'practice_communications.mark_used');
    const { row, version, snapshot, scope, box } = await messageScope(tx, current, input.messageId, true);
    if (row.currentRevision !== input.expectedRevision || version.snapshotHash !== input.snapshotHash || !version.approval) conflict();
    const approval = version.approval;
    await responsibleMailbox(tx, box);
    const approvingUser = await lockAuthoritativeInternalSession(tx, { sessionId: approval.approverSessionId, userId: approval.approverUserId });
    if (!approvingUser || !approvingUser.active || !approvingUser.live || approvingUser.revokedAt || approvingUser.deletedAt || approvingUser.role !== 'admin') denied();
    assertExactMessageApproval(snapshot, { approvalId: approval.id, messageId: row.id, revision: row.currentRevision,
      snapshotHash: approval.snapshotHash, mailboxId: box.id, mailboxRevision: approval.mailboxRevision,
      approverUserId: approval.approverUserId, approverSessionId: approval.approverSessionId, approvedAt: approval.approvedAt.toISOString() }, mailboxSnapshot(box));
    const previous = await tx.communicationAttempt.findUnique({ where: { messageId_requestId: { messageId: row.id, requestId: input.requestId } } });
    if (previous) {
      if (previous.versionId !== version.id || previous.startedById !== current.userId || previous.state !== 'SENDING' || row.state !== 'SENDING') conflict();
    } else assertCanBeginManualMessage(row.state as ApprovedMessageState);
    const files = await attachments(tx, current, scope, snapshot.attachments.map(a => a.versionId), runtime);
    if (canonicalSha256(files.snapshot) !== canonicalSha256(snapshot.attachments)) conflict();
    const bytes = buildApprovedMessagePackage(snapshot, files.materials), artifactHash = digest(bytes);
    if (previous && previous.artifactHash !== artifactHash) denied();
    const attempt = previous ?? await tx.communicationAttempt.create({ data: { requestId: input.requestId, messageId: row.id,
      versionId: version.id, approvalId: approval.id, startedById: current.userId, startedSessionId: current.sessionId!, artifactHash } });
    if (!previous) {
      await tx.approvedCommunication.update({ where: { id: row.id }, data: { state: 'SENDING' } });
      await event(tx, current, row.id, 'MANUAL_ATTEMPT_PREPARED', { attemptId: attempt.id, revision: row.currentRevision, artifactHash, method: 'MANUAL_EXTERNAL' }, runtime);
    }
    return { attemptId: attempt.id, artifactHash, bytes };
  }, { timeout: 30_000 });
}

export async function recordManualMessageEvidence(db: Db, claimed: AuthSession, raw: unknown, runtime: Runtime = {}) {
  const input = parse(z.object({ messageId: uuid, attemptId: uuid, reconciliation: z.boolean(), evidence: manualMessageEvidenceSchema }).strict(), raw);
  return db.$transaction(async tx => {
    const current = await actor(tx, claimed, 'practice_communications.mark_used', input.reconciliation);
    const { row } = await messageScope(tx, current, input.messageId);
    const attempt = await tx.communicationAttempt.findUnique({ where: { id: input.attemptId } });
    if (!attempt || attempt.messageId !== row.id || (!input.reconciliation && attempt.startedById !== current.userId && current.role !== 'admin')) denied();
    const evidenceHash = canonicalSha256(input.evidence);
    if (attempt.evidenceHash === evidenceHash) return { state: attempt.state };
    if (new Date(input.evidence.occurredAt).getTime() > Date.now() + 60_000 || new Date(input.evidence.occurredAt).getTime() < attempt.createdAt.getTime() - 60_000) denied();
    const state = nextManualMessageState(attempt.state as ApprovedMessageState, input.evidence.outcome, input.reconciliation);
    if (row.state !== attempt.state) conflict();
    await tx.communicationAttempt.update({ where: { id: attempt.id }, data: { state, evidence: json(input.evidence), evidenceHash } });
    await tx.approvedCommunication.update({ where: { id: row.id }, data: { state } });
    await event(tx, current, row.id, input.reconciliation ? 'MANUAL_OUTCOME_RECONCILED' : 'MANUAL_OUTCOME_RECORDED', {
      attemptId: attempt.id, priorEvidenceHash: attempt.evidenceHash, evidence: input.evidence, evidenceHash,
    }, runtime);
    return { state };
  });
}

export async function readPracticeCommunications(db: Db, claimed: AuthSession, rawContext: unknown, page = 1) {
  const context = parse(communicationContextSchema, rawContext);
  if (!Number.isSafeInteger(page) || page < 1 || page > 200) throw new ApprovedCommunicationError('INVALID');
  return db.$transaction(async tx => {
    const current = await actor(tx, claimed, 'practice_communications.read');
    const scope = await contextScope(tx, current, context);
    const rows = await tx.approvedCommunication.findMany({ where: context.kind === 'READINESS'
      ? { readinessId: context.id } : { technicalPracticeId: context.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * 100, take: 101 });
    const messages = [];
    for (const row of rows.slice(0, 100)) {
      // Confidential content is filtered before loading history or replies.
      const version = await tx.communicationVersion.findUnique({ where: { messageId_revision: { messageId: row.id, revision: row.currentRevision } } });
      const candidate = approvedMessageSnapshotSchema.safeParse(version?.snapshot);
      const box = await tx.communicationMailbox.findUnique({ where: { id: row.mailboxId } });
      if (!candidate.success || !box) denied();
      if ((box.restricted || candidate.data.classification === 'COMPLAINT') && current.role !== 'admin') continue;
      if (candidate.data.classification === 'SENSITIVE' && !hasPermission(current, 'document.sensitive.read')) continue;
      const detail = await messageScope(tx, current, row.id);
      const [events, attempts, replies] = await Promise.all([
        tx.communicationEvent.findMany({ where: { messageId: row.id }, orderBy: { createdAt: 'asc' }, take: 200 }),
        tx.communicationAttempt.findMany({ where: { messageId: row.id }, orderBy: { createdAt: 'desc' }, take: 50 }),
        tx.communicationReply.findMany({ where: { messageId: row.id }, orderBy: { receivedAt: 'asc' }, take: 100 }),
      ]);
      let attachmentAccess = true;
      for (const file of detail.snapshot.attachments) {
        const doc = await tx.document.findUnique({ where: { id: file.documentId } });
        const storedVersion = await tx.documentVersion.findUnique({ where: { id: file.versionId } });
        if (!doc || doc.deletedAt || !storedVersion || storedVersion.documentId !== doc.id || storedVersion.checksum !== file.sha256
          || doc.clientId !== scope.client.id || (doc.projectId && doc.projectId !== scope.project?.id)
          || (doc.clientServiceId && doc.clientServiceId !== scope.service?.id)
          || !canViewDocument(current, { ...doc, client: scope.client, project: doc.projectId ? scope.project : null,
            clientService: doc.clientServiceId ? scope.service : null }, hasPermission(current, 'document.sensitive.read'))) attachmentAccess = false;
      }
      if (!attachmentAccess) continue;
      messages.push({ ...detail.row, versions: detail.row.versions.map(v => ({ id: v.id, revision: v.revision, snapshotHash: v.snapshotHash, createdAt: v.createdAt })),
        snapshot: detail.snapshot, snapshotHash: detail.version.snapshotHash, events, attempts, replies });
    }
    const boxes = await tx.communicationMailbox.findMany({ where: current.role === 'admin' ? {} : { restricted: false }, orderBy: { address: 'asc' } });
    const documents = [];
    if (hasPermission(current, 'document.download')) {
      const candidates = await tx.document.findMany({ where: { clientId: scope.client.id, deletedAt: null }, orderBy: { updatedAt: 'desc' }, take: 100 });
      for (const doc of candidates) {
        if ((doc.projectId && doc.projectId !== scope.project?.id) || (doc.clientServiceId && doc.clientServiceId !== scope.service?.id)
          || !canViewDocument(current, { ...doc, client: scope.client, project: doc.projectId ? scope.project : null,
            clientService: doc.clientServiceId ? scope.service : null }, hasPermission(current, 'document.sensitive.read'))) continue;
        const versions = await tx.documentVersion.findMany({ where: { documentId: doc.id }, orderBy: { version: 'desc' }, take: 5 });
        documents.push({ id: doc.id, title: doc.title, versions: versions.map(v => ({ id: v.id, version: v.version })) });
      }
    }
    const boxesWithQualification = [];
    for (const box of boxes) boxesWithQualification.push({ ...box, qualification: await effectiveQualification(tx, box) });
    return { context, client: { id: scope.client.id, name: scope.client.displayName }, messages, documents, page, hasMore: rows.length > 100 && page < 200,
      mailboxes: boxesWithQualification,
      canWrite: hasPermission(current, 'practice_communications.write'), canPrepare: hasPermission(current, 'practice_communications.mark_used'), isAdmin: current.role === 'admin' };
  }, { timeout: 30_000 });
}

const mailboxConfigurationSchema = z.object({
  mailboxId: uuid, expectedRevision: revision, kind: z.enum(['MAILBOX', 'ALIAS', 'FORWARD']),
  canonicalMailboxId: uuid.nullable(), providerReference: identifier, responsibleUserId: identifier,
  canSend: z.boolean(), canReceive: z.boolean(), restricted: z.boolean(), configurationReference: identifier,
}).strict();
export async function configureCommunicationMailbox(db: Db, claimed: AuthSession, raw: unknown) {
  const input = parse(mailboxConfigurationSchema, raw);
  return db.$transaction(async tx => {
    const current = await actor(tx, claimed, 'practice_communications.read', true);
    await tx.$queryRaw`SELECT "id" FROM "CommunicationMailbox" WHERE "id"=${input.mailboxId}::uuid FOR UPDATE`;
    const before = await tx.communicationMailbox.findUnique({ where: { id: input.mailboxId } });
    if (!before || before.revision !== input.expectedRevision) conflict();
    const declared = DECLARED_FAI_MAILBOXES.find(box => box.address === before.address);
    if (!declared || ((declared.restricted || before.restricted) && !input.restricted) || (input.kind === 'FORWARD' && input.canSend)) denied();
    const responsible = await tx.user.findUnique({ where: { id: input.responsibleUserId } });
    if (!responsible?.active || responsible.deletedAt) denied();
    if (input.kind === 'MAILBOX' ? input.canonicalMailboxId !== null : !input.canonicalMailboxId || input.canonicalMailboxId === before.id) denied();
    let canonicalRevision: number | null = null;
    if (input.canonicalMailboxId) {
      const canonical = await tx.communicationMailbox.findUnique({ where: { id: input.canonicalMailboxId } });
      if (!canonical || canonical.kind !== 'MAILBOX' || canonical.canonicalMailboxId || canonical.restricted !== input.restricted) denied();
      canonicalRevision = canonical.revision;
    }
    const aliases = await tx.communicationMailbox.findMany({ where: { canonicalMailboxId: before.id } });
    if (aliases.some(alias => input.kind !== 'MAILBOX' || alias.restricted !== input.restricted)) denied();
    const { mailboxId, expectedRevision, ...configuration } = input;
    const row = await tx.communicationMailbox.update({ where: { id: mailboxId }, data: { ...configuration, canonicalRevision, revision: expectedRevision + 1,
      configuredRevision: expectedRevision + 1, testedRevision: null, testReference: null, testedAt: null, enabled: false } });
    await tx.communicationMailboxHistory.create({ data: { mailboxId, revision: row.revision, action: 'CONFIGURED', actorId: current.userId, snapshot: json(row) } });
    await event(tx, current, null, 'MAILBOX_CONFIGURED', { mailboxId, revision: row.revision, configurationHash: canonicalSha256(configuration) });
    return row;
  });
}

export async function qualifyCommunicationMailbox(db: Db, claimed: AuthSession, raw: unknown) {
  const input = parse(z.object({ mailboxId: uuid, expectedRevision: revision, action: z.enum(['TEST', 'ENABLE', 'DISABLE']), testReference: identifier.optional() }).strict(), raw);
  return db.$transaction(async tx => {
    const current = await actor(tx, claimed, 'practice_communications.read', true);
    await tx.$queryRaw`SELECT "id" FROM "CommunicationMailbox" WHERE "id"=${input.mailboxId}::uuid FOR UPDATE`;
    const before = await tx.communicationMailbox.findUnique({ where: { id: input.mailboxId } });
    if (!before || before.revision !== input.expectedRevision) conflict();
    const qualified = mailboxQualification(mailboxSnapshot(before));
    if (input.action === 'TEST' && (!qualified.configured || !input.testReference || before.testedRevision !== null || before.enabled)) denied();
    if (input.action === 'ENABLE' && (!qualified.tested || !before.canSend || !before.canReceive)) denied();
    if (input.action === 'ENABLE') await responsibleMailbox(tx, before);
    const row = await tx.communicationMailbox.update({ where: { id: before.id }, data: input.action === 'TEST'
      ? { testedRevision: before.revision, testReference: input.testReference, testedAt: new Date(), enabled: false }
      : input.action === 'ENABLE' ? { enabled: true } : { enabled: false, revision: before.revision + 1,
        configuredRevision: qualified.configured ? before.revision + 1 : null, testedRevision: null, testReference: null, testedAt: null } });
    await tx.communicationMailboxHistory.create({ data: { mailboxId: row.id, revision: row.revision, action: input.action, actorId: current.userId, snapshot: json(row) } });
    await event(tx, current, null, `MAILBOX_${input.action}`, { mailboxId: row.id, revision: row.revision, testReference: row.testReference });
    return row;
  });
}

const incomingSchema = z.object({ mailboxId: uuid, externalMessageId: z.string().trim().min(1).max(255).regex(/^[^\s\u0000-\u001f\u007f]+$/),
  inReplyTo: z.string().max(255).nullable(), sender: z.string().email().max(254), subject: z.string().min(1).max(998).refine(s => !/[\u0000-\u001f\u007f]/.test(s)),
  body: z.string().min(1).max(200_000).refine(s => !s.includes('\0')),
  receivedAt: z.string().datetime({ offset: true }), evidenceReference: identifier,
}).strict();
export async function acquireManualReply(db: Db, claimed: AuthSession, raw: unknown) {
  const input = parse(incomingSchema, raw);
  if (new Date(input.receivedAt).getTime() > Date.now() + 60_000) throw new ApprovedCommunicationError('INVALID');
  return db.$transaction(async tx => {
    // Acquisition is not approval of an outgoing message.
    const current = await actor(tx, claimed, 'practice_communications.read', true);
    const box = await mailbox(tx, input.mailboxId, current);
    await responsibleMailbox(tx, box);
    if (!box.canReceive || !mailboxQualification(mailboxSnapshot(box)).tested) throw new ApprovedCommunicationError('SENDER_NOT_READY');
    const canonicalMailboxId = box.canonicalMailboxId ?? box.id;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${canonicalMailboxId + ':' + input.externalMessageId}, 0))`;
    const payload = { externalMessageId: input.externalMessageId, inReplyTo: input.inReplyTo, sender: input.sender,
      subject: input.subject, body: input.body, receivedAt: new Date(input.receivedAt).toISOString() };
    const contentHash = canonicalSha256({ ...payload, canonicalMailboxId });
    const before = await tx.communicationReply.findUnique({ where: { canonicalMailboxId_externalMessageId: { canonicalMailboxId, externalMessageId: input.externalMessageId } } });
    if (before) { if (before.contentHash !== contentHash) conflict(); return before; }
    // Only our exact reference can establish an unambiguous relation. Free text cannot.
    const reference = input.inReplyTo?.match(/^<fai-([a-f0-9-]{36})-v([1-9][0-9]*)@crm\.finanzaagevolaimpresa\.it>$/);
    const version = reference && uuid.safeParse(reference[1]).success && Number.isSafeInteger(Number(reference[2])) && Number(reference[2]) <= 2_147_483_647
      ? await tx.communicationVersion.findUnique({ where: { messageId_revision: { messageId: reference[1], revision: Number(reference[2]) } }, include: { message: { include: { mailbox: true } } } }) : null;
    const candidate = version ? approvedMessageSnapshotSchema.safeParse(version.snapshot) : null;
    const priorAttempt = version ? await tx.communicationAttempt.findFirst({ where: { versionId: version.id } }) : null;
    const messageId = version && priorAttempt && candidate?.success && version.snapshotHash === approvedMessageHash(candidate.data)
      && (!box.restricted || version.message.mailbox.restricted || candidate.data.classification === 'COMPLAINT')
      && (version.message.mailbox.canonicalMailboxId ?? version.message.mailboxId) === canonicalMailboxId
      && [...candidate.data.to, ...candidate.data.cc].some(recipient => recipient.toLowerCase() === input.sender.toLowerCase()) ? version.messageId : null;
    const reply = await tx.communicationReply.create({ data: { ...payload, canonicalMailboxId, contentHash,
      evidenceReference: input.evidenceReference, receivedAt: new Date(input.receivedAt), acquiredById: current.userId, messageId } });
    await event(tx, current, messageId, messageId ? 'REPLY_LINKED_FROM_REFERENCE' : 'REPLY_NEEDS_RECONCILIATION', { replyId: reply.id, contentHash, method: 'MANUAL_ACQUISITION' }, {}, reply.id);
    return reply;
  });
}

export async function linkAmbiguousReply(db: Db, claimed: AuthSession, raw: unknown) {
  const input = parse(z.object({ replyId: uuid, messageId: uuid, reason: z.string().trim().min(10).max(1000) }).strict(), raw);
  return db.$transaction(async tx => {
    const current = await actor(tx, claimed, 'practice_communications.read', true);
    const message = await messageScope(tx, current, input.messageId);
    await tx.$queryRaw`SELECT "id" FROM "CommunicationReply" WHERE "id"=${input.replyId}::uuid FOR UPDATE`;
    const reply = await tx.communicationReply.findUnique({ where: { id: input.replyId } });
    if (!reply || (reply.messageId && reply.messageId !== message.row.id)) conflict();
    const replyMailbox = await tx.communicationMailbox.findUnique({ where: { id: reply.canonicalMailboxId } });
    if (!replyMailbox || (replyMailbox.restricted && !message.box.restricted && message.snapshot.classification !== 'COMPLAINT')) denied();
    if (reply.messageId) return reply;
    const result = await tx.communicationReply.update({ where: { id: reply.id }, data: { messageId: message.row.id, linkedById: current.userId } });
    await event(tx, current, message.row.id, 'REPLY_LINKED_MANUALLY', { replyId: reply.id, reason: input.reason, contentHash: reply.contentHash }, {}, reply.id);
    return result;
  });
}

export async function readCommunicationAdministration(db: Db, claimed: AuthSession) {
  return db.$transaction(async tx => {
    await actor(tx, claimed, 'practice_communications.read', true);
    const mailboxes = [];
    for (const box of await tx.communicationMailbox.findMany({ orderBy: { address: 'asc' } })) mailboxes.push({ ...box, qualification: await effectiveQualification(tx, box) });
    return { mailboxes,
      replies: await tx.communicationReply.findMany({ where: { messageId: null }, orderBy: { createdAt: 'asc' }, take: 100 }),
      users: await tx.user.findMany({ where: { active: true, deletedAt: null }, select: { id: true, name: true }, orderBy: { name: 'asc' } }) };
  });
}
