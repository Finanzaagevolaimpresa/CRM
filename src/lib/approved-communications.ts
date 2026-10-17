import { canAccessFinancialDocument } from './financial-document-access';
import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient, type CommunicationMailbox } from '@prisma/client';
import { z } from 'zod';
import type { AuthSession } from './auth';
import { canViewDocument, canViewTechnicalPractice } from './access-control';
import { canViewPracticeReadinessWork } from './practice-readiness-access';
import { loadClientReadScope } from './client-read-perimeter';
import { loadSelectiveProjectScope } from './selective-project-scope';
import { lockAuthoritativeInternalSession } from './internal-session-registry';
import { hasPermission } from './permission-evaluator';
import type { Permission } from './permissions';
import { canonicalSha256 } from './canonical-json';
import { readAdmittedOrdinaryEmailReceipts } from './ordinary-email-receipt-reader';
import { filterAdmittedOrdinaryReplies, readAdmittedOrdinaryAttachmentMetadata } from './ordinary-email-inbound-reader';
import { readPrivateDocumentBounded } from './storage';
import { buildApprovedMessagePackage } from './approved-message-package';
import { communicationRecordWhere, communicationFileWhere, expandedCommunicationScope, lockedCommunicationRecipients } from './communication-contexts';
import { communicationRecipientSelectionSchema } from './communication-recipient-policy';
import { lockCommunicationDirectory } from './communication-directory-lock';
import { canReadCommunicationFile, communicationFileFitsClassification } from './communication-file-policy';
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

async function readTransaction<T>(db: Db, read: (tx: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.$transaction(read, { timeout: 30_000 });
    } catch (error) {
      const aborted = error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === 'P2034' || (error.code === 'P2010' &&
          (error.meta?.code === '40001' || error.meta?.code === '40P01')));
      // The entire read, including current session and permissions, starts again.
      // Domain denials, connection failures and uncertain outcomes are not retried.
      if (!aborted || attempt === 3) throw error;
    }
  }
}

async function actor(tx: Tx, claimed: AuthSession, permission: Permission, admin = false) {
  if (!claimed.active || claimed.expiresAt * 1000 <= Date.now() || !uuid.safeParse(claimed.sessionId).success) denied();
  await lockCommunicationDirectory(tx);
  const row = await lockAuthoritativeInternalSession(tx, { sessionId: claimed.sessionId!, userId: claimed.userId });
  if (!row || !row.active || !row.live || row.revokedAt || row.deletedAt || (admin && row.role !== 'admin')) denied();
  const current = { ...claimed, ...await loadSelectiveProjectScope(tx, claimed.userId), role: row.role, active: row.active, permissionOverrides: [...row.permissionOverrides],
    clientReadScope: await loadClientReadScope(tx, claimed.userId) } satisfies AuthSession;
  // Context admission below still requires the appropriate permission. Internal
  // participation never grants the unrelated practice permission.
  if (!hasPermission(current, permission)
    && !(permission === 'practice_communications.read' && hasPermission(current, 'communications.internal.read'))) denied();
  return current;
}

async function contextScope(tx: Tx, current: AuthSession, context: CommunicationContext, write = false) {
  if (context.kind !== 'READINESS' && context.kind !== 'TECHNICAL') {
    if (context.kind === 'INTERNAL' && !hasPermission(current, 'communications.internal.read')) denied();
    if (write) {
      const [binding] = await tx.$queryRaw<Array<{ userId: string; enabled: boolean }>>`SELECT "userId","enabled" FROM "OrdinaryEmailAuthority" WHERE "id"='ordinary-email' FOR SHARE`;
      if (current.role !== 'admin' || !binding?.enabled || binding.userId !== current.userId) denied();
    }
    return expandedCommunicationScope(tx, current, context);
  }
  if (!hasPermission(current, 'practice_communications.read')) denied();
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
    || (write && service?.status === 'sospeso') || project?.status === 'archiviato') denied();
  const hydratedProject = project ? { ...project, client } : null;
  const hydratedService = service ? { ...service, client, project: hydratedProject } : null;
  let allowed = false;
  let leadLifecycle: { id: string; createdAt: Date } | null = null;
  if (technical && 'commercialOwnerId' in practice) {
    allowed = canViewTechnicalPractice(current, { ...practice, client, project: hydratedProject, clientService: hydratedService });
  } else if (!technical && 'controlledIntakeId' in practice) {
    await tx.$queryRaw`SELECT "id" FROM "ControlledIntake" WHERE "id"=${practice.controlledIntakeId}::uuid FOR SHARE`;
    const intake = await tx.controlledIntake.findUnique({ where: { id: practice.controlledIntakeId } });
    if (!intake) denied();
    await tx.$queryRaw`SELECT "id" FROM "Lead" WHERE "id"=${intake.leadId} FOR SHARE`;
    const lead = await tx.lead.findUnique({ where: { id: intake.leadId } });
    if (!lead || lead.deletedAt || lead.clientId !== client.id) denied();
    leadLifecycle = await tx.auditLog.findFirst({ where: { entityType: 'Lead', entityId: lead.id, event: 'lead_lifecycle_changed' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true, createdAt: true } });
    allowed = canViewPracticeReadinessWork(current, { ...practice, client, lead, project: hydratedProject, clientService: hydratedService });
  }
  if (!allowed) denied();
  return { context, practice, client, project: hydratedProject, service: hydratedService,
    lead: null, thread: null, participants: null, label: client.displayName, ...(leadLifecycle ? { leadLifecycle } : {}) };
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

