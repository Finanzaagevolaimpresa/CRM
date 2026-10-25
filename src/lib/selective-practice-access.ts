import { selectedDocumentMode } from './selected-document-formats';
import { selectedDocumentResponseMime } from './selected-document-content';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { AuthSession } from './auth';
import { canViewTechnicalPractice } from './access-control';
import { loadClientReadScope } from './client-read-perimeter';
import { loadActivePrivilegedStepUpKey, lockRegisteredPrivilegedStepUpKey } from './application-key-registry';
import { privilegedAccessMode } from './application-security-policy';
import { canonicalSha256 } from './canonical-json';
import { lockCommunicationDirectory } from './communication-directory-lock';
import { lockAuthoritativeInternalSession, lockInternalUser, tokenDigestFromCookie } from './internal-session-registry';
import { acquireLeadIdentityWriteLock } from './lead-identity';
import { hasPermission } from './permission-evaluator';
import { verifyPrivilegedStepUpToken, type PrivilegedStepUpKey } from './privileged-step-up-token';
import { internalSessionMode } from './session';
import { withSerializableTransaction } from './serializable';
import { loadPersonalSelectiveProjectScope, loadSelectiveProjectScope } from './selective-project-scope';
import { hasSelectiveContext } from './selective-project-policy';
import { hasSelectiveClientContext } from './selective-client-policy';
import { practiceFieldProjection, selectivePracticeSelectionSchema, type SelectivePracticeSelection, type SelectivePracticeScope } from './selective-practice-policy';
import { createSelectivePracticePreview, readSelectivePracticePreview } from './selective-practice-preview';
import { readSelectivePracticeGrant, selectivePracticeGrantPayloadSchema, type SelectivePracticeGrantPayload } from './selective-practice-grant';
import { selectivePracticeProof, verifySelectivePracticeProof } from './selective-practice-proof';

import { listPracticeDocumentOptions, selectPracticeDocuments } from './selective-practice-documents';
import { maxPracticeDocumentBytes, maxPracticeDocuments, type PracticeDocumentContext } from './selective-practice-document-policy';

type Tx = Prisma.TransactionClient;
export type PracticeSharingCredentials = { key: PrivilegedStepUpKey; sessionToken: string; stepUpToken: string };
export class PracticeSharingError extends Error {
  constructor(readonly code: 'DENIED' | 'STALE' | 'UNAVAILABLE') { super(`SELECTIVE_PRACTICE_${code}`); }
}
function deny(): never { throw new PracticeSharingError('DENIED'); }
function stale(): never { throw new PracticeSharingError('STALE'); }
const asJson = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value));
async function clock(tx: Tx) {
  const [row] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
  if (!row) throw new PracticeSharingError('UNAVAILABLE');
  return row.now;
}
function allowed(actor: Pick<AuthSession, 'role' | 'active' | 'permissionOverrides'>, write = false) {
  const codes = write ? ['technical.read', 'technical.write'] as const : ['technical.read'] as const;
  return actor.active && codes.every(code => hasPermission(actor, code)
    && !actor.permissionOverrides.some(item => item.permission === code && !item.allowed));
}
async function liveUser(tx: Tx, id: string) {
  const user = await tx.user.findUnique({ where: { id }, include: { permissionOverrides: true } });
  if (!user || !user.active || user.deletedAt) deny();
  return user;
}
async function sessionLive(tx: Tx, current: AuthSession & { registryExpiresAt: Date }) {
  const now = await clock(tx);
  if (!Number.isFinite(current.expiresAt) || current.expiresAt * 1000 <= now.getTime() || current.registryExpiresAt <= now) deny();
  return now;
}
async function personal(tx: Tx, current: AuthSession, proof: PracticeSharingCredentials) {
  const now = await clock(tx);
  const session = await tx.internalSession.findUnique({ where: { id: current.sessionId! }, select: { tokenDigest: true } });
  const digest = await tokenDigestFromCookie(proof.sessionToken);
  if (privilegedAccessMode() !== 'enforced' || !session || !digest || digest.length !== session.tokenDigest.length
    || !timingSafeEqual(digest, session.tokenDigest) || !verifyPrivilegedStepUpToken({ key: proof.key,
      expectedUserId: current.userId, sessionToken: proof.sessionToken, token: proof.stepUpToken,
      nowSeconds: Math.floor(now.getTime() / 1000) })) deny();
}

