import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient, type CommunicationContextFile } from '@prisma/client';
import { z } from 'zod';
import type { AuthSession } from './auth';
import { canonicalSha256 } from './canonical-json';
import { updateActor, type UpdateCredentials } from './record-updates';
import { recordUpdatePermission } from './record-update-context';
import { adminCommunicationSourceContext, loadCommunicationFileContext } from './approved-communications';
import { ApprovedCommunicationError, communicationContextSchema, type CommunicationContext } from './approved-communication-contract';
import { communicationFileWhere } from './communication-contexts';
import { canReadCommunicationFile, communicationFileContextMaxBytes, communicationFileContextMaxCount, communicationFileMaxBytes } from './communication-file-policy';
import { assertSafeUploadName, readPrivateDocumentBounded, savePrivateCommunicationFile } from './storage';
import { mapSerializableConflict } from './serializable';
import { recordCommunicationFileCommand, communicationFileDerivedCommand } from './communication-file-journal';

type Tx = Prisma.TransactionClient;
type Authority = Awaited<ReturnType<typeof updateActor>>;
const plain = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const version = (value: unknown) => canonicalSha256(plain(value));
const byteHash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export class AdminCommunicationFileError extends Error {
  constructor(readonly code: 'DENIED' | 'INVALID' | 'STALE' | 'CLOSED' | 'QUOTA') { super('ADMIN_COMMUNICATION_FILE_' + code); }
}
function fail(code: AdminCommunicationFileError['code']): never { throw new AdminCommunicationFileError(code); }
const fileCommand = z.object({ commandId: z.string().uuid(), id: z.string().uuid(), sourceId: z.string().uuid(),
  expectedVersion: z.string().regex(/^[a-f0-9]{64}$/), action: z.enum(['REPLACE', 'RESTORE']),
  context: communicationContextSchema, fileName: z.string().trim().min(1).max(200),
  classification: z.enum(['ORDINARY', 'SENSITIVE', 'COMPLAINT']), reason: z.string().trim().min(3).max(2000),
  confirmed: z.literal(true) }).strict();
export type AdminCommunicationFileCommand = z.infer<typeof fileCommand>;