async function attachments(tx: Tx, current: AuthSession, scope: Awaited<ReturnType<typeof contextScope>>, ids: string[], runtime: Runtime,
  format: ApprovedMessageSnapshot['schema'] = 'fai.approved-email.v1', contextFileIds: string[] = [], classification = 'ORDINARY') {
  const snapshot: Array<ApprovedMessageSnapshot['attachments'][number]> = [], materials = new Map<string, Buffer>();
  let total = 0;
  let validUntil: Date | null = null;
  if (ids.length + contextFileIds.length > 20 || new Set([...ids, ...contextFileIds]).size !== ids.length + contextFileIds.length) denied();
  for (const versionId of ids.slice().sort()) {
    if (!scope.client) denied();
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
      || !await canAccessFinancialDocument(tx, current, doc) || !canViewDocument(current, { ...doc, client: scope.client, project: doc.projectId ? scope.project : null,
        clientService: doc.clientServiceId ? scope.service : null }, hasPermission(current, 'document.sensitive.read'))) denied();
    let bytes: Buffer;
    try { bytes = await (runtime.readDocument ?? readPrivateDocumentBounded)(version.storagePath, 20 * 1024 * 1024 - total); }
    catch { denied(); }
    total += bytes.length;
    if (digest(bytes) !== version.checksum) denied();
    if (doc.validUntil && (!validUntil || doc.validUntil < validUntil)) validUntil = doc.validUntil;
    snapshot.push({ documentId: doc.id, versionId, sha256: version.checksum, filename: doc.fileName, mimeType: doc.mimeType, bytes: bytes.length,
      ...(format === 'fai.approved-email.v2' ? { source: 'DOCUMENT' as const } : {}) });
    materials.set(versionId, bytes);
  }
  for (const fileId of contextFileIds.slice().sort()) {
    if (format !== 'fai.approved-email.v2') denied();
    await tx.$queryRaw`SELECT "id" FROM "CommunicationContextFile" WHERE "id"=${fileId}::uuid FOR SHARE`;
    const file = await tx.communicationContextFile.findFirst({ where: { id: fileId, revokedAt: null, ...communicationFileWhere(scope.context) } });
    if (!file || !canReadCommunicationFile(current, file.classification) || !communicationFileFitsClassification(file.classification, classification)) denied();
    let bytes: Buffer;
    try { bytes = await (runtime.readDocument ?? readPrivateDocumentBounded)(file.storagePath, 20 * 1024 * 1024 - total); }
    catch { denied(); }
    total += bytes.length;
    if (bytes.length !== file.sizeBytes || digest(bytes) !== file.sha256) denied();
    snapshot.push({ source: 'CONTEXT_FILE', documentId: file.id, versionId: file.id, sha256: file.sha256,
      filename: file.fileName, mimeType: file.mimeType, bytes: file.sizeBytes });
    materials.set(file.id, bytes);
  }
  return { snapshot, materials, validUntil };
}

async function snapshotAttachments(tx: Tx, current: AuthSession, scope: Awaited<ReturnType<typeof contextScope>>,
  snapshot: ApprovedMessageSnapshot, runtime: Runtime) {
  const contextFile = (file: ApprovedMessageSnapshot['attachments'][number]) => 'source' in file && file.source === 'CONTEXT_FILE';
  return attachments(tx, current, scope, snapshot.attachments.filter(file => !contextFile(file)).map(file => file.versionId), runtime,
    snapshot.schema, snapshot.attachments.filter(contextFile).map(file => file.versionId), snapshot.classification);
}

async function revalidateSnapshotRecipients(tx: Tx, scope: Awaited<ReturnType<typeof contextScope>>, snapshot: ApprovedMessageSnapshot) {
  if (snapshot.schema !== 'fai.approved-email.v2') return;
  if (snapshot.contextEvidenceHash !== canonicalSha256(JSON.parse(JSON.stringify(scope)))) conflict();
  const resolved = await lockedCommunicationRecipients(tx, snapshot.recipientSelection, snapshot.externalRecipients,
    scope.context.kind === 'INTERNAL' ? scope.participants!.map(person => person.userId) : undefined);
  if (resolved.evidenceHash !== snapshot.recipientEvidenceHash
    || canonicalSha256(resolved.recipients) !== canonicalSha256({ to: snapshot.to, cc: snapshot.cc, bcc: snapshot.bcc })) conflict();
}