/** Key → directory → conversion identity → ordered users/session → client → practice → service → ordered projects. All state is
 * reread after locks. Management and projection reads create no grants; successful document bytes have a minimized access audit. */
async function transaction<T>(db: PrismaClient, claimed: AuthSession, recipientId: string | null,
  proof: PracticeSharingCredentials | null, work: (tx: Tx, state: {
    current: AuthSession & SelectivePracticeScope & { registryExpiresAt: Date }; key: PrivilegedStepUpKey;
    binding: NonNullable<Awaited<ReturnType<Tx['selectivePracticeAuthority']['findUnique']>>>;
    authorityUser: Awaited<ReturnType<typeof liveUser>>; actor: Awaited<ReturnType<typeof liveUser>>;
  }) => Promise<T>) {
  return withSerializableTransaction(db, async tx => {
    if (internalSessionMode() !== 'registry' || !z.string().uuid().safeParse(claimed.sessionId).success) deny();
    const key = proof?.key ?? await loadActivePrivilegedStepUpKey(tx);
    if (!key || !await lockRegisteredPrivilegedStepUpKey(tx, key)) throw new PracticeSharingError('UNAVAILABLE');
    await lockCommunicationDirectory(tx);
    await acquireLeadIdentityWriteLock(tx);
    await tx.$queryRaw`SELECT id FROM "SelectivePracticeAuthority" WHERE id='practice-sharing' FOR SHARE`;
    const binding = await tx.selectivePracticeAuthority.findUnique({ where: { id: 'practice-sharing' } });
    if (!binding?.enabled) deny();
    for (const id of [...new Set([binding.userId, claimed.userId, ...(recipientId ? [recipientId] : [])])].sort()) {
      await lockInternalUser(tx, id);
    }
    const row = await lockAuthoritativeInternalSession(tx, { userId: claimed.userId, sessionId: claimed.sessionId! });
    if (!row || row.revokedAt || !row.active || row.deletedAt) deny();
    const current = { ...claimed, role: row.role, active: row.active, permissionOverrides: [...row.permissionOverrides],
      registryExpiresAt: row.expiresAt, clientReadScope: await loadClientReadScope(tx, claimed.userId),
      ...await loadSelectiveProjectScope(tx, claimed.userId) };
    const actor = await liveUser(tx, claimed.userId), authorityUser = await liveUser(tx, binding.userId);
    if (!allowed(current) || authorityUser.role !== 'admin' || !allowed(authorityUser, true)) deny();
    await sessionLive(tx, current);
    if (proof) await personal(tx, current, proof);
    const result = await work(tx, { current, key, binding, authorityUser, actor });
    await sessionLive(tx, current);
    if (proof) await personal(tx, current, proof);
    return result;
  });
}
type State = Parameters<Parameters<typeof transaction>[4]>[1];
function manager(state: State) {
  if (state.binding.userId !== state.current.userId || state.current.role !== 'admin' || !allowed(state.current, true)) deny();
}
/** Compatible with record-update and native practice mutation locks. The initial
 * identity is not authorization: reread it after client/practice locks. */
