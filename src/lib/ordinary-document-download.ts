import { Prisma, type PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import type { AuthSession } from './auth';
import { hasPermission } from './permission-evaluator';
import { canViewDocument, isSensitiveDocument } from './access-control';
import { canAccessFinancialDocument } from './financial-document-access';
import { lockAuthoritativeInternalSession, lockInternalUser } from './internal-session-registry';
import { internalSessionMode } from './session';
import { guardProjectResources } from './project-resource-guard';
import { getEngagementMaterialDownloadAccessTx } from './engagement-dossier';
import { loadClientReadScope } from './client-read-perimeter';
import { privateDocumentExists, readPrivateDocument, readPrivateDocumentBounded } from './storage';
import { documentPreviewMaxBytes, documentPreviewMime } from './document-preview';

export class DocumentDownloadError extends Error {
  constructor(readonly status: 403 | 404 | 409 | 415) { super('DOCUMENT_UNAVAILABLE'); }
}
type Runtime = { exists?: typeof privateDocumentExists; read?: typeof readPrivateDocument; intent?: 'view' | 'download' };

/** Keep session, project state, linked financial scope and audit valid until
 * the bytes have been read. A concurrent archive must precede or follow this
 * whole operation; it cannot slip between authorization and file access. */
export async function readOrdinaryDocument(db: PrismaClient, claimed: AuthSession, id: string, versionId: string | null, runtime: Runtime = {}) {
  return db.$transaction(async tx => {
    if (internalSessionMode() === 'registry' && !claimed.sessionId) throw new DocumentDownloadError(403);
    const registry = claimed.sessionId ? await lockAuthoritativeInternalSession(tx, { userId: claimed.userId, sessionId: claimed.sessionId }) : null;
    if (claimed.sessionId && (!registry?.active || registry.deletedAt || registry.revokedAt || !registry.live)) throw new DocumentDownloadError(403);
    await lockInternalUser(tx, claimed.userId);
    const user = await tx.user.findUnique({ where: { id: claimed.userId }, include: { permissionOverrides: true } });
    if (!user?.active || user.deletedAt) throw new DocumentDownloadError(403);
    const session = { ...claimed, role: user.role, active: user.active, permissionOverrides: [...user.permissionOverrides],
      clientReadScope: await loadClientReadScope(tx, claimed.userId), ...await guardProjectResources(tx, claimed.userId, [{ documentId: id }]) };
    if (!hasPermission(session, 'document.download')) throw new DocumentDownloadError(403);
    const document = await tx.document.findFirst({ where: { id, deletedAt: null } });
    if (!document) throw new DocumentDownloadError(404);
    if (!await canAccessFinancialDocument(tx, session, document)) throw new DocumentDownloadError(403);
    const [client, project, clientService] = await Promise.all([
      document.clientId ? tx.client.findFirst({ where: { id: document.clientId, deletedAt: null }, select: { id: true, salesOwnerId: true, consultantId: true } }) : null,
      document.projectId ? tx.project.findFirst({ where: { id: document.projectId, deletedAt: null }, select: { id: true, consultantId: true, clientId: true } }) : null,
      document.clientServiceId ? tx.clientService.findFirst({ where: { id: document.clientServiceId, deletedAt: null }, select: { id: true, clientId: true, projectId: true, assignedToId: true } }) : null,
    ]);
    const [projectClient, serviceClient, serviceProject] = await Promise.all([
      project?.clientId ? tx.client.findFirst({ where: { id: project.clientId, deletedAt: null }, select: { id: true, salesOwnerId: true, consultantId: true } }) : null,
      clientService?.clientId ? tx.client.findFirst({ where: { id: clientService.clientId, deletedAt: null }, select: { id: true, salesOwnerId: true, consultantId: true } }) : null,
      clientService?.projectId ? tx.project.findFirst({ where: { id: clientService.projectId, deletedAt: null }, select: { id: true, consultantId: true, clientId: true } }) : null,
    ]);
    const serviceProjectClient = serviceProject?.clientId
      ? await tx.client.findFirst({ where: { id: serviceProject.clientId, deletedAt: null }, select: { id: true, salesOwnerId: true, consultantId: true } }) : null;
    const ordinary = canViewDocument(session, { ...document, client, project: project ? { ...project, client: projectClient } : null,
      clientService: clientService ? { ...clientService, client: serviceClient, project: serviceProject ? { ...serviceProject, client: serviceProjectClient } : null } : null,
    }, hasPermission(session, 'document.sensitive.read'));
    const review = ordinary ? null : await getEngagementMaterialDownloadAccessTx(tx, session, document.id, versionId);
    if (!ordinary && !review) throw new DocumentDownloadError(403);
    const version = ordinary && versionId ? await tx.documentVersion.findFirst({ where: { id: versionId, documentId: id } }) : null;
    if (ordinary && versionId && !version) throw new DocumentDownloadError(404);
    const path = review?.storagePath ?? version?.storagePath ?? document.storagePath;
    const checksum = review?.checksum ?? version?.checksum ?? document.checksum;
    if (!await (runtime.exists ?? privateDocumentExists)(path)) throw new DocumentDownloadError(404);
    const viewing = runtime.intent === 'view';
    if (viewing && !/\.(pdf|png|jpe?g|txt)$/i.test(document.fileName)) throw new DocumentDownloadError(415);
    const previewRead = async (p: string) => {
      try { return await readPrivateDocumentBounded(p, documentPreviewMaxBytes); }
      catch { throw new DocumentDownloadError(415); }
    };
    const bytes = await (runtime.read ?? (viewing ? previewRead : readPrivateDocument))(path);
    if (checksum && createHash('sha256').update(bytes).digest('hex') !== checksum) throw new DocumentDownloadError(409);
    const mimeType = viewing ? documentPreviewMime(document.fileName, bytes) : document.mimeType;
    if (viewing && !mimeType) throw new DocumentDownloadError(415);
    if (isSensitiveDocument(document)) await tx.auditLog.create({ data: { actorId: session.userId, event: 'document_sensitive_access', entityType: 'Document', entityId: id, after: { category: document.documentCategory } } });
    await tx.auditLog.create({ data: { actorId: session.userId, event: viewing ? 'document_view' : 'document_download', entityType: 'Document', entityId: id, after: { sizeBytes: bytes.length } } });
    const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    if (!clock || !Number.isFinite(session.expiresAt) || session.expiresAt * 1000 <= clock.now.getTime() || (registry && registry.expiresAt <= clock.now)) throw new DocumentDownloadError(403);
    return { bytes, fileName: document.fileName, mimeType };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 });
}
