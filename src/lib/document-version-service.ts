import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { AuthSession } from './auth';
import { hasPermission } from './permission-evaluator';
import { canViewDocument, canEditDocument } from './access-control';
import { canAccessFinancialDocument } from './financial-document-access';
import { lockAuthoritativeInternalSession, lockInternalUser } from './internal-session-registry';
import { internalSessionMode } from './session';
import { guardProjectResources } from './project-resource-guard';
import { loadClientReadScope } from './client-read-perimeter';
import { requireClientContextWriteAccess } from './write-access';
import { savePrivateDocumentFile, assertSafeUploadName } from './storage';
import { documentUploadMaxBytes } from './document-upload-contract';
import { documentPreviewMime } from './document-preview';
import { DocumentVersionError, documentVersionCommandSchema, type DocumentVersionCommand } from './document-version-contract';

type Tx = Prisma.TransactionClient;
const denied = (): never => { throw new DocumentVersionError('DENIED'); };
const invalid = (): never => { throw new DocumentVersionError('INVALID'); };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const checksum = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const receiptId = (actorId: string, requestId: string) => `document-version:${hash({ actorId, requestId })}`;

async function lockContext(tx: Tx, claimed: AuthSession, documentId: string) {
  if (internalSessionMode() === 'registry' && !claimed.sessionId) return denied();
  const registry = claimed.sessionId ? await lockAuthoritativeInternalSession(tx, { userId: claimed.userId, sessionId: claimed.sessionId }) : null;
  if (claimed.sessionId && (!registry?.active || registry.deletedAt || registry.revokedAt || !registry.live)) return denied();
  await lockInternalUser(tx, claimed.userId);
  const user = await tx.user.findUnique({ where: { id: claimed.userId }, include: { permissionOverrides: true } });
  if (!user?.active || user.deletedAt || !Number.isFinite(claimed.expiresAt) || claimed.expiresAt * 1000 <= Date.now()) return denied();
  const actor = { ...claimed, role: user.role, active: user.active, permissionOverrides: user.permissionOverrides,
    clientReadScope: await loadClientReadScope(tx, user.id), ...await guardProjectResources(tx, user.id, [{ documentId }]) };
  if (!hasPermission(actor, 'document.download')) return denied();
  await tx.$queryRaw`SELECT id FROM "Document" WHERE id=${documentId} FOR UPDATE`;
  const document = await tx.document.findFirst({ where: { id: documentId, deletedAt: null } });
  if (!document || document.visibilityLevel !== 'interno' || !await canAccessFinancialDocument(tx, actor, document)) return denied();
  const client = document.clientId ? await tx.client.findFirst({ where: { id: document.clientId, deletedAt: null } }) : null;
  const project = document.projectId ? await tx.project.findFirst({ where: { id: document.projectId, deletedAt: null } }) : null;
  const service = document.clientServiceId ? await tx.clientService.findFirst({ where: { id: document.clientServiceId, deletedAt: null } }) : null;
  const serviceProject = service?.projectId ? await tx.project.findFirst({ where: { id: service.projectId, deletedAt: null } }) : null;
  const context = { ...document, client, project: project ? { ...project, client } : null,
    clientService: service ? { ...service, client, project: serviceProject ? { ...serviceProject, client } : null } : null };
  if (!canViewDocument(actor, context, hasPermission(actor, 'document.sensitive.read'))) return denied();
  const versions = await tx.documentVersion.findMany({ where: { documentId }, orderBy: [{ version: 'desc' }, { id: 'asc' }], take: 51 });
  const current = versions[0];
  const [contracts, payments, formalizations, acquisitions, clock] = await Promise.all([
    tx.contract.count({ where: { signedDocumentId: documentId } }), tx.payment.count({ where: { accountingDocumentId: documentId } }),
    tx.practiceFormalization.count({ where: { signedDocumentId: documentId } }), tx.technicalDocumentAcquisition.count({ where: { documentId } }),
    tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`,
  ]);
  if (!clock[0] || claimed.expiresAt * 1000 <= clock[0].now.getTime() || (registry && registry.expiresAt <= clock[0].now)) return denied();
  const canAppend = !!document.clientId && hasPermission(actor, 'document.upload')
    && canEditDocument(actor, context, hasPermission(actor, 'document.sensitive.read'))
    && !['archiviato', 'respinto', 'scaduto'].includes(document.status)
    && (!document.validUntil || document.validUntil > clock[0].now)
    && !contracts && !payments && !formalizations && !acquisitions
    && !!current?.checksum && current.storagePath === document.storagePath && current.checksum === document.checksum
    && versions.every((v, i) => Number.isSafeInteger(v.version) && v.version > 0 && (!i || v.version < versions[i - 1].version));
  return { actor, document, versions, current, canAppend, expectedHash: hash({ document, current }), registry };
}

export async function documentVersionPage(db: PrismaClient, actor: AuthSession, documentId: string, before?: number) {
  if (before !== undefined && (!Number.isSafeInteger(before) || before < 1 || before > 2_147_483_647)) return invalid();
  return db.$transaction(async tx => {
    const state = await lockContext(tx, actor, documentId);
    const versions = before === undefined ? state.versions : await tx.documentVersion.findMany({
      where: { documentId, version: { lt: before } }, orderBy: [{ version: 'desc' }, { id: 'asc' }], take: 51 });
    const visible = versions.slice(0, 50);
    return { id: state.document.id, title: state.document.title, fileName: state.document.fileName,
      mimeType: state.document.mimeType, expectedHash: state.expectedHash, canAppend: state.canAppend,
      currentVersion: state.current?.version ?? null, nextBefore: versions.length > 50 ? visible.at(-1)!.version : null,
      versions: visible.map(v => ({ id: v.id, version: v.version, createdAt: v.createdAt.toISOString() })) };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 });
}

async function readReceipt(tx: Tx, actorId: string, command: Pick<DocumentVersionCommand, 'documentId' | 'requestId'>, fingerprint?: string) {
  const row = await tx.auditLog.findUnique({ where: { id: receiptId(actorId, command.requestId) } });
  if (!row) return null;
  const after = row.after as { requestFingerprint?: string; versionId?: string; version?: number; checksumHash?: string } | null;
  if (row.actorId !== actorId || row.entityId !== command.documentId || row.event !== 'document_version_upload'
    || !after?.versionId || !after.checksumHash || !Number.isSafeInteger(after.version) || (fingerprint && after.requestFingerprint !== fingerprint)) throw new DocumentVersionError('STALE');
  const version = await tx.documentVersion.findUnique({ where: { id: after.versionId } });
  if (!version || version.documentId !== command.documentId || version.version !== after.version || version.checksum !== after.checksumHash) throw new DocumentVersionError('STALE');
  return { ok: true as const, versionId: version.id, version: version.version, replay: true };
}

export async function documentVersionOutcome(db: PrismaClient, actor: AuthSession, command: Pick<DocumentVersionCommand, 'documentId' | 'requestId'>) {
  return db.$transaction(async tx => {
    const state = await lockContext(tx, actor, command.documentId);
    if (!state.canAppend) return denied();
    return readReceipt(tx, actor.userId, command);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 });
}

export async function appendDocumentVersion(db: PrismaClient, claimed: AuthSession, raw: unknown, file: File) {
  const parsed = documentVersionCommandSchema.safeParse(raw);
  if (!parsed.success || !(file instanceof File) || !file.size || file.size > documentUploadMaxBytes) return invalid();
  const command = parsed.data, bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.length !== file.size) return invalid();
  const fileHash = checksum(bytes), fingerprint = hash({ command, fileHash, size: bytes.length, name: file.name, type: file.type });
  return db.$transaction(async tx => {
    const state = await lockContext(tx, claimed, command.documentId);
    if (!state.canAppend) return denied();
    const previous = await readReceipt(tx, state.actor.userId, command, fingerprint);
    if (previous) return previous;
    if (state.expectedHash !== command.expectedHash) throw new DocumentVersionError('STALE');
    const doc = state.document;
    // DocumentVersion has no separate filename/MIME columns. Keep canonical
    // metadata immutable so every old version remains accurately interpretable.
    try { assertSafeUploadName(file.name); assertSafeUploadName(doc.fileName); } catch { return invalid(); }
    const ext = (name: string) => name.toLowerCase().split('.').at(-1);
    if (ext(file.name) !== ext(doc.fileName) || (file.type && file.type !== doc.mimeType)) return invalid();
    if (['pdf', 'png', 'jpg', 'jpeg', 'txt'].includes(ext(doc.fileName) ?? '')
      && documentPreviewMime(doc.fileName, bytes)?.split(';')[0] !== doc.mimeType.split(';')[0]) return invalid();
    await requireClientContextWriteAccess(state.actor, { ...doc, clientId: doc.clientId! }, tx);
    const saved = await savePrivateDocumentFile({ file, clientId: doc.clientId!, clientServiceId: doc.clientServiceId ?? undefined,
      fileName: doc.fileName, storageToken: hash({ namespace: 'document-version', actor: state.actor.userId, requestId: command.requestId }) });
    if (saved.checksum !== fileHash || saved.sizeBytes !== bytes.length) throw new DocumentVersionError('STALE');
    const version = await tx.documentVersion.create({ data: { documentId: doc.id, version: state.current.version + 1,
      storagePath: saved.storagePath, checksum: fileHash } });
    await tx.document.update({ where: { id: doc.id }, data: { storagePath: saved.storagePath, checksum: fileHash, sizeBytes: bytes.length, status: 'caricato' } });
    await tx.auditLog.create({ data: { id: receiptId(state.actor.userId, command.requestId), actorId: state.actor.userId,
      event: 'document_version_upload', entityType: 'Document', entityId: doc.id,
      before: { versionId: state.current.id, checksumHash: state.current.checksum },
      after: { requestFingerprint: fingerprint, versionId: version.id, version: version.version, checksumHash: fileHash, sizeBytes: bytes.length } } });
    // The privacy trigger must preserve every field needed to reconcile a lost response.
    await readReceipt(tx, state.actor.userId, command, fingerprint);
    const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    if (!clock || state.actor.expiresAt * 1000 <= clock.now.getTime() || (state.registry && state.registry.expiresAt <= clock.now)) return denied();
    return { ok: true as const, versionId: version.id, version: version.version, replay: false };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 });
}