async function practice(tx: Tx, id: string, write = false, allowInactive = false) {
  const identity = await tx.technicalPractice.findUnique({ where: { id }, select: { clientId: true } });
  if (!identity) deny();
  await tx.$queryRaw`SELECT id FROM "Client" WHERE id=${identity.clientId} FOR SHARE`;
  await tx.$queryRaw(Prisma.sql`SELECT id FROM "TechnicalPractice" WHERE id=${id} ${Prisma.raw(write ? 'FOR UPDATE' : 'FOR SHARE')}`);
  const row = await tx.technicalPractice.findUnique({ where: { id } });
  if (!row || row.clientId !== identity.clientId) deny();
  const client = await tx.client.findUnique({ where: { id: row.clientId } });
  if (!client) deny();
  if (row.clientServiceId) await tx.$queryRaw`SELECT id FROM "ClientService" WHERE id=${row.clientServiceId} FOR SHARE`;
  const service = row.clientServiceId ? await tx.clientService.findUnique({ where: { id: row.clientServiceId } }) : null;
  if (row.clientServiceId && (!service || service.clientId !== client.id)) deny();
  const projectIds = [...new Set([row.projectId, service?.projectId].filter((x): x is string => Boolean(x)))].sort();
  for (const projectId of projectIds) await tx.$queryRaw`SELECT id FROM "Project" WHERE id=${projectId} FOR SHARE`;
  const projects = await tx.project.findMany({ where: { id: { in: projectIds } } });
  if (projects.length !== projectIds.length || projects.some(project => project.clientId !== client.id)
    || (row.projectId && service?.projectId && row.projectId !== service.projectId)) deny();
  const operational = !row.deletedAt && row.status !== 'archiviata' && !client.deletedAt
    && !['archiviato', 'archiviata', 'sospeso'].includes(client.status)
    && (!service || (!service.deletedAt && !['archiviato', 'archiviata', 'sospeso'].includes(service.status)))
    && projects.every(project => !project.deletedAt && project.status !== 'archiviato');
  if (!allowInactive && !operational) deny();
  const project = projects.find(item => item.id === row.projectId);
  const serviceProject = projects.find(item => item.id === service?.projectId);
  const context = { ...row, client, project: project ? { ...project, client } : null,
    clientService: service ? { ...service, client, project: serviceProject ? { ...serviceProject, client } : null } : null };
  const [scope] = await tx.$queryRaw<Array<{ scope: Prisma.JsonValue | null }>>`SELECT fai_record_update_scope('PRACTICE',${id}) AS scope`;
  if (!scope?.scope && !allowInactive) deny();
  // Revocation remains possible after archive/hold. This hash is only recorded
  // in a revoked revision and cannot authorize a selected read or a new grant.
  const contextState = scope?.scope ?? asJson({ inactive: true, practice: [row.id, row.recordUpdateEpoch],
    client: [client.id, client.recordUpdateEpoch], service: service ? [service.id, service.recordUpdateEpoch] : null,
    projects: projects.map(item => [item.id, item.recordUpdateEpoch]) });
  const documentContext: PracticeDocumentContext = { id: row.id, clientId: row.clientId, projectId: row.projectId,
    clientServiceId: row.clientServiceId, serviceProjectId: service?.projectId ?? null };
  return { row, context, documentContext, contextHash: canonicalSha256(contextState), operational };
}
async function selectedState(tx: Tx, state: State, input: SelectivePracticeSelection, write = false) {
  manager(state);
  if (input.recipientId === state.current.userId) deny();
  const target = await liveUser(tx, input.recipientId);
  if (!allowed(target)) deny();
  const resource = await practice(tx, input.practiceId, write), row = resource.row;
  if (!canViewTechnicalPractice(state.current, resource.context)) deny();
  const recipientScope = await loadSelectiveProjectScope(tx, target.id);
  if (hasSelectiveContext(recipientScope, resource.context) || hasSelectiveClientContext(recipientScope, resource.context)) deny();
  const previous = await tx.selectivePracticeGrant.findUnique({ where: { practiceId_recipientId: { practiceId: row.id, recipientId: target.id } } });
  if ((previous?.revision ?? 0) !== input.revision) stale();
  const now = await clock(tx);
  if (input.expiresAt && new Date(input.expiresAt) <= now) stale();
  const documents = await selectPracticeDocuments(tx, state.current.userId, target, resource.documentContext, input.documents ?? []);
  const admission = { actorId: state.actor.id, sessionId: state.current.sessionId!, authorityRevision: state.binding.revision,
    actorEpoch: state.actor.selectivePracticeEpoch, recipientEpoch: target.selectivePracticeEpoch, practiceEpoch: row.recordUpdateEpoch,
    contextHash: resource.contextHash, stateHash: canonicalSha256(asJson({ practice: row, contextHash: resource.contextHash, target: { id: target.id, name: target.name, email: target.email,
      role: target.role, epoch: target.selectivePracticeEpoch, permissions: target.permissionOverrides },
      previous: previous ? { id: previous.id, revision: previous.revision, proof: previous.proof, revokedAt: previous.revokedAt } : null, documents: documents.snapshots })) };
  return { row, context: resource.context, target, previous, admission, now, documents };
}

