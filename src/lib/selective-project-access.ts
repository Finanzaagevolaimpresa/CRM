import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient, type SelectiveProjectGrant } from '@prisma/client';
import { z } from 'zod';
import type { AuthSession } from './auth';
import { canViewProject, isSensitiveDocument } from './access-control';
import { hasPermission } from './permission-evaluator';
import { loadActivePrivilegedStepUpKey } from './application-key-registry';
import { lockAuthoritativeInternalSession, lockInternalUser } from './internal-session-registry';
import { internalSessionMode } from './session';
import { loadClientReadScope } from './client-read-perimeter';
import { loadSelectiveProjectScope } from './selective-project-scope';
import { projectFieldProjection, selectiveSelectionSchema, type SelectiveSelection } from './selective-project-policy';
import { selectiveProof, verifySelectiveProof } from './selective-project-proof';
import { canonicalSha256 } from './canonical-json';
import { withSerializableTransaction } from './serializable';
import { canAccessFinancialDocument } from './financial-document-access';

type Tx = Prisma.TransactionClient;
type Db = PrismaClient;
export class SelectiveAccessError extends Error {
  constructor(readonly code: 'DENIED' | 'STALE' | 'INVALID' | 'UNAVAILABLE') { super(`SELECTIVE_ACCESS_${code}`); }
}
function denied(): never { throw new SelectiveAccessError('DENIED'); }
function stale(): never { throw new SelectiveAccessError('STALE'); }
function json(value: unknown) { return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue; }
const identifier = z.string().min(1).max(128);
const versionSnapshot = z.object({
  documentId: identifier, versionId: identifier, version: z.number().int().positive(),
  checksum: z.string().regex(/^[a-f0-9]{64}$/), title: z.string(), fileName: z.string(),
  mimeType: z.enum(['application/pdf', 'text/plain', 'image/png', 'image/jpeg']), download: z.boolean(),
}).strict();
const snapshotSchema = z.object({
  input: selectiveSelectionSchema,
  versions: z.array(versionSnapshot).max(50),
}).strict();
const previewSchema = z.object({
  snapshot: snapshotSchema, authorityRevision: z.number().int().positive(),
  actorId: identifier, sessionId: z.string().uuid(), keyVersion: z.number().int().positive(),
  stateHash: z.string().regex(/^[a-f0-9]{64}$/), expires: z.number().int().positive(),
}).strict();
export type SelectiveDocument = z.infer<typeof versionSnapshot>;
export type SelectiveProjection = { projectId: string; fields: ReturnType<typeof projectFieldProjection>; documents: SelectiveDocument[]; expiresAt: string | null };
const authorityId = 'project-sharing';

async function now(tx: Tx) {
  const rows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
  if (!rows[0]) throw new SelectiveAccessError('UNAVAILABLE');
  return rows[0].now;
}
async function liveActor(tx: Tx, claimed: AuthSession) {
  if (internalSessionMode() !== 'registry' || !z.string().uuid().safeParse(claimed.sessionId).success) denied();
  const row = await lockAuthoritativeInternalSession(tx, { userId: claimed.userId, sessionId: claimed.sessionId! });
  if (!row || row.revokedAt || !row.active || row.deletedAt) denied();
  const current = { ...claimed, registryExpiresAt: row.expiresAt, role: row.role, active: row.active, permissionOverrides: [...row.permissionOverrides],
    ...await loadSelectiveProjectScope(tx, claimed.userId) } satisfies AuthSession & { registryExpiresAt: Date };
  await assertLiveAtOutcome(tx, current);
  return current;
}
async function assertLiveAtOutcome(tx: Tx, current: AuthSession & { registryExpiresAt: Date }) {
  const clock = await now(tx);
  if (!Number.isFinite(current.expiresAt) || current.expiresAt * 1000 <= clock.getTime() || current.registryExpiresAt <= clock) denied();
}
/** Session rows stay locked; wall-clock expiry is rechecked after every wait,
 * including writes/audit and file IO. A denial rolls the whole transaction back. */