async function transaction<T>(db: PrismaClient, callback: (tx: Tx) => Promise<T>) {
  try { return await db.$transaction(async tx => {
    const result = await callback(tx); await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`; return result;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 }); }
  catch (error) { throw mapSerializableConflict(error); }
}
async function authority(tx: Tx, session: AuthSession, proof?: UpdateCredentials) {
  const auth = await updateActor(tx, session, proof);
  if (auth.actor.role !== 'admin' || !recordUpdatePermission(auth.actor, 'practice_communications.read')
    || proof && !recordUpdatePermission(auth.actor, 'practice_communications.write')) fail('DENIED');
  return auth;
}
function fileContext(file: CommunicationContextFile): CommunicationContext {
  return communicationContextSchema.parse({ kind: file.contextKind,
    id: file.clientId ?? file.leadId ?? file.readinessId ?? file.technicalPracticeId ?? file.internalThreadId });
}
async function admittedSource(tx: Tx, auth: Authority, id: string, write = false) {
  z.string().uuid().parse(id);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "CommunicationContextFile" WHERE "id"=${id}::uuid ${write ? Prisma.sql`FOR UPDATE` : Prisma.sql`FOR SHARE`}`);
  const row = await tx.communicationContextFile.findUnique({ where: { id } });
  if (!row) fail('DENIED');
  await adminCommunicationSourceContext(tx, { ...auth.actor, userId: auth.actor.id }, 'CommunicationContextFile', id);
  return row;
}
const metadata = (row: CommunicationContextFile) => ({ id: row.id, fileName: row.fileName, classification: row.classification,
  sizeBytes: row.sizeBytes, sha256: row.sha256, revokedAt: row.revokedAt?.toISOString() ?? null });
export async function readAdminCommunicationFile(db: PrismaClient, session: AuthSession, id: string, page = 1) {
  if (!Number.isSafeInteger(page) || page < 1 || page > 1000) fail('INVALID');
  return transaction(db, async tx => {
    const auth = await authority(tx, session), row = await admittedSource(tx, auth, id);
    const context = fileContext(row), native = await loadCommunicationFileContext(tx, session, context, false);
    let canWrite = recordUpdatePermission(auth.actor, 'practice_communications.write');
    if (canWrite) {
      try { const writing = await loadCommunicationFileContext(tx, session, context, true); await writing.check(); }
      catch (error) { if (!(error instanceof ApprovedCommunicationError)) throw error; canWrite = false; }
    }
    const origin = await tx.adminRecordRevision.findFirst({ where: { model: 'CommunicationContextFile', recordId: id, operation: 'CREATE' } });
    const source = z.object({ administrativeSource: z.object({ id: z.string().uuid(), action: z.enum(['REPLACE','RESTORE']) }) }).safeParse(origin?.after);
    const candidates = await tx.adminRecordRevision.findMany({ where: { model: 'CommunicationContextFile', operation: 'CREATE',
      after: { path: ['administrativeSource', 'id'], equals: id } }, orderBy: { createdAt: 'desc' }, take: 50, skip: (page - 1) * 50 });
    const children: ReturnType<typeof metadata>[] = [];
    for (const candidate of candidates) {
      try { children.push(metadata(await admittedSource(tx, auth, candidate.recordId))); }
      catch (error) { if (!(error instanceof ApprovedCommunicationError || error instanceof AdminCommunicationFileError)) throw error; }
    }
    let sourceId: string | null = null;
    if (source.success) {
      try { await admittedSource(tx, auth, source.data.administrativeSource.id); sourceId = source.data.administrativeSource.id; }
      catch (error) { if (!(error instanceof ApprovedCommunicationError || error instanceof AdminCommunicationFileError)) throw error; }
    }
    await native.check(); await auth.finish();
    return { ...metadata(row), expectedVersion: version(row), context, contextLabel: native.scope.label,
      canWrite, sourceId, children, page, hasMore: candidates.length === 50 };
  });
}

export async function searchAdminCommunicationFileContexts(db: PrismaClient, session: AuthSession, raw: unknown) {
  const input = z.object({ kind: z.enum(['LEAD','CLIENT','READINESS','TECHNICAL','INTERNAL']), query: z.string().trim().max(120),
    page: z.number().int().min(1).max(1000).default(1) }).strict().parse(raw);
  return transaction(db, async tx => {
    const auth = await authority(tx, session);
    if (!recordUpdatePermission(auth.actor, 'practice_communications.write')) fail('DENIED');
    const term = { contains: input.query, mode: 'insensitive' as const }, window = { take: 50, skip: (input.page - 1) * 50, orderBy: { id: 'asc' as const }, select: { id: true } };
    const candidates = input.kind === 'CLIENT' ? await tx.client.findMany({ where: { deletedAt: null, displayName: term }, ...window })
      : input.kind === 'LEAD' ? await tx.lead.findMany({ where: { deletedAt: null, OR: [{ firstName: term }, { lastName: term }, { companyName: term }, { email: term }] }, ...window })
      : input.kind === 'TECHNICAL' ? await tx.technicalPractice.findMany({ where: { deletedAt: null, title: term }, ...window })
      : input.kind === 'INTERNAL' ? await tx.internalCommunicationThread.findMany({ where: { deletedAt: null, title: term }, ...window })
      : await tx.$queryRaw<Array<{ id: string }>>`SELECT p.id FROM "PracticeReadiness" p JOIN "Client" c ON c.id=p."clientId"
          WHERE c."deletedAt" IS NULL AND c."displayName" ILIKE ${'%' + input.query + '%'} ORDER BY p.id LIMIT 50 OFFSET ${(input.page - 1) * 50}`;
    const choices: { context: CommunicationContext; label: string }[] = [];
    for (const candidate of candidates) {
      const context = communicationContextSchema.parse({ kind: input.kind, id: candidate.id });
      try {
        const admitted = await loadCommunicationFileContext(tx, session, context, true);
        await admitted.check(); choices.push({ context, label: admitted.scope.label });
      } catch (error) { if (!(error instanceof ApprovedCommunicationError)) throw error; }
    }
    await auth.finish();
    return { choices, page: input.page, hasMore: candidates.length === 50 };
  });
}

async function journal(tx: Tx, auth: Authority, input: { commandId: string; id: string; requestHash: string; reason: string },
  operation: 'CREATE' | 'UPDATE', before: unknown, after: unknown) {
  return recordCommunicationFileCommand(tx, { ...input, actorId: auth.actor.id, sessionId: auth.registry.id, operation, before, after });
}

export async function replaceAdminCommunicationFile(db: PrismaClient, session: AuthSession, raw: unknown,
  replacement: File | null, proof: UpdateCredentials) {
  const input = fileCommand.parse(raw);
  if (input.id === input.sourceId) fail('INVALID');
  assertSafeUploadName(input.fileName);
  if (replacement && (!(replacement instanceof File) || replacement.size < 1 || replacement.size > communicationFileMaxBytes)) fail('INVALID');
  if (input.action === 'RESTORE' && replacement) fail('INVALID');
  const replacementBytes = replacement ? Buffer.from(await replacement.arrayBuffer()) : null;
  if (replacementBytes && replacementBytes.length !== replacement!.size) fail('INVALID');
  const incoming = replacement ? { bytes: replacement.size, sha256: byteHash(replacementBytes!), mimeType: replacement.type || 'application/octet-stream' } : null;
  if (incoming && (incoming.mimeType.length > 120 || !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(incoming.mimeType))) fail('INVALID');
  const requestHash = version({ input, incoming });
  return transaction(db, async tx => {
    const auth = await authority(tx, session, proof);
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'admin-record:' + input.commandId},0))::text`;
    const previous = await tx.adminRecordRevision.findUnique({ where: { commandId: input.commandId } });
    if (previous) {
      if (previous.actorId !== auth.actor.id || previous.model !== 'CommunicationContextFile' || previous.recordId !== input.id) fail('DENIED');
      if (previous.operation === 'CLOSE') fail('CLOSED');
      if (previous.requestHash !== requestHash) fail('STALE');
      await admittedSource(tx, auth, previous.recordId);
      await auth.finish();
      return { commandId: input.commandId, model: 'CommunicationContextFile', id: input.id, replayed: true };
    }
    const source = await admittedSource(tx, auth, input.sourceId, true), sourceContext = fileContext(source);
    if (version(source) !== input.expectedVersion || input.action === 'RESTORE' && !source.revokedAt) fail('STALE');
    const sourceAdmission = await loadCommunicationFileContext(tx, session, sourceContext, true);
    const destination = await loadCommunicationFileContext(tx, session, input.context, true);
    if (!canReadCommunicationFile(destination.current, input.classification)) fail('DENIED');
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`communication-files:${input.context.kind}:${input.context.id}`},0))::text`;
    if (await tx.communicationContextFile.findUnique({ where: { id: input.id } })) fail('STALE');
    const bytes = replacementBytes ?? await readPrivateDocumentBounded(source.storagePath, communicationFileMaxBytes);
    if (!replacementBytes && (bytes.length !== source.sizeBytes || byteHash(bytes) !== source.sha256)) fail('STALE');
    const usage = await tx.communicationContextFile.aggregate({ where: communicationFileWhere(input.context), _count: { id: true }, _sum: { sizeBytes: true } });
    if (usage._count.id >= communicationFileContextMaxCount || (usage._sum.sizeBytes ?? 0) + bytes.length > communicationFileContextMaxBytes) fail('QUOTA');
    const file = new File([new Uint8Array(bytes)], input.fileName, { type: incoming?.mimeType ?? source.mimeType });
    const saved = await savePrivateCommunicationFile({ file, fileName: input.fileName, id: input.id,
      contextKind: input.context.kind, contextId: input.context.id });
    const context = input.context;
    const created = await tx.communicationContextFile.create({ data: { id: input.id, contextKind: context.kind,
      clientId: context.kind === 'CLIENT' ? context.id : null, leadId: context.kind === 'LEAD' ? context.id : null,
      readinessId: context.kind === 'READINESS' ? context.id : null, technicalPracticeId: context.kind === 'TECHNICAL' ? context.id : null,
      internalThreadId: context.kind === 'INTERNAL' ? context.id : null, uploadedById: auth.actor.id,
      fileName: input.fileName, mimeType: file.type, classification: input.classification, ...saved } });
    if (!source.revokedAt) {
      const revoked = await tx.communicationContextFile.update({ where: { id: source.id }, data: { revokedAt: await auth.finish() } });
      await journal(tx, auth, { ...input, commandId: communicationFileDerivedCommand('admin-communication-file-source-revocation', input.commandId), id: source.id,
        requestHash: version({ commandId: input.commandId, replacementId: input.id }) }, 'UPDATE', source, revoked);
    }
    await journal(tx, auth, { ...input, requestHash }, 'CREATE', null, { ...created,
      administrativeSource: { id: source.id, sha256: source.sha256, version: input.expectedVersion, action: input.action } });
    await sourceAdmission.check(); await destination.check(); await auth.finish();
    return { commandId: input.commandId, model: 'CommunicationContextFile', id: input.id, replayed: false };
  });
}