export async function mayManagePracticeSharing(db: PrismaClient, session: AuthSession) {
  const binding = await db.selectivePracticeAuthority.findUnique({ where: { id: 'practice-sharing' } });
  return !!(session.sessionId && session.role === 'admin' && allowed(session, true) && binding?.enabled && binding.userId === session.userId);
}
export async function previewPracticeSharing(db: PrismaClient, claimed: AuthSession, raw: unknown) {
  const input = selectivePracticeSelectionSchema.parse(raw);
  return transaction(db, claimed, input.recipientId, null, async (tx, state) => {
    const selected = await selectedState(tx, state, input);
    const targetScope = await loadSelectiveProjectScope(tx, input.recipientId);
    return { token: createSelectivePracticePreview(state.key, input, selected.admission, selected.now.getTime()), input,
      fields: practiceFieldProjection(selected.row as unknown as Record<string, unknown>, input.fields),
      documents: selected.documents.snapshots,
      recipient: { name: selected.target.name, email: selected.target.email, role: selected.target.role },
      replacesFullAccess: canViewTechnicalPractice({ userId: selected.target.id, role: selected.target.role, clientReadScope: await loadClientReadScope(tx, selected.target.id), ...targetScope }, selected.context),
      replacesSelection: !!selected.previous };
  });
}