function withSelectiveSession<T>(db: Db, claimed: AuthSession, work: (tx: Tx, current: Awaited<ReturnType<typeof liveActor>>) => Promise<T>) {
  return withSerializableTransaction(db, async tx => {
    const current = await liveActor(tx, claimed);
    const result = await work(tx, current);
    await assertLiveAtOutcome(tx, current);
    return result;
  });
}
async function authority(tx: Tx, current: AuthSession) {
  await tx.$queryRaw`SELECT "id" FROM "SelectiveAccessAuthority" WHERE "id"=${authorityId} FOR SHARE`;
  const binding = await tx.selectiveAccessAuthority.findUnique({ where: { id: authorityId } });
  if (!binding?.enabled || binding.userId !== current.userId || current.role !== 'admin') denied();
  return binding;
}
export async function mayManageSelectiveAccess(db: Db, session: AuthSession) {
  const binding = await db.selectiveAccessAuthority.findUnique({ where: { id: authorityId } });
  return Boolean(session.active && session.sessionId && session.role === 'admin' && binding?.enabled && binding.userId === session.userId);
}
async function recipient(tx: Tx, id: string) {
  const user = await tx.user.findUnique({ where: { id }, include: { permissionOverrides: true } });
  if (!user?.active || user.deletedAt) denied();
  return { user, actor: { userId: id, role: user.role, active: true, permissionOverrides: user.permissionOverrides,
    clientReadScope: await loadClientReadScope(tx, id), ...await loadSelectiveProjectScope(tx, id) } };
}
async function projectContext(tx: Tx, projectId: string) {
  await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id"=${projectId} FOR SHARE`;
  const project = await tx.project.findUnique({ where: { id: projectId } });
  if (!project || project.deletedAt || project.status === 'archiviato') denied();
  const client = await tx.client.findUnique({ where: { id: project.clientId } });
  if (!client || client.deletedAt) denied();
  const people = await tx.user.findMany({ where: { id: { in: [project.consultantId, client.salesOwnerId].filter((id): id is string => Boolean(id)) } },
    select: { id: true, name: true } });
  return { ...project, client, technicalOwnerName: people.find(person => person.id === project.consultantId)?.name ?? null,
    commercialOwnerName: people.find(person => person.id === client.salesOwnerId)?.name ?? null };
}

async function allowedVersion(tx: Tx, current: Awaited<ReturnType<typeof recipient>>['actor'], project: Awaited<ReturnType<typeof projectContext>>, versionId: string) {
  const version = await tx.documentVersion.findUnique({ where: { id: versionId } });
  if (!version?.checksum || !/^[a-f0-9]{64}$/.test(version.checksum)) denied();
  const document = await tx.document.findUnique({ where: { id: version.documentId } });
  if (!document || document.deletedAt || document.clientId !== project.clientId || document.projectId !== project.id) denied();
  if (document.clientServiceId) {
    const service = await tx.clientService.findUnique({ where: { id: document.clientServiceId } });
    if (!service || service.deletedAt || service.projectId !== project.id || service.clientId !== project.clientId) denied();
  }
  // This increment never grants financial/private documents, even to an Admin.
  if (document.visibilityLevel !== 'interno' || (isSensitiveDocument(document) && !hasPermission(current, 'document.sensitive.read'))
    || !await canAccessFinancialDocument(tx, { role: 'commerciale', active: true, permissionOverrides: [] }, document)) denied();
  const mime = versionSnapshot.shape.mimeType.safeParse(document.mimeType);
  if (!mime.success) throw new SelectiveAccessError('INVALID');
  return { version, document, mimeType: mime.data };
}

