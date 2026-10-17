import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { AuthSession } from './auth';
import { ApprovedCommunicationError, communicationContextSchema } from './approved-communication-contract';
import { loadCommunicationFileContext } from './approved-communications';
import { communicationFileWhere } from './communication-contexts';
import { canReadCommunicationFile, communicationFileContextMaxBytes, communicationFileContextMaxCount, communicationFileMaxBytes } from './communication-file-policy';
import { readPrivateDocumentBounded, sanitizeFileName, savePrivateCommunicationFile } from './storage';

type Db = Pick<PrismaClient, '$transaction'>;
const request = z.object({ id: z.string().uuid(), context: communicationContextSchema }).strict();
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function deny(): never { throw new ApprovedCommunicationError('DENIED'); }

export async function storeCommunicationFile(db: Db, claimed: AuthSession, raw: unknown, file: File) {
  const input = request.extend({ classification: z.enum(['ORDINARY','SENSITIVE','COMPLAINT']) }).strict().parse(raw);
  if (!(file instanceof File) || file.size < 1 || file.size > communicationFileMaxBytes) deny();
  const fileName = sanitizeFileName(file.name).slice(0,200), mimeType = file.type || 'application/octet-stream';
  if (!/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(mimeType) || mimeType.length > 120) deny();
  return db.$transaction(async tx => {
    const a = await loadCommunicationFileContext(tx, claimed, input.context, true);
    if (!canReadCommunicationFile(a.current,input.classification)) deny();
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`communication-files:${input.context.kind}:${input.context.id}`},0))`;
    if (await tx.communicationContextFile.findUnique({ where: { id: input.id } })) throw new ApprovedCommunicationError('CONFLICT');
    const usage = await tx.communicationContextFile.aggregate({ where: communicationFileWhere(input.context), _count: { id: true }, _sum: { sizeBytes: true } });
    // Revoked files still occupy storage; revocation never silently deletes them.
    if (usage._count.id >= communicationFileContextMaxCount || (usage._sum.sizeBytes ?? 0) + file.size > communicationFileContextMaxBytes) throw new ApprovedCommunicationError('INVALID');
    const saved = await savePrivateCommunicationFile({ file, fileName, id: input.id, contextKind: input.context.kind, contextId: input.context.id });
    const context = input.context;
    await tx.communicationContextFile.create({ data: { id: input.id, contextKind: context.kind,
      clientId: context.kind === 'CLIENT' ? context.id : null, leadId: context.kind === 'LEAD' ? context.id : null,
      readinessId: context.kind === 'READINESS' ? context.id : null, technicalPracticeId: context.kind === 'TECHNICAL' ? context.id : null,
      internalThreadId: context.kind === 'INTERNAL' ? context.id : null, uploadedById: a.current.userId,
      fileName, mimeType, classification: input.classification, ...saved } });
    await tx.auditLog.create({ data: { actorId: a.current.userId, entityType: 'CommunicationContextFile', entityId: input.id,
      event: 'communication_file_uploaded', after: { fileHash: saved.sha256, sizeBytes: saved.sizeBytes, contextKind: context.kind } } });
    await a.check();
    return { id: input.id };
  }, { timeout: 30_000 });
}

export async function readCommunicationFile(db: Db, claimed: AuthSession, raw: unknown) {
  const input = request.extend({ sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(raw);
  return db.$transaction(async tx => {
    const a = await loadCommunicationFileContext(tx,claimed,input.context,false);
    await tx.$queryRaw`SELECT "id" FROM "CommunicationContextFile" WHERE "id"=${input.id}::uuid FOR SHARE`;
    const file = await tx.communicationContextFile.findFirst({ where: { id: input.id, revokedAt: null, ...communicationFileWhere(input.context) } });
    if (!file || file.sha256 !== input.sha256 || !canReadCommunicationFile(a.current,file.classification)) deny();
    const bytes = await readPrivateDocumentBounded(file.storagePath,communicationFileMaxBytes);
    if (bytes.length !== file.sizeBytes || hash(bytes) !== file.sha256) deny();
    await a.check();
    return { bytes, fileName: file.fileName };
  }, { timeout: 30_000 });
}

export async function revokeCommunicationFile(db: Db, claimed: AuthSession, raw: unknown) {
  const input = request.extend({ sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(raw);
  return db.$transaction(async tx => {
    const a = await loadCommunicationFileContext(tx,claimed,input.context,true);
    await tx.$queryRaw`SELECT "id" FROM "CommunicationContextFile" WHERE "id"=${input.id}::uuid FOR UPDATE`;
    const file = await tx.communicationContextFile.findFirst({ where: { id: input.id, revokedAt: null, ...communicationFileWhere(input.context) } });
    if (!file || file.sha256 !== input.sha256 || !canReadCommunicationFile(a.current,file.classification)) deny();
    await tx.communicationContextFile.update({ where: { id: file.id }, data: { revokedAt: new Date() } });
    await tx.auditLog.create({ data: { actorId: a.current.userId, entityType: 'CommunicationContextFile', entityId: file.id,
      event: 'communication_file_revoked', after: { fileHash: file.sha256 } } });
    await a.check();
    return { id: file.id };
  }, { timeout: 30_000 });
}