async function assertCurrentClock(tx: Tx, current: AuthSession, attachmentExpiry?: Date | null) {
  const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
  const session = await tx.internalSession.findUnique({ where: { id: current.sessionId! }, select: { expiresAt: true } });
  if (!session || clock.now.getTime() >= Math.min(current.expiresAt * 1000, session.expiresAt.getTime(), attachmentExpiry?.getTime() ?? Infinity)) denied();
}

async function event(tx: Tx, current: AuthSession, messageId: string | null, code: string, evidence: unknown, runtime: Runtime = {}, replyId: string | null = null) {
  if (runtime.failAudit) throw new Error('SYNTHETIC_M4_AUDIT_FAILURE');
  await tx.communicationEvent.create({ data: { actorId: current.userId, messageId, replyId, event: code, evidence: json(evidence) } });
  await tx.auditLog.create({ data: { actorId: current.userId, event: `m4_${code.toLowerCase()}`, entityType: 'ApprovedCommunication',
    entityId: messageId ?? replyId, after: { operation: code, evidenceHash: canonicalSha256(evidence) } } });
}

function rowContext(row: { readinessId: string | null; technicalPracticeId: string | null;
  contextKind: string; clientId: string | null; leadId: string | null; internalThreadId: string | null }): CommunicationContext {
  if (row.contextKind === 'LEAD' && row.leadId) return { kind: 'LEAD', id: row.leadId };
  if (row.contextKind === 'CLIENT' && row.clientId) return { kind: 'CLIENT', id: row.clientId };
  if (row.contextKind === 'INTERNAL' && row.internalThreadId) return { kind: 'INTERNAL', id: row.internalThreadId };
  if (row.contextKind !== 'LEGACY') return denied();
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
  if (!version || row.clientId !== (scope.client?.id ?? null)) denied();
  const snapshot = parse(approvedMessageSnapshotSchema, version.snapshot);
  if (snapshot.messageId !== row.id || snapshot.clientId !== row.clientId || snapshot.revision !== row.currentRevision
    || canonicalSha256(snapshot.context) !== canonicalSha256(rowContext(row)) || snapshot.mailboxId !== row.mailboxId
    || approvedMessageHash(snapshot) !== version.snapshotHash) denied();
  const box = await mailbox(tx, row.mailboxId, current, snapshot.classification);
  return { row, version, snapshot, scope, box };
}

// Consultation and notification metadata share the same attachment admission.
// All locks are retained by the caller's transaction through its final clock check.
async function readableMessageAttachments(tx: Tx, current: AuthSession, detail: Awaited<ReturnType<typeof messageScope>>) {
  const { scope, snapshot } = detail;
  let messageUntil = Infinity;
  for (const file of snapshot.attachments.slice().sort((a, b) => a.versionId.localeCompare(b.versionId))) {
    if ('source' in file && file.source === 'CONTEXT_FILE') {
      await tx.$queryRaw`SELECT "id" FROM "CommunicationContextFile" WHERE "id"=${file.versionId}::uuid FOR SHARE`;
      const stored = await tx.communicationContextFile.findFirst({ where: { id: file.versionId, revokedAt: null, ...communicationFileWhere(scope.context) } });
      if (!stored || stored.id !== file.documentId || stored.sha256 !== file.sha256 || stored.sizeBytes !== file.bytes
        || !canReadCommunicationFile(current, stored.classification)) return null;
      continue;
    }
    await tx.$queryRaw`SELECT "id" FROM "DocumentVersion" WHERE "id"=${file.versionId} FOR SHARE`;
    const storedVersion = await tx.documentVersion.findUnique({ where: { id: file.versionId } });
    await tx.$queryRaw`SELECT "id" FROM "Document" WHERE "id"=${file.documentId} FOR SHARE`;
    const doc = await tx.document.findUnique({ where: { id: file.documentId } });
    if (!doc || doc.deletedAt || !storedVersion || storedVersion.documentId !== doc.id || storedVersion.checksum !== file.sha256
      || ['respinto', 'scaduto', 'archiviato'].includes(doc.status) || (doc.validUntil && doc.validUntil.getTime() <= Date.now())
      || !scope.client || doc.clientId !== scope.client.id || (doc.projectId && doc.projectId !== scope.project?.id)
      || (doc.clientServiceId && doc.clientServiceId !== scope.service?.id)
      || !await canAccessFinancialDocument(tx, current, doc) || !canViewDocument(current, { ...doc, client: scope.client,
        project: doc.projectId ? scope.project : null, clientService: doc.clientServiceId ? scope.service : null },
      hasPermission(current, 'document.sensitive.read'))) return null;
    if (doc.validUntil) messageUntil = Math.min(messageUntil, doc.validUntil.getTime());
  }
  return messageUntil;
}

/** Current native source admission, without exposing any communication content.
 * The caller must supply its locked current actor and check the returned expiry
 * against the DB clock before returning data or committing a read receipt. */