const legacyReceiptSchema = z.object({ protocol: z.literal('SELECTIVE_PRACTICE_RECEIPT_V1'), commandId: z.string().uuid(),
  grantId: z.string().uuid(), revisionId: z.string().uuid(), revision: z.number().int().positive(),
  operation: z.enum(['GRANT', 'REVOKE']), fieldCount: z.number().int().min(1).max(6), keyVersion: z.number().int().positive(),
}).strict();
const receiptSchema = z.discriminatedUnion('protocol', [legacyReceiptSchema, legacyReceiptSchema.extend({
  protocol: z.literal('SELECTIVE_PRACTICE_RECEIPT_V2'), fieldCount: z.number().int().min(0).max(6),
  documentCount: z.number().int().min(0).max(maxPracticeDocuments),
})]);
function selectionCounts(input: SelectivePracticeSelection) {
  return { fieldCount: input.fields.length, ...(input.version === 2 ? { documentCount: input.documents!.length } : {}) };
}
async function previousCommand(tx: Tx, state: State, id: string, digest: string) {
  const command = await tx.selectivePracticeCommand.findUnique({ where: { id } });
  if (!command) return null;
  if (command.actorId !== state.current.userId || command.sessionId !== state.current.sessionId || command.requestDigest !== digest) stale();
  const receipt = receiptSchema.parse(command.receipt);
  if (receipt.keyVersion !== state.key.version || !verifySelectivePracticeProof(state.key, 'receipt', receipt, command.receiptProof)) deny();
  return receipt;
}
async function persist(tx: Tx, state: State, input: SelectivePracticeSelection, payload: SelectivePracticeGrantPayload,
  previous: { id: string; revision: number } | null, operation: 'GRANT' | 'REVOKE', requestDigest: string, now: Date) {
  const proof = selectivePracticeProof(state.key, 'grant', payload), revokedAt = operation === 'REVOKE' ? now : null;
  const data = { id: payload.id, practiceId: input.practiceId, recipientId: input.recipientId, revision: payload.revision,
    payload: asJson(payload), proof, revokedAt, updatedAt: now };
  if (previous) await tx.selectivePracticeGrant.update({ where: { id: previous.id, revision: previous.revision }, data });
  else await tx.selectivePracticeGrant.create({ data });
  const revisionId = randomUUID();
  const receipt = receiptSchema.parse({ protocol: input.version === 2 ? 'SELECTIVE_PRACTICE_RECEIPT_V2' : 'SELECTIVE_PRACTICE_RECEIPT_V1', commandId: input.commandId,
    grantId: payload.id, revisionId, revision: payload.revision, operation, ...selectionCounts(input), keyVersion: state.key.version });
  await tx.selectivePracticeCommand.create({ data: { id: input.commandId, actorId: state.current.userId, sessionId: state.current.sessionId!,
    practiceId: input.practiceId, recipientId: input.recipientId, expectedRevision: input.revision, operation, requestDigest,
    receipt: asJson(receipt), receiptProof: selectivePracticeProof(state.key, 'receipt', receipt) } });
  await tx.selectivePracticeRevision.create({ data: { id: revisionId, grantId: payload.id, revision: payload.revision,
    commandId: input.commandId, payload: asJson(payload), proof, revokedAt } });
  await tx.auditLog.create({ data: { id: revisionId, actorId: state.current.userId, entityType: 'SelectivePracticeRevision', entityId: revisionId,
    event: 'selective_practice_changed', before: { version: input.revision },
    after: { version: payload.revision, action: operation, ...selectionCounts(input) } } });
  return receipt;
}
export async function confirmPracticeSharing(db: PrismaClient, claimed: AuthSession, raw: unknown, token: string, proof: PracticeSharingCredentials) {
  const input = selectivePracticeSelectionSchema.parse(raw);
  if (token.length > 12_000) deny();
  const requestDigest = canonicalSha256({ operation: 'GRANT', input, token });
  return transaction(db, claimed, input.recipientId, proof, async (tx, state) => {
    manager(state);
    const existing = await previousCommand(tx, state, input.commandId, requestDigest);
    if (existing) return existing;
    const selected = await selectedState(tx, state, input, true);
    const verified = readSelectivePracticePreview(token, state.key, selected.admission, selected.now.getTime());
    if (!verified || canonicalSha256(verified) !== canonicalSha256(input)) stale();
    const payload = selectivePracticeGrantPayloadSchema.parse({ id: selected.previous?.id ?? randomUUID(), selection: input,
      revision: input.revision + 1, approvedById: state.current.userId, approvedAt: selected.now.toISOString(),
      authorityRevision: state.binding.revision, actorEpoch: state.actor.selectivePracticeEpoch,
      recipientEpoch: selected.target.selectivePracticeEpoch, practiceEpoch: selected.row.recordUpdateEpoch, contextHash: selected.admission.contextHash, keyVersion: state.key.version,
      ...(input.version === 2 ? { documents: selected.documents.snapshots } : {}) });
    const receipt = await persist(tx, state, input, payload, selected.previous, 'GRANT', requestDigest, selected.now);
    if (!readSelectivePracticePreview(token, state.key, selected.admission, (await clock(tx)).getTime())) stale();
    return receipt;
  });
}
const revokeSchema = z.object({ grantId: z.string().uuid(), revision: z.number().int().positive(), commandId: z.string().uuid() }).strict();
export async function revokePracticeSharing(db: PrismaClient, claimed: AuthSession, raw: unknown, proof: PracticeSharingCredentials) {
  const input = revokeSchema.parse(raw);
  const requestDigest = canonicalSha256({ operation: 'REVOKE', input });
  // IDs only for lock order; all grant values are reread within the transaction.
  const identity = await db.selectivePracticeGrant.findUnique({ where: { id: input.grantId }, select: { recipientId: true } });
  if (!identity) deny();
  return transaction(db, claimed, identity.recipientId, proof, async (tx, state) => {
    manager(state);
    const existing = await previousCommand(tx, state, input.commandId, requestDigest);
    if (existing) return existing;
    const grant = await tx.selectivePracticeGrant.findUnique({ where: { id: input.grantId } });
    if (!grant || grant.recipientId !== identity.recipientId || grant.revision !== input.revision || grant.revokedAt) stale();
    if (grant.recipientId === state.current.userId) deny();
    const resource = await practice(tx, grant.practiceId, true, true), row = resource.row;
    const personalScope = await loadPersonalSelectiveProjectScope(tx, state.current.userId);
    if (hasSelectiveContext(personalScope, resource.context) || hasSelectiveClientContext(personalScope, resource.context)) deny();
    if (personalScope.selectivePracticeIds?.includes(row.id)) deny();
    const old = selectivePracticeGrantPayloadSchema.parse(grant.payload);
    const selection = { ...old.selection, revision: grant.revision, commandId: input.commandId };
    const now = await clock(tx);
    const target = await tx.user.findUniqueOrThrow({ where: { id: grant.recipientId }, select: { selectivePracticeEpoch: true } });
    const payload = { ...old, selection, revision: grant.revision + 1, approvedAt: now.toISOString(),
      approvedById: state.current.userId, authorityRevision: state.binding.revision, actorEpoch: state.actor.selectivePracticeEpoch,
      recipientEpoch: target.selectivePracticeEpoch, practiceEpoch: row.recordUpdateEpoch, contextHash: resource.contextHash, keyVersion: state.key.version };
    return persist(tx, state, selection, payload, grant, 'REVOKE', requestDigest, now);
  });
}

