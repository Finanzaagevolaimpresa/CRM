import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { AuthSession } from './auth';
import { ApprovedCommunicationError, communicationContextSchema } from './approved-communication-contract';
import { loadCommunicationFileContext } from './approved-communications';
import { communicationFileWhere } from './communication-contexts';
import { canReadCommunicationFile, communicationFileContextMaxBytes, communicationFileContextMaxCount, communicationFileMaxBytes } from './communication-file-policy';
import { readPrivateDocumentBounded, sanitizeFileName, savePrivateCommunicationFile } from './storage';
import { recordCommunicationFileCommand, communicationFileCommandHash, communicationFileDerivedCommand } from './communication-file-journal';

type Db = Pick<PrismaClient, '$transaction'>;
const request = z.object({ id: z.string().uuid(), context: communicationContextSchema }).strict();
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function deny(): never { throw new ApprovedCommunicationError('DENIED'); }
function conflict(): never { throw new ApprovedCommunicationError('CONFLICT'); }

export async function storeCommunicationFile(db: Db, claimed: AuthSession, raw: unknown, file: File) {
  const input = request.extend({ classification: z.enum(['ORDINARY','SENSITIVE','COMPLAINT']) }).strict().parse(raw);
  if (!(file instanceof File) || file.size < 1 || file.size > communicationFileMaxBytes) deny();
  const fileName = sanitizeFileName(file.name).slice(0,200), mimeType = file.type || 'application/octet-stream';
  if (!/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(mimeType) || mimeType.length > 120) deny();
  const content = Buffer.from(await file.arrayBuffer()); if (content.length !== file.size) deny();
  const fingerprint = { ...input, fileName, mimeType, sizeBytes: content.length, sha256: hash(content) };
  const requestHash = communicationFileCommandHash(fingerprint);
  return db.$transaction(async tx => {
    const a = await loadCommunicationFileContext(tx, claimed, input.context, true);
    if (!a.current.sessionId || !canReadCommunicationFile(a.current,input.classification)) deny();
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'admin-record:' + input.id},0))::text`;
    const previous = await tx.adminRecordRevision.findUnique({ where: { commandId: input.id } });
    if (previous && (previous.actorId !== a.current.userId || previous.model !== 'CommunicationContextFile'
      || previous.recordId !== input.id || previous.operation !== 'CREATE' || previous.requestHash !== requestHash)) conflict();
    const existing = await tx.communicationContextFile.findUnique({ where: { id: input.id } });
    if (existing) {
      const same = communicationFileCommandHash({ ...input, classification: existing.classification,
        fileName: existing.fileName, mimeType: existing.mimeType, sizeBytes: existing.sizeBytes, sha256: existing.sha256 });
      if (existing.uploadedById !== a.current.userId || same !== requestHash
        || !await tx.communicationContextFile.findFirst({ where: { id: input.id, ...communicationFileWhere(input.context) } })) conflict();
      await a.check(); return { id: input.id, replayed: true };
    }
    if (previous) conflict();
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`communication-files:${input.context.kind}:${input.context.id}`},0))::text`;
    const usage = await tx.communicationContextFile.aggregate({ where: communicationFileWhere(input.context), _count: { id: true }, _sum: { sizeBytes: true } });
    // Revoked files still occupy storage; revocation never silently deletes them.
    if (usage._count.id >= communicationFileContextMaxCount || (usage._sum.sizeBytes ?? 0) + file.size > communicationFileContextMaxBytes) throw new ApprovedCommunicationError('INVALID');
    const saved = await savePrivateCommunicationFile({ file, fileName, id: input.id, contextKind: input.context.kind, contextId: input.context.id });
    if (saved.sha256 !== fingerprint.sha256 || saved.sizeBytes !== fingerprint.sizeBytes) conflict();
    const context = input.context;
    const created = await tx.communicationContextFile.create({ data: { id: input.id, contextKind: context.kind,
      clientId: context.kind === 'CLIENT' ? context.id : null, leadId: context.kind === 'LEAD' ? context.id : null,
      readinessId: context.kind === 'READINESS' ? context.id : null, technicalPracticeId: context.kind === 'TECHNICAL' ? context.id : null,
      internalThreadId: context.kind === 'INTERNAL' ? context.id : null, uploadedById: a.current.userId,
      fileName, mimeType, classification: input.classification, ...saved } });
    await tx.auditLog.create({ data: { actorId: a.current.userId, entityType: 'CommunicationContextFile', entityId: input.id,
      event: 'communication_file_uploaded', after: { fileHash: saved.sha256, sizeBytes: saved.sizeBytes, contextKind: context.kind } } });
    await recordCommunicationFileCommand(tx, { commandId: input.id, id: input.id, actorId: a.current.userId, sessionId: a.current.sessionId,
      operation: 'CREATE', requestHash, before: null, after: created, reason: 'Caricamento esplicito di un allegato nel contesto scelto.' });
    await a.check(); await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
    return { id: input.id, replayed: false };
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
  const input = request.extend({ sha256: z.string().regex(/^[a-f0-9]{64}$/), commandId: z.string().uuid().optional() }).strict().parse(raw);
  const commandId = input.commandId ?? communicationFileDerivedCommand('legacy-communication-file-revocation', input.id);
  const requestHash = communicationFileCommandHash({ ...input, commandId });
  return db.$transaction(async tx => {
    const a = await loadCommunicationFileContext(tx,claimed,input.context,true);
    if (!a.current.sessionId) deny();
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'admin-record:' + commandId},0))::text`;
    const previous = await tx.adminRecordRevision.findUnique({ where: { commandId } });
    if (previous && (previous.actorId !== a.current.userId || previous.model !== 'CommunicationContextFile'
      || previous.recordId !== input.id || previous.operation !== 'UPDATE' || previous.requestHash !== requestHash)) conflict();
    await tx.$queryRaw`SELECT "id" FROM "CommunicationContextFile" WHERE "id"=${input.id}::uuid FOR UPDATE`;
    const file = await tx.communicationContextFile.findFirst({ where: { id: input.id, ...communicationFileWhere(input.context) } });
    if (!file || file.sha256 !== input.sha256 || !canReadCommunicationFile(a.current,file.classification)) deny();
    if (file.revokedAt) { await a.check(); return { id: file.id, commandId, replayed: true }; }
    if (previous) conflict();
    const revoked = await tx.communicationContextFile.update({ where: { id: file.id }, data: { revokedAt: new Date() } });
    await tx.auditLog.create({ data: { actorId: a.current.userId, entityType: 'CommunicationContextFile', entityId: file.id,
      event: 'communication_file_revoked', after: { fileHash: file.sha256 } } });
    await recordCommunicationFileCommand(tx, { commandId, id: file.id, actorId: a.current.userId, sessionId: a.current.sessionId,
      operation: 'UPDATE', requestHash, before: file, after: revoked, reason: 'Revoca esplicita della disponibilità di questa versione del file.' });
    await a.check(); await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
    return { id: file.id, commandId, replayed: false };
  }, { timeout: 30_000 });
}

/** A closure is a durable barrier against a request that arrives late. Reading
 * an absent row alone must never authorize a new upload or a blind second command. */
export async function reconcileCommunicationFileCommand(db: Db, claimed: AuthSession, raw: unknown) {
  const input = request.extend({ commandId: z.string().uuid(), operation: z.enum(['UPLOAD','REVOKE']), close: z.boolean() }).strict().parse(raw);
  if (input.operation === 'UPLOAD' && input.commandId !== input.id) deny();
  return db.$transaction(async tx => {
    const a = await loadCommunicationFileContext(tx, claimed, input.context, input.close);
    if (a.current.role !== 'admin' || !a.current.sessionId) deny();
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'admin-record:' + input.commandId},0))::text`;
    const previous = await tx.adminRecordRevision.findUnique({ where: { commandId: input.commandId } });
    if (previous && (previous.actorId !== a.current.userId || previous.model !== 'CommunicationContextFile' || previous.recordId !== input.id)) deny();
    if (previous?.operation === 'CLOSE') { await a.check(); return { status: 'CLOSED' as const }; }
    await tx.$queryRaw`SELECT "id" FROM "CommunicationContextFile" WHERE "id"=${input.id}::uuid FOR SHARE`;
    const file = await tx.communicationContextFile.findFirst({ where: { id: input.id, ...communicationFileWhere(input.context) } });
    if (file && (!canReadCommunicationFile(a.current,file.classification) || input.operation === 'UPLOAD' && file.uploadedById !== a.current.userId)) deny();
    if (file && (input.operation === 'UPLOAD' || file.revokedAt)) { await a.check(); return { status: 'RECORDED' as const }; }
    if (previous) conflict();
    if (input.operation === 'REVOKE' && !file) deny();
    if (!input.close) { await a.check(); return { status: 'UNKNOWN' as const }; }
    await recordCommunicationFileCommand(tx, { commandId: input.commandId, id: input.id, actorId: a.current.userId, sessionId: a.current.sessionId,
      operation: 'CLOSE', requestHash: communicationFileCommandHash(input), before: null, after: null,
      reason: 'Tentativo di gestione allegato verificato e chiuso senza modifica del file.' });
    await a.check(); await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
    return { status: 'CLOSED' as const };
  }, { timeout: 30_000 });
}