async function selectionState(tx: Tx, current: AuthSession, input: SelectiveSelection) {
  if (input.recipientId === current.userId) denied();
  const target = await recipient(tx, input.recipientId);
  const project = await projectContext(tx, input.projectId);
  const previous = await tx.selectiveProjectGrant.findUnique({ where: { projectId_recipientId: { projectId: input.projectId, recipientId: input.recipientId } } });
  if ((previous?.revision ?? 0) !== input.revision) stale();
  const clock = await now(tx);
  if (input.expiresAt && new Date(input.expiresAt) <= clock) throw new SelectiveAccessError('INVALID');
  const versions: SelectiveDocument[] = [];
  const evidence: unknown[] = [];
  for (const chosen of input.documents) {
    const { version, document, mimeType } = await allowedVersion(tx, target.actor, project, chosen.versionId);
    versions.push({ documentId: document.id, versionId: version.id, version: version.version, checksum: version.checksum!, title: document.title,
      fileName: document.fileName, mimeType, download: chosen.download });
    evidence.push({ document, version });
  }
  const snapshot = { input, versions };
  const hadFullAccess = canViewProject(target.actor, project);
  const stateHash = canonicalSha256(json({ project, user: { id: target.user.id, updatedAt: target.user.updatedAt, role: target.user.role,
    permissionOverrides: target.user.permissionOverrides }, clientReadScope: target.actor.clientReadScope, previous, evidence, hadFullAccess }));
  return { snapshot, previous, clock, target, project, stateHash, hadFullAccess };
}
function projection(project: Awaited<ReturnType<typeof projectContext>>, snapshot: z.infer<typeof snapshotSchema>): SelectiveProjection {
  return { projectId: project.id, fields: projectFieldProjection(project as unknown as Record<string, unknown>, snapshot.input.fields), documents: snapshot.versions, expiresAt: snapshot.input.expiresAt };
}

/** Read only: no draft, impersonated session or grant is created by preview. */
export async function previewSelectiveAccess(db: Db, claimed: AuthSession, raw: unknown) {
  const input = selectiveSelectionSchema.parse(raw);
  return withSelectiveSession(db, claimed, async (tx, current) => {
    const binding = await authority(tx, current);
    const key = await loadActivePrivilegedStepUpKey(tx);
    if (!key) throw new SelectiveAccessError('UNAVAILABLE');
    const state = await selectionState(tx, current, input);
    const payload = { snapshot: state.snapshot, authorityRevision: binding.revision, actorId: current.userId, sessionId: current.sessionId!,
      keyVersion: key.version, stateHash: state.stateHash, expires: state.clock.getTime() + 5 * 60_000 };
    const token = Buffer.from(JSON.stringify({ payload, proof: selectiveProof(key, 'preview', payload) })).toString('base64url');
    return { token, projection: projection(state.project, state.snapshot), recipientName: state.target.user.name, recipientEmail: state.target.user.email,
      impact: { previouslyFullProjectAccess: state.hadFullAccess, replacesPreviousSelection: Boolean(state.previous),
        role: state.target.user.role, clientGrant: Boolean(state.target.actor.clientReadScope?.includes(state.project.clientId)) } };
  });
}

function grantPayload(grant: Omit<SelectiveProjectGrant, 'proof' | 'revokedAt' | 'selection'> & { selection: unknown }) {
  return json({ id: grant.id, projectId: grant.projectId, recipientId: grant.recipientId, revision: grant.revision, selection: grant.selection,
    approvedById: grant.approvedById, authorityRevision: grant.authorityRevision, approvedAt: grant.approvedAt,
    expiresAt: grant.expiresAt, keyVersion: grant.keyVersion });
}