async function authorizedPracticeSharing(tx: Tx, state: State, practiceId: string) {
    const resource = await practice(tx, practiceId), row = resource.row;
    if (hasSelectiveContext(state.current, resource.context) || hasSelectiveClientContext(state.current, resource.context)) deny();
    const grant = await tx.selectivePracticeGrant.findUnique({ where: { practiceId_recipientId: { practiceId, recipientId: state.current.userId } } });
    if (!grant) deny();
    const current = { practiceId, recipientId: state.current.userId, revision: grant.revision,
      authority: { enabled: state.binding.enabled, userId: state.binding.userId, revision: state.binding.revision,
        actorEpoch: state.authorityUser.selectivePracticeEpoch, actorActive: true },
      recipientActive: true, recipientEpoch: state.actor.selectivePracticeEpoch, practiceEpoch: row.recordUpdateEpoch, practiceOperational: resource.operational, contextHash: resource.contextHash };
    const raw = { payload: grant.payload, proof: grant.proof, revokedAt: grant.revokedAt?.toISOString() ?? null };
    const payload = readSelectivePracticeGrant(raw, state.key, current, (await clock(tx)).getTime());
    if (!payload || payload.id !== grant.id) deny();
    const revision = await tx.selectivePracticeRevision.findUnique({ where: { grantId_revision: { grantId: grant.id, revision: grant.revision } }, include: { command: true } });
    const audit = revision && await tx.auditLog.findUnique({ where: { id: revision.id } });
    if (!revision || !audit || revision.proof !== grant.proof || canonicalSha256(revision.payload) !== canonicalSha256(grant.payload)
      || revision.command.id !== payload.selection.commandId || revision.command.practiceId !== practiceId
      || revision.command.recipientId !== state.current.userId || revision.command.expectedRevision + 1 !== grant.revision
      || canonicalSha256(audit.before) !== canonicalSha256({ version: revision.command.expectedRevision })
      || revision.revokedAt || revision.command.operation !== 'GRANT' || revision.command.actorId !== payload.approvedById
      || revision.command.transactionId !== revision.transactionId || audit.actorId !== payload.approvedById
      || audit.event !== 'selective_practice_changed' || audit.entityType !== 'SelectivePracticeRevision' || audit.entityId !== revision.id
      || canonicalSha256(audit.after) !== canonicalSha256({ version: grant.revision, action: 'GRANT', ...selectionCounts(payload.selection) })) deny();
    const receipt = receiptSchema.parse(revision.command.receipt);
    if (receipt.commandId !== revision.command.id || receipt.grantId !== grant.id || receipt.revisionId !== revision.id
      || receipt.revision !== grant.revision || receipt.operation !== 'GRANT' || receipt.fieldCount !== payload.selection.fields.length
      || (receipt.protocol === 'SELECTIVE_PRACTICE_RECEIPT_V2') !== (payload.selection.version === 2)
      || (receipt.protocol === 'SELECTIVE_PRACTICE_RECEIPT_V2' && receipt.documentCount !== payload.documents?.length)
      || receipt.keyVersion !== state.key.version || !verifySelectivePracticeProof(state.key, 'receipt', receipt, revision.command.receiptProof)) deny();
    if (!readSelectivePracticeGrant(raw, state.key, current, (await clock(tx)).getTime())) deny();
    const documents = await selectPracticeDocuments(tx, state.binding.userId, state.actor, resource.documentContext, payload.selection.documents ?? []);
    if (canonicalSha256(documents.snapshots) !== canonicalSha256(payload.documents ?? [])) deny();
    return { row, grant, payload, documents, current, raw };
}

export async function readPracticeSharing(db: PrismaClient, claimed: AuthSession, practiceId: string) {
  return transaction(db, claimed, null, null, async (tx, state) => {
    const selected = await authorizedPracticeSharing(tx, state, practiceId);
    if (!readSelectivePracticeGrant(selected.raw, state.key, selected.current, (await clock(tx)).getTime())) deny();
    return { practiceId, revision: selected.grant.revision,
      fields: practiceFieldProjection(selected.row as unknown as Record<string, unknown>, selected.payload.selection.fields),
      documents: selected.documents.snapshots, expiresAt: selected.payload.selection.expiresAt };
  });
}