export async function admitCommunicationNotice(tx: Tx, current: AuthSession, context: CommunicationContext,
  messageId: string, replyId?: string) {
  if (!hasPermission(current, 'practice_communications.read')) return null;
  try {
    const detail = await messageScope(tx, current, messageId);
    if (canonicalSha256(detail.scope.context) !== canonicalSha256(context) || (!replyId && detail.row.state !== 'SENT')) return null;
    const accessUntil = await readableMessageAttachments(tx, current, detail);
    if (accessUntil === null) return null;
    if (replyId) {
      await tx.$queryRaw`SELECT "id" FROM "CommunicationReply" WHERE "id"=${replyId}::uuid FOR SHARE`;
      const reply = await tx.communicationReply.findUnique({ where: { id: replyId } });
      if (!reply?.linkedById || reply.messageId !== messageId || !(await filterAdmittedOrdinaryReplies(tx, [reply])).length) return null;
    }
    return { accessUntil };
  } catch (error) {
    if (error instanceof ApprovedCommunicationError) return null;
    throw error;
  }
}

const editSchema = z.object({
  messageId: uuid, expectedRevision: z.number().int().nonnegative(), context: communicationContextSchema,
  mailboxId: uuid, replyTo: z.string().email().max(254), to: z.array(z.string()).max(20), cc: z.array(z.string()).max(20), bcc: z.array(z.string()).max(20),
  subject: z.string(), body: z.string(), attachmentVersionIds: z.array(identifier).max(20),
  classification: z.enum(['ORDINARY', 'SENSITIVE', 'COMPLAINT']),
  recipientSelection: communicationRecipientSelectionSchema.optional(),
  contextFileIds: z.array(uuid).max(20).default([]),
  replySource: z.object({ id: uuid, contentHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
}).strict();

/** Server-only building block for the isolated ordinary-mail persistence
 * candidate. Reuses M4 locks and current document/financial/ABAC checks. It is
 * not a route, a manual approval conversion or a transport authorization. */
export async function loadOrdinaryMessageCandidateContext(tx: Tx, claimed: AuthSession, messageId: string, runtime: Runtime = {}) {
  uuid.parse(messageId);
  const current = await actor(tx, claimed, 'practice_communications.mark_used', true);
  if (!hasPermission(current, 'practice_communications.read')) denied();
  const loaded = await messageScope(tx, current, messageId, true);
  await revalidateSnapshotRecipients(tx, loaded.scope, loaded.snapshot);
  if (!mailboxQualification(mailboxSnapshot(loaded.box)).enabled) denied();
  await responsibleMailbox(tx, loaded.box);
  const files = await snapshotAttachments(tx, current, loaded.scope, loaded.snapshot, runtime);
  if (canonicalSha256(files.snapshot) !== canonicalSha256(loaded.snapshot.attachments)) conflict();
  const registry = await lockAuthoritativeInternalSession(tx, { userId: current.userId, sessionId: current.sessionId! });
  if (!registry || registry.revokedAt || registry.deletedAt || !registry.active) denied();
  const contextHash = canonicalSha256(JSON.parse(JSON.stringify({ scope: loaded.scope,
    actorId: current.userId, role: current.role, overrides: current.permissionOverrides,
    clientReadScope: [...(current.clientReadScope ?? [])].sort(),
    selectiveProjectIds: [...(current.selectiveProjectIds ?? [])].sort() })));
  return { ...loaded, materials: files.materials, contextHash, contextExpiresAt: files.validUntil ?? undefined,
    actor: { userId: current.userId, sessionId: current.sessionId!, role: registry.role, active: registry.active,
      expiresAt: new Date(current.expiresAt * 1000), registryExpiresAt: registry.expiresAt } };
}

/** Private inbound association: current reader, no impersonated session or
 * personal-send approval. Reuse native context, financial and document gates. */
export async function loadOrdinaryReplyCandidateContext(tx: Tx, claimed: AuthSession, messageId: string, runtime: Runtime = {}) {
  uuid.parse(messageId);
  const current = await actor(tx, claimed, 'practice_communications.read');
  const loaded = await messageScope(tx, current, messageId);
  const files = await snapshotAttachments(tx, current, loaded.scope, loaded.snapshot, runtime);
  if (canonicalSha256(files.snapshot) !== canonicalSha256(loaded.snapshot.attachments)) denied();
  const registry = await tx.internalSession.findUnique({ where: { id: current.sessionId! } });
  if (!registry) denied();
  return { ...loaded, current, accessUntil: Math.min(current.expiresAt * 1000, registry.expiresAt.getTime(), files.validUntil?.getTime() ?? Infinity) };
}

export async function saveApprovedMessageDraft(db: Db, claimed: AuthSession, raw: unknown, runtime: Runtime = {}) {
  const input = parse(editSchema, raw);
  return db.$transaction(async tx => {
    const current = await actor(tx, claimed, 'practice_communications.write');
    if (!['READINESS', 'TECHNICAL'].includes(input.context.kind) && current.role !== 'admin') denied();
    const scope = await contextScope(tx, current, input.context, true);
    const box = await mailbox(tx, input.mailboxId, current, input.classification);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${input.messageId}, 0))`;
    const existing = await tx.approvedCommunication.findUnique({ where: { id: input.messageId } });
    let replyAccessUntil = Infinity;
    if (input.replySource) {
      // The source is checked again when saving, not trusted from the rendered
      // page. A later conflict, revocation or archive makes a stale form fail.
      if (existing || input.expectedRevision !== 0) conflict();
      const reply = await tx.communicationReply.findUnique({ where: { id: input.replySource.id } });
      if (!reply?.messageId || reply.contentHash !== input.replySource.contentHash) denied();
      const parent = await loadOrdinaryReplyCandidateContext(tx,current,reply.messageId,runtime);
      if (canonicalSha256(parent.scope.context) !== canonicalSha256(input.context)
        || (parent.box.restricted && !box.restricted)
        || (parent.snapshot.classification === 'COMPLAINT' && input.classification !== 'COMPLAINT')
        || (parent.snapshot.classification === 'SENSITIVE' && input.classification === 'ORDINARY')
        || (await filterAdmittedOrdinaryReplies(tx,[reply])).length !== 1) denied();
      replyAccessUntil = parent.accessUntil;
    }
    if (existing) {
      const prior = await messageScope(tx, current, input.messageId, true);
      if (prior.row.currentRevision !== input.expectedRevision || ['SENDING', 'UNCERTAIN', 'SENT'].includes(prior.row.state)
        || canonicalSha256(rowContext(prior.row)) !== canonicalSha256(input.context)) conflict();
      if ((prior.box.restricted && !box.restricted)
        || (prior.snapshot.classification === 'COMPLAINT' && input.classification !== 'COMPLAINT')
        || (prior.snapshot.classification === 'SENSITIVE' && input.classification === 'ORDINARY')) denied();
    } else if (input.expectedRevision !== 0) conflict();
    const useV2 = !!input.recipientSelection || input.contextFileIds.length > 0 || !['READINESS', 'TECHNICAL'].includes(input.context.kind);
    const format = useV2 ? 'fai.approved-email.v2' : 'fai.approved-email.v1';
    const selection = input.recipientSelection ?? { to: { userIds: [], groups: [] }, cc: { userIds: [], groups: [] }, bcc: { userIds: [], groups: [] } };
    const externalRecipients = { to: input.to, cc: input.cc, bcc: input.bcc };
    const resolved = useV2 ? await lockedCommunicationRecipients(tx, selection, externalRecipients,
      scope.context.kind === 'INTERNAL' ? scope.participants!.map(person => person.userId) : undefined) : null;
    const files = await attachments(tx, current, scope, input.attachmentVersionIds, runtime, format, input.contextFileIds, input.classification);
    const snapshot = parse(approvedMessageSnapshotSchema, { schema: format, messageId: input.messageId,
      revision: input.expectedRevision + 1, context: input.context, clientId: scope.client?.id ?? null, channel: 'EMAIL_MANUAL',
      mailboxId: box.id, mailboxRevision: box.revision, from: box.address, replyTo: input.replyTo,
      ...(resolved?.recipients ?? externalRecipients), subject: input.subject, body: input.body, attachments: files.snapshot, classification: input.classification,
      ...(resolved ? { recipientSelection: resolved.selection, externalRecipients, recipientEvidenceHash: resolved.evidenceHash,
        contextEvidenceHash: canonicalSha256(JSON.parse(JSON.stringify(scope))) } : {}) });
    if (!existing) await tx.approvedCommunication.create({ data: { id: input.messageId, clientId: scope.client?.id ?? null,
      contextKind: ['READINESS', 'TECHNICAL'].includes(input.context.kind) ? 'LEGACY' : input.context.kind,
      leadId: input.context.kind === 'LEAD' ? input.context.id : null,
      internalThreadId: input.context.kind === 'INTERNAL' ? input.context.id : null,
      readinessId: input.context.kind === 'READINESS' ? input.context.id : null,
      technicalPracticeId: input.context.kind === 'TECHNICAL' ? input.context.id : null, mailboxId: box.id, createdById: current.userId } });
    else await tx.approvedCommunication.update({ where: { id: input.messageId }, data: { currentRevision: snapshot.revision, mailboxId: box.id, state: 'DRAFT' } });
    const saved = await tx.communicationVersion.create({ data: { messageId: input.messageId, revision: snapshot.revision,
      snapshot: json(snapshot), snapshotHash: approvedMessageHash(snapshot), createdById: current.userId } });
    await event(tx, current, input.messageId, 'DRAFT_SAVED', { revision: snapshot.revision, snapshotHash: saved.snapshotHash, priorApprovalInvalidated: !!existing,
      ...(input.replySource ? { sourceHash: input.replySource.contentHash } : {}) }, runtime, input.replySource?.id ?? null);
    const [now] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    const registry = await tx.internalSession.findUnique({ where: { id: current.sessionId! }, select: { expiresAt: true } });
    if (!registry || now.now.getTime() >= Math.min(current.expiresAt * 1000, registry.expiresAt.getTime(), replyAccessUntil, files.validUntil?.getTime() ?? Infinity)) denied();
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
    if (row.state === 'PENDING') { await assertCurrentClock(tx, current); return; }
    await tx.approvedCommunication.update({ where: { id: row.id }, data: { state: 'PENDING' } });
    await event(tx, current, row.id, 'APPROVAL_REQUESTED', { revision: row.currentRevision, snapshotHash: version.snapshotHash });
    await assertCurrentClock(tx, current);
  });
}

export async function approveExactMessage(db: Db, claimed: AuthSession, raw: unknown, runtime: Runtime = {}) {
  const input = parse(transitionSchema, raw);
  return db.$transaction(async tx => {
    const current = await actor(tx, claimed, 'practice_communications.read', true);
    const { row, version, snapshot, scope, box } = await messageScope(tx, current, input.messageId, true);
    await revalidateSnapshotRecipients(tx, scope, snapshot);
    if (row.currentRevision !== input.expectedRevision || version.snapshotHash !== input.snapshotHash || !['PENDING', 'APPROVED'].includes(row.state)) conflict();
    if (scope.leadLifecycle && scope.leadLifecycle.createdAt >= version.createdAt) conflict();
    if (snapshot.mailboxRevision !== box.revision || snapshot.from !== box.address) conflict();
    if (!mailboxQualification(mailboxSnapshot(box)).enabled) throw new ApprovedCommunicationError('SENDER_NOT_READY');
    await responsibleMailbox(tx, box);
    const files = await snapshotAttachments(tx, current, scope, snapshot, runtime);
    if (canonicalSha256(files.snapshot) !== canonicalSha256(snapshot.attachments)) conflict();
    if (version.approval) { await assertCurrentClock(tx, current, files.validUntil); return { approvalId: version.approval.id }; }
    const approval = await tx.communicationApproval.create({ data: { versionId: version.id, snapshotHash: version.snapshotHash,
      mailboxRevision: box.revision, approverUserId: current.userId, approverSessionId: current.sessionId! } });
    await tx.approvedCommunication.update({ where: { id: row.id }, data: { state: 'APPROVED' } });
    await event(tx, current, row.id, 'EXACT_MESSAGE_APPROVED', { approvalId: approval.id, revision: row.currentRevision, snapshotHash: version.snapshotHash }, runtime);
    await assertCurrentClock(tx, current, files.validUntil);
    return { approvalId: approval.id };
  }, { timeout: 30_000 });
}

export async function prepareManualMessage(db: Db, claimed: AuthSession, raw: unknown, runtime: Runtime = {}) {
  const input = parse(transitionSchema.extend({ requestId: uuid }).strict(), raw);
  return db.$transaction(async tx => {
    const current = await actor(tx, claimed, 'practice_communications.mark_used');
    const { row, version, snapshot, scope, box } = await messageScope(tx, current, input.messageId, true);
    await revalidateSnapshotRecipients(tx, scope, snapshot);
    if (row.currentRevision !== input.expectedRevision || version.snapshotHash !== input.snapshotHash || !version.approval) conflict();
    const approval = version.approval;
    if (scope.leadLifecycle && scope.leadLifecycle.createdAt >= approval.approvedAt) conflict();
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
    const files = await snapshotAttachments(tx, current, scope, snapshot, runtime);
    if (canonicalSha256(files.snapshot) !== canonicalSha256(snapshot.attachments)) conflict();
    const bytes = buildApprovedMessagePackage(snapshot, files.materials), artifactHash = digest(bytes);
    if (previous && previous.artifactHash !== artifactHash) denied();
    const attempt = previous ?? await tx.communicationAttempt.create({ data: { requestId: input.requestId, messageId: row.id,
      versionId: version.id, approvalId: approval.id, startedById: current.userId, startedSessionId: current.sessionId!, artifactHash } });
    if (!previous) {
      await tx.approvedCommunication.update({ where: { id: row.id }, data: { state: 'SENDING' } });
      await event(tx, current, row.id, 'MANUAL_ATTEMPT_PREPARED', { attemptId: attempt.id, revision: row.currentRevision, artifactHash, method: 'MANUAL_EXTERNAL' }, runtime);
    }
    await assertCurrentClock(tx, current, new Date(Math.min(approvingUser.expiresAt.getTime(), files.validUntil?.getTime() ?? Infinity)));
    return { attemptId: attempt.id, artifactHash, bytes };
  }, { timeout: 30_000 });
}

export async function recordManualMessageEvidence(db: Db, claimed: AuthSession, raw: unknown, runtime: Runtime = {}) {
  const input = parse(z.object({ messageId: uuid, attemptId: uuid, reconciliation: z.boolean(), evidence: manualMessageEvidenceSchema }).strict(), raw);
  return db.$transaction(async tx => {
    const current = await actor(tx, claimed, 'practice_communications.mark_used', input.reconciliation);
    const { row } = await messageScope(tx, current, input.messageId, true);
    const attempt = await tx.communicationAttempt.findUnique({ where: { id: input.attemptId } });
    if (!attempt || attempt.messageId !== row.id || (!input.reconciliation && attempt.startedById !== current.userId && current.role !== 'admin')) denied();
    const evidenceHash = canonicalSha256(input.evidence);
    if (attempt.evidenceHash === evidenceHash) { await assertCurrentClock(tx, current); return { state: attempt.state }; }
    if (new Date(input.evidence.occurredAt).getTime() > Date.now() + 60_000 || new Date(input.evidence.occurredAt).getTime() < attempt.createdAt.getTime() - 60_000) denied();
    const state = nextManualMessageState(attempt.state as ApprovedMessageState, input.evidence.outcome, input.reconciliation);
    if (row.state !== attempt.state) conflict();
    await tx.communicationAttempt.update({ where: { id: attempt.id }, data: { state, evidence: json(input.evidence), evidenceHash } });
    await tx.approvedCommunication.update({ where: { id: row.id }, data: { state } });
    await event(tx, current, row.id, input.reconciliation ? 'MANUAL_OUTCOME_RECONCILED' : 'MANUAL_OUTCOME_RECORDED', {
      attemptId: attempt.id, priorEvidenceHash: attempt.evidenceHash, evidence: input.evidence, evidenceHash,
    }, runtime);
    await assertCurrentClock(tx, current);
    return { state };
  });
}

export async function readPracticeCommunications(db: Db, claimed: AuthSession, rawContext: unknown, page = 1) {
  const context = parse(communicationContextSchema, rawContext);
  if (!Number.isSafeInteger(page) || page < 1 || page > 200) throw new ApprovedCommunicationError('INVALID');
  return readTransaction(db, async tx => {
    const current = await actor(tx, claimed, 'practice_communications.read');
    const scope = await contextScope(tx, current, context);
    const registry = await tx.internalSession.findUnique({ where: { id: current.sessionId! }, select: { expiresAt: true } });
    if (!registry) denied();
    let accessUntil = Math.min(current.expiresAt * 1000, registry.expiresAt.getTime());
    const rows = await tx.approvedCommunication.findMany({ where: communicationRecordWhere(context),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * 100, take: 101 });
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
      const [events, attempts, storedReplies] = await Promise.all([
        tx.communicationEvent.findMany({ where: { messageId: row.id }, orderBy: { createdAt: 'asc' }, take: 200 }),
        tx.communicationAttempt.findMany({ where: { messageId: row.id }, orderBy: { createdAt: 'desc' }, take: 50 }),
        tx.communicationReply.findMany({ where: { messageId: row.id }, orderBy: { receivedAt: 'asc' }, take: 100 }),
      ]);
      const messageUntil = await readableMessageAttachments(tx, current, detail);
      if (messageUntil === null) continue;
      const replies = await filterAdmittedOrdinaryReplies(tx,storedReplies);
      const receivedAttachments = await readAdmittedOrdinaryAttachmentMetadata(tx, replies, current);
      // Only admitted messages reach the receipt query. Locks stay held until
      // the final DB-clock expiry check; consultation needs no new step-up.
      const ordinaryReceipts = await readAdmittedOrdinaryEmailReceipts(tx, row.id);
      accessUntil = Math.min(accessUntil, messageUntil);
      messages.push({ ...detail.row, versions: detail.row.versions.map(v => ({ id: v.id, revision: v.revision, snapshotHash: v.snapshotHash, createdAt: v.createdAt })),
        snapshot: detail.snapshot, snapshotHash: detail.version.snapshotHash, events, attempts,
        replies: replies.map(reply => ({ ...reply, receivedAttachments: receivedAttachments.get(reply.id) ?? [] })), ordinaryReceipts });
    }
    const boxes = await tx.communicationMailbox.findMany({ where: current.role === 'admin' ? {} : { restricted: false }, orderBy: { address: 'asc' } });
    const documents = [];
    if (scope.client && hasPermission(current, 'document.download')) {
      const candidates = await tx.document.findMany({ where: { clientId: scope.client.id, deletedAt: null }, orderBy: { updatedAt: 'desc' }, take: 100 });
      for (const doc of candidates) {
        if ((doc.projectId && doc.projectId !== scope.project?.id) || (doc.clientServiceId && doc.clientServiceId !== scope.service?.id)
          || !await canAccessFinancialDocument(tx, current, doc) || !canViewDocument(current, { ...doc, client: scope.client, project: doc.projectId ? scope.project : null,
            clientService: doc.clientServiceId ? scope.service : null }, hasPermission(current, 'document.sensitive.read'))) continue;
        const versions = await tx.documentVersion.findMany({ where: { documentId: doc.id }, orderBy: { version: 'desc' }, take: 5 });
        documents.push({ id: doc.id, title: doc.title, versions: versions.map(v => ({ id: v.id, version: v.version })) });
      }
    }
    const boxesWithQualification = [];
    for (const box of boxes) boxesWithQualification.push({ ...box, qualification: await effectiveQualification(tx, box) });
    const directory = current.role === 'admin' ? await tx.user.findMany({ where: { active: true, deletedAt: null },
      select: { id: true, name: true, email: true, role: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }] }) : [];
    const [personalBinding] = current.role === 'admin' ? await tx.$queryRaw<Array<{ userId: string; enabled: boolean }>>`
      SELECT "userId","enabled" FROM "OrdinaryEmailAuthority" WHERE "id"='ordinary-email' FOR SHARE` : [];
    const personal = personalBinding?.enabled === true && personalBinding.userId === current.userId;
    const suggestedRecipients: Array<{ name: string; address: string }> = [];
    if (personal) {
      if (scope.lead?.email) suggestedRecipients.push({ name: scope.label, address: scope.lead.email });
      if (scope.client && hasPermission(current,'company.read')) {
        const contacts = await tx.$queryRaw<Array<{ firstName: string; lastName: string; email: string }>>`
          SELECT DISTINCT p."firstName",p."lastName",p."email" FROM "Person" p
          JOIN "CompanyPerson" cp ON cp."personId"=p."id" JOIN "Company" c ON c."id"=cp."companyId"
          WHERE c."clientId"=${scope.client.id} AND c."deletedAt" IS NULL AND p."deletedAt" IS NULL AND p."email" IS NOT NULL
          ORDER BY p."lastName",p."firstName",p."email" LIMIT 50`;
        for (const person of contacts) if (z.string().email().safeParse(person.email).success
          && !suggestedRecipients.some(item=>item.address.toLowerCase()===person.email.toLowerCase()))
          suggestedRecipients.push({ name: `${person.firstName} ${person.lastName}`, address: person.email });
      }
    }
    const contextFiles = (await tx.communicationContextFile.findMany({ where: { ...communicationFileWhere(context), revokedAt: null },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take: 100 })).filter(file => canReadCommunicationFile(current, file.classification))
      .map(({ id, fileName, mimeType, sizeBytes, classification, sha256 }) => ({ id, fileName, mimeType, sizeBytes, classification, sha256 }));
    const [finished] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    if (finished.now.getTime() >= accessUntil) denied();
    return { context, label: scope.label, client: scope.client ? { id: scope.client.id, name: scope.client.displayName } : null,
      messages, documents, contextFiles, directory, thread: scope.thread, participantIds: scope.participants?.map(person => person.userId),
      suggestedRecipients,
      page, hasMore: rows.length > 100 && page < 200,
      mailboxes: boxesWithQualification,
      canWrite: hasPermission(current, 'practice_communications.write') && (['READINESS','TECHNICAL'].includes(context.kind) || personal),
      canPrepare: hasPermission(current, 'practice_communications.mark_used') && (['READINESS','TECHNICAL'].includes(context.kind) || personal),
      isAdmin: current.role === 'admin', personal };
  });
}

/** Authenticated context-file operations reuse every native context gate. */
export async function loadCommunicationFileContext(tx: Tx, claimed: AuthSession, rawContext: unknown, write: boolean) {
  const context = parse(communicationContextSchema, rawContext);
  const current = await actor(tx, claimed, write ? 'practice_communications.write' : 'practice_communications.read', write);
  const scope = await contextScope(tx, current, context, write);
  if (write) {
    const [binding] = await tx.$queryRaw<Array<{ userId: string; enabled: boolean }>>`SELECT "userId","enabled" FROM "OrdinaryEmailAuthority" WHERE "id"='ordinary-email' FOR SHARE`;
    if (!binding?.enabled || binding.userId !== current.userId) denied();
  }
  const check = async () => {
    const [time] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    const session = await tx.internalSession.findUnique({ where: { id: current.sessionId! }, select: { expiresAt: true } });
    if (!session || time.now.getTime() >= Math.min(current.expiresAt * 1000, session.expiresAt.getTime())) denied();
  };
  await check();
  return { current, scope, check };
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
  return readTransaction(db, async tx => {
    await actor(tx, claimed, 'practice_communications.read', true);
    const mailboxes = [];
    for (const box of await tx.communicationMailbox.findMany({ orderBy: { address: 'asc' } })) mailboxes.push({ ...box, qualification: await effectiveQualification(tx, box) });
    return { mailboxes,
      replies: await tx.communicationReply.findMany({ where: { messageId: null }, orderBy: { createdAt: 'asc' }, take: 100 }),
      users: await tx.user.findMany({ where: { active: true, deletedAt: null }, select: { id: true, name: true }, orderBy: { name: 'asc' } }) };
  });
}
