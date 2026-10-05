import { createHash, randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { AuthSession } from './auth';
import { hasPermission } from './permission-evaluator';
import { lockAuthoritativeInternalSession } from './internal-session-registry';
import { canAccessFinancialDocumentMetadata } from './financial-access';
import { canAccessFinancialDocument } from './financial-document-access';
import { requireClientContextWriteAccess, denyWriteAccess } from './write-access';
import { documentUploadSchema } from './validation';
import { documentUploadMaxBytes } from './document-upload-contract';
import { sanitizeFileName, savePrivateDocumentFile } from './storage';
import { UserFacingActionError } from './action-errors';

const receiptSchema = z.object({ version: z.literal(1), documentId: z.string(), requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/), fileHash: z.string(), sizeBytes: z.number() }).strict();
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/** A receipt, document and version commit together. Replays recheck current authority. */
export async function storeUploadedDocument(db: Pick<PrismaClient, '$transaction'>, claimed: AuthSession, form: FormData) {
  const file = form.get('file');
  if (form.getAll('file').length !== 1 || !(file instanceof File) || !file.size || file.size > documentUploadMaxBytes) throw new UserFacingActionError('Seleziona un file valido entro 25 MB.');
  const raw = Object.fromEntries([...form].filter(([, value]) => typeof value === 'string' && value !== ''));
  const parsed = documentUploadSchema.safeParse(raw);
  if (!parsed.success) throw new UserFacingActionError('Controlla i dati del documento: cliente, progetto e servizio devono essere coerenti.');
  const data = parsed.data, fileName = sanitizeFileName(file.name);
  const requestId = z.string().uuid().parse(form.get('uploadRequestId') ?? randomUUID());
  const bytes = Buffer.from(await file.arrayBuffer()), checksum = sha256(bytes);
  if (bytes.length !== file.size) throw new UserFacingActionError('Dimensione file non valida.');
  const requestFingerprint = sha256(JSON.stringify({ data, fileName, mimeType: file.type, checksum, sizeBytes: bytes.length }));
  const storageToken = sha256(JSON.stringify({ actorId: claimed.userId, requestId }));
  const receiptId = `upload:${storageToken}`;
  return db.$transaction(async tx => {
    if (!claimed.active || !Number.isFinite(claimed.expiresAt) || claimed.expiresAt * 1000 <= Date.now()) denyWriteAccess();
    let actor: AuthSession;
    if (claimed.sessionId) {
      const current = await lockAuthoritativeInternalSession(tx, { userId: claimed.userId, sessionId: claimed.sessionId });
      if (!current?.active || current.deletedAt || current.revokedAt || !current.live) denyWriteAccess();
      actor = { ...claimed, role: current.role, permissionOverrides: [...current.permissionOverrides], clientReadScope: [] };
    } else {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id=${claimed.userId} FOR UPDATE`;
      const current = await tx.user.findUnique({ where: { id: claimed.userId }, include: { permissionOverrides: true } });
      if (!current?.active || current.deletedAt) denyWriteAccess();
      actor = { ...claimed, role: current.role, permissionOverrides: current.permissionOverrides, clientReadScope: [] };
    }
    if (!hasPermission(actor, 'document.upload')) denyWriteAccess();
    await tx.$queryRaw`SELECT id FROM "Client" WHERE id=${data.clientId} FOR UPDATE`;
    const initialService = data.clientServiceId ? await tx.clientService.findUnique({ where: { id: data.clientServiceId } }) : null;
    const projectIds = [...new Set([data.projectId, initialService?.projectId].filter((id): id is string => Boolean(id)))].sort();
    for (const id of projectIds) await tx.$queryRaw`SELECT id FROM "Project" WHERE id=${id} FOR UPDATE`;
    if (data.clientServiceId) await tx.$queryRaw`SELECT id FROM "ClientService" WHERE id=${data.clientServiceId} FOR UPDATE`;
    const projects = await tx.project.findMany({ where: { id: { in: projectIds } } });
    const companyIds = [...new Set([data.companyId, initialService?.companyId, ...projects.map(project => project.companyId)].filter((id): id is string => Boolean(id)))].sort();
    for (const id of companyIds) await tx.$queryRaw`SELECT id FROM "Company" WHERE id=${id} FOR UPDATE`;
    const context = await requireClientContextWriteAccess(actor, data, tx);
    if ((context.clientService?.projectId ?? null) !== (initialService?.projectId ?? null) || (context.clientService?.companyId ?? null) !== (initialService?.companyId ?? null)) denyWriteAccess();
    if (!canAccessFinancialDocumentMetadata(actor, { ...data, fileName, mimeType: file.type })) denyWriteAccess();
    const assertLive = async () => {
      if (actor.expiresAt * 1000 <= Date.now()) denyWriteAccess();
      if (actor.sessionId) {
        const [row] = await tx.$queryRaw<Array<{ live: boolean }>>`SELECT "expiresAt">clock_timestamp() AND "revokedAt" IS NULL AS live FROM "InternalSession" WHERE id=${actor.sessionId}::uuid AND "userId"=${actor.userId}`;
        if (!row?.live) denyWriteAccess();
      }
    };
    const prior = await tx.auditLog.findUnique({ where: { id: receiptId } });
    if (prior) {
      const receipt = receiptSchema.safeParse(prior.after);
      if (prior.actorId !== actor.userId || prior.event !== 'document_upload' || !receipt.success || receipt.data.requestFingerprint !== requestFingerprint) throw new UserFacingActionError('Questa richiesta di caricamento è già stata usata con dati diversi. Controlla i documenti salvati.');
      const document = await tx.document.findUnique({ where: { id: receipt.data.documentId } });
      if (!document || document.deletedAt || document.clientId !== data.clientId || document.projectId !== (data.projectId ?? null) || document.clientServiceId !== (data.clientServiceId ?? null)
        || document.checksum !== checksum || !await canAccessFinancialDocument(tx, actor, document)) denyWriteAccess();
      await assertLive();
      return document;
    }
    await assertLive();
    const saved = await savePrivateDocumentFile({ file, clientId: data.clientId, clientServiceId: data.clientServiceId, fileName, storageToken });
    const document = await tx.document.create({ data: { ...data,
      documentCategory: /\.zip$/i.test(fileName) ? 'archivio_riservato' : data.documentCategory,
      type: file.type || 'application/octet-stream', fileName, mimeType: file.type || 'application/octet-stream',
      sizeBytes: saved.sizeBytes, storagePath: saved.storagePath, checksum: saved.checksum, uploadedById: actor.userId } });
    await tx.documentVersion.create({ data: { documentId: document.id, version: 1, storagePath: saved.storagePath, checksum: saved.checksum } });
    await tx.auditLog.create({ data: { id: receiptId, actorId: actor.userId, event: 'document_upload', entityType: 'Document', entityId: document.id,
      after: { version: 1, documentId: document.id, requestFingerprint, fileHash: checksum, sizeBytes: saved.sizeBytes } } });
    await assertLive();
    return document;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 30_000 });
}