function parsePreview(token: string) {
  if (token.length > 100_000) denied();
  try {
    return z.object({ payload: previewSchema, proof: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(JSON.parse(Buffer.from(token, 'base64url').toString('utf8')));
  } catch { denied(); }
}

export async function readPreviewSelectiveDocument(db: Db, claimed: AuthSession, token: string, versionId: string,
  readBytes: (storagePath: string, limit: number) => Promise<Buffer>) {
  const envelope = parsePreview(token);
  return withSelectiveSession(db, claimed, async (tx, current) => {
    const binding = await authority(tx, current), key = await loadActivePrivilegedStepUpKey(tx);
    const { payload } = envelope;
    if (!key || payload.actorId !== current.userId || payload.sessionId !== current.sessionId || payload.keyVersion !== key.version
      || binding.revision !== payload.authorityRevision || !verifySelectiveProof(key, 'preview', payload, envelope.proof)) denied();
    const state = await selectionState(tx, current, payload.snapshot.input);
    if (payload.expires <= state.clock.getTime() || state.stateHash !== payload.stateHash || canonicalSha256(state.snapshot) !== canonicalSha256(payload.snapshot)) stale();
    const selected = state.snapshot.versions.find(row => row.versionId === versionId);
    if (!selected) denied();
    const version = await tx.documentVersion.findUniqueOrThrow({ where: { id: versionId } });
    const bytes = await readBytes(version.storagePath, 25 * 1024 * 1024);
    const { createHash } = await import('node:crypto');
    if (createHash('sha256').update(bytes).digest('hex') !== selected.checksum) denied();
    return { bytes, document: selected };
  });
}

export async function confirmSelectiveAccess(db: Db, claimed: AuthSession, token: string, stepUpAdmitted: boolean) {
  if (!stepUpAdmitted) denied();
  const envelope = parsePreview(token);
  return withSelectiveSession(db, claimed, async (tx, current) => {
    const binding = await authority(tx, current), key = await loadActivePrivilegedStepUpKey(tx);
    const { payload } = envelope;
    if (!key || payload.actorId !== current.userId || payload.sessionId !== current.sessionId || payload.keyVersion !== key.version
      || binding.revision !== payload.authorityRevision || !verifySelectiveProof(key, 'preview', payload, envelope.proof)) denied();
    await lockInternalUser(tx, payload.snapshot.input.recipientId);
    await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id"=${payload.snapshot.input.projectId} FOR UPDATE`;
    const state = await selectionState(tx, current, payload.snapshot.input);
    if (payload.expires <= state.clock.getTime() || payload.expires > state.clock.getTime() + 5 * 60_000 || state.stateHash !== payload.stateHash
      || canonicalSha256(state.snapshot) !== canonicalSha256(payload.snapshot)) stale();
    const data = { id: state.previous?.id ?? randomUUID(), projectId: state.project.id, recipientId: state.target.user.id,
      revision: payload.snapshot.input.revision + 1, selection: json(payload.snapshot), approvedById: current.userId,
      authorityRevision: binding.revision, approvedAt: state.clock, expiresAt: payload.snapshot.input.expiresAt ? new Date(payload.snapshot.input.expiresAt) : null,
      revokedAt: null, keyVersion: key.version };
    const proof = selectiveProof(key, 'grant', grantPayload(data));
    const grant = state.previous ? await tx.selectiveProjectGrant.update({ where: { id: state.previous.id, revision: state.previous.revision }, data: { ...data, proof } })
      : await tx.selectiveProjectGrant.create({ data: { ...data, proof } });
    // The receipt and permission commit atomically; no audit error is swallowed.
    await tx.auditLog.create({ data: { actorId: current.userId, event: 'selective_project_access_confirmed', entityType: 'SelectiveProjectGrant', entityId: grant.id,
      after: { projectId: grant.projectId, recipientId: grant.recipientId, grantVersion: grant.revision, grantHash: canonicalSha256(proof) } } });
    return { id: grant.id, revision: grant.revision };
  });
}

export async function revokeSelectiveAccess(db: Db, claimed: AuthSession, id: string, revision: number, stepUpAdmitted: boolean) {
  if (!stepUpAdmitted || !z.string().uuid().safeParse(id).success) denied();
  return withSelectiveSession(db, claimed, async (tx, current) => {
    await authority(tx, current);
    const grant = await tx.selectiveProjectGrant.findUnique({ where: { id } });
    if (!grant || grant.revision !== revision || grant.recipientId === current.userId) stale();
    await tx.selectiveProjectGrant.update({ where: { id, revision }, data: { revokedAt: await now(tx), revision: { increment: 1 } } });
    await tx.auditLog.create({ data: { actorId: current.userId, event: 'selective_project_access_revoked', entityType: 'SelectiveProjectGrant', entityId: id,
      after: { projectId: grant.projectId, recipientId: grant.recipientId, grantVersion: revision + 1 } } });
  });
}

async function authorizedSnapshot(tx: Tx, current: AuthSession, projectId: string) {
  const grant = await tx.selectiveProjectGrant.findUnique({ where: { projectId_recipientId: { projectId, recipientId: current.userId } } });
  const clock = await now(tx);
  if (!grant || grant.revokedAt || (grant.expiresAt && grant.expiresAt <= clock) || grant.approvedById === current.userId) denied();
  const binding = await tx.selectiveAccessAuthority.findUnique({ where: { id: authorityId }, include: { user: true } });
  if (!binding?.enabled || binding.userId !== grant.approvedById || binding.revision !== grant.authorityRevision
    || !binding.user.active || binding.user.deletedAt || binding.user.role !== 'admin') denied();
  const key = await loadActivePrivilegedStepUpKey(tx);
  if (!key || grant.keyVersion !== key.version || !verifySelectiveProof(key, 'grant', grantPayload(grant), grant.proof)) denied();
  const receipt = await tx.auditLog.findFirst({ where: { entityId: grant.id, entityType: 'SelectiveProjectGrant', event: 'selective_project_access_confirmed', actorId: grant.approvedById,
    AND: [{ after: { path: ['grantHash'], equals: canonicalSha256(grant.proof) } }, { after: { path: ['grantVersion'], equals: grant.revision } }] }, select: { id: true } });
  if (!receipt) denied();
  const snapshot = snapshotSchema.parse(grant.selection);
  if (snapshot.input.projectId !== projectId || snapshot.input.recipientId !== current.userId || snapshot.input.revision + 1 !== grant.revision
    || snapshot.versions.length !== snapshot.input.documents.length || snapshot.input.expiresAt !== (grant.expiresAt?.toISOString() ?? null)) denied();
  const project = await projectContext(tx, projectId), target = await recipient(tx, current.userId);
  // Restoration never revives an old permission. Rows/proofs/revocations remain
  // intact; only a new personal confirmation issued after the lifecycle receipt
  // can establish a valid selection again.
  if (await tx.auditLog.findFirst({ where: { event: 'project_lifecycle_changed', entityType: 'Project', entityId: projectId,
    createdAt: { gte: grant.approvedAt } }, select: { id: true } })) denied();
  for (const doc of snapshot.versions) {
    const selected = snapshot.input.documents.find(row => row.versionId === doc.versionId);
    const live = await allowedVersion(tx, target.actor, project, doc.versionId);
    if (!selected || selected.download !== doc.download || live.version.documentId !== doc.documentId || live.version.checksum !== doc.checksum) denied();
  }
  return { grant, snapshot, project, target };
}
export async function readSelectiveProject(db: Db, claimed: AuthSession, projectId: string) {
  return withSelectiveSession(db, claimed, async (tx, current) => {
    const state = await authorizedSnapshot(tx, current, projectId);
    return projection(state.project, state.snapshot);
  });
}

/** Called on every byte request; never returns a reusable storage URL. */
export async function readSelectiveDocument(db: Db, claimed: AuthSession, projectId: string, versionId: string, download: boolean,
  readBytes: (storagePath: string, limit: number) => Promise<Buffer>) {
  return withSelectiveSession(db, claimed, async (tx, current) => {
    const { grant, snapshot } = await authorizedSnapshot(tx, current, projectId);
    const selected = snapshot.versions.find(row => row.versionId === versionId);
    if (!selected || (download && !selected.download)) denied();
    const version = await tx.documentVersion.findUniqueOrThrow({ where: { id: versionId } });
    const bytes = await readBytes(version.storagePath, 25 * 1024 * 1024);
    const { createHash } = await import('node:crypto');
    if (createHash('sha256').update(bytes).digest('hex') !== selected.checksum) denied();
    await tx.auditLog.create({ data: { actorId: current.userId, event: download ? 'selective_document_download' : 'selective_document_view', entityType: 'SelectiveProjectGrant', entityId: grant.id,
      after: { projectId, documentId: selected.documentId, versionId, grantVersion: grant.revision } } });
    return { bytes, document: selected };
  });
}