export async function readSharedPracticeDocument(db: PrismaClient, claimed: AuthSession, practiceId: string, versionId: string, download: boolean,
  readBytes: (path: string, limit: number) => Promise<Buffer>) {
  return transaction(db, claimed, null, null, async (tx, state) => {
    const selected = await authorizedPracticeSharing(tx, state, practiceId);
    const document = selected.documents.snapshots.find(row => row.versionId === versionId);
    const path = selected.documents.paths.get(versionId);
    if (!document || !path || (download && !document.download) || (!download && selectedDocumentMode(document) !== 'preview')) deny();
    const bytes = await readBytes(path, maxPracticeDocumentBytes);
    if (bytes.length > maxPracticeDocumentBytes || createHash('sha256').update(bytes).digest('hex') !== document.checksum) deny();
    const contentType = selectedDocumentResponseMime(document, bytes, download);
    await tx.auditLog.create({ data: { actorId: state.current.userId, entityType: 'Document', entityId: document.documentId,
      event: download ? 'selective_practice_document_download' : 'selective_practice_document_view',
      after: { versionId, grantId: selected.grant.id, revision: selected.grant.revision } } });
    if (!readSelectivePracticeGrant(selected.raw, state.key, selected.current, (await clock(tx)).getTime())) deny();
    return { bytes, document, contentType };
  });
}

export async function readPracticeSharingReceipt(db: PrismaClient, claimed: AuthSession, commandId: string, practiceId: string) {
  z.string().uuid().parse(commandId);
  z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/).parse(practiceId);
  return transaction(db, claimed, null, null, async (tx, state) => {
    manager(state);
    const command = await tx.selectivePracticeCommand.findUnique({ where: { id: commandId } });
    if (!command || command.actorId !== state.current.userId || command.practiceId !== practiceId) return null;
    const receipt = receiptSchema.parse(command.receipt);
    if (receipt.keyVersion !== state.key.version || !verifySelectivePracticeProof(state.key, 'receipt', receipt, command.receiptProof)) deny();
    return receipt;
  });
}

/** Management view is read-only and does not enroll its visitor as authority. */
export async function practiceSharingManagement(db: PrismaClient, claimed: AuthSession, practiceId: string) {
  return transaction(db, claimed, null, null, async (tx, state) => {
    manager(state);
    const resource = await practice(tx, practiceId, false, true), row = resource.row;
    const personalScope = await loadPersonalSelectiveProjectScope(tx, state.current.userId);
    if (hasSelectiveContext(personalScope, resource.context) || hasSelectiveClientContext(personalScope, resource.context)
      || personalScope.selectivePracticeIds?.includes(row.id)) deny();
    if (resource.operational && !canViewTechnicalPractice(state.current, resource.context)) deny();
    const people = await tx.user.findMany({ where: { id: { not: state.current.userId }, active: true, deletedAt: null },
      include: { permissionOverrides: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }] });
    const grants = await tx.selectivePracticeGrant.findMany({ where: { practiceId }, orderBy: { updatedAt: 'desc' },
      include: { recipient: { select: { name: true, email: true } } } });
    const options = resource.operational ? await listPracticeDocumentOptions(tx, state.actor, resource.documentContext)
      : { documentOptions: [], documentsLimited: false };
    return { practiceId, title: row.title, operational: resource.operational, ...options,
      recipients: people.filter(person => allowed(person)).map(({ id, name, email, role }) => ({ id, name, email, role })),
      grants: grants.map(grant => {
        const payload = selectivePracticeGrantPayloadSchema.safeParse(grant.payload);
        return { id: grant.id, recipientId: grant.recipientId, recipientName: grant.recipient.name,
          recipientEmail: grant.recipient.email, revision: grant.revision, revoked: !!grant.revokedAt,
          expiresAt: payload.success ? payload.data.selection.expiresAt : null,
          fields: payload.success ? payload.data.selection.fields : [],
          documentCount: payload.success ? (payload.data.documents?.length ?? 0) : 0 };
      }) };
  });
}

export async function listSharedPracticeIds(db: PrismaClient, claimed: AuthSession, page: number) {
  return transaction(db, claimed, null, null, async (tx, state) => {
    const rows = await tx.selectivePracticeGrant.findMany({ where: { recipientId: state.current.userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (Math.max(1, Math.min(200, Math.trunc(page))) - 1) * 30,
      take: 31, select: { practiceId: true } });
    return { ids: rows.slice(0, 30).map(row => row.practiceId), hasNext: rows.length > 30 };
  });
}
