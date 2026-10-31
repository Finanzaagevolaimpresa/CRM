import { Prisma, type PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AuthSession } from './auth';
import type { UpdateCredentials } from './record-updates';
import { adminPrivateDocumentAuthority, adminPrivateDocumentSource } from './admin-private-document-metadata';
import { assertOperationalActive } from './admin-operational-state';
import { recordUpdatePermission } from './record-update-context';
import { privateVersionModel, privateVersionFile, privateVersionDigest as digest, PrivateVersionError } from './private-document-versions';
import { documentUploadMaxBytes, validateUploadSelection } from './document-upload-contract';
import { selectedDocumentMode } from './selected-document-formats';
import { assertSafeUploadName, sanitizeFileName, readPrivateDocumentBounded, savePrivateDocumentFile } from './storage';
import { mapSerializableConflict, SerializableConflictError } from './serializable';
type Tx = Prisma.TransactionClient;
type Authority = Awaited<ReturnType<typeof adminPrivateDocumentAuthority>>;
const command = z.object({ commandId: z.string().uuid(), id: z.string().min(1).max(128),
  expectedVersion: z.string().regex(/^[a-f0-9]{64}$/), restoreVersionId: z.string().min(1).max(128).nullable(),
  reason: z.string().trim().min(3).max(2000), confirmed: z.literal(true) }).strict();
async function transaction<T>(db: PrismaClient, work: (tx: Tx) => Promise<T>) {
  try { return await db.$transaction(async tx => { const result = await work(tx);
    await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE'); return result;
  }, { isolationLevel: 'Serializable', timeout: 30000 }); } catch (error) { throw mapSerializableConflict(error); }
}
const plain = (v: unknown) => v === null ? Prisma.JsonNull : JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
async function journal(tx: Tx, current: Authority, input: { commandId: string; id: string; reason: string }, requestHash: string,
  operation: 'UPDATE' | 'CLOSE', before: unknown, after: unknown) {
  const beforeHash = digest(before), afterHash = digest(after);
  await tx.adminRecordRevision.create({ data: { commandId: input.commandId, model: privateVersionModel, recordId: input.id,
    actorId: current.actor.id, sessionId: current.registry.id, operation, requestHash, beforeHash, afterHash, before: plain(before), after: plain(after), reason: input.reason } });
  await tx.auditLog.create({ data: { id: 'admin-record:' + input.commandId, actorId: current.actor.id,
    entityType: privateVersionModel, entityId: input.id, event: operation === 'CLOSE' ? 'admin_record_attempt_closed' : 'admin_record_changed',
    after: operation === 'CLOSE' ? { commandId: input.commandId } : { commandId: input.commandId, action: operation, beforeHash, afterHash,
      declaration: 'ADMINISTRATIVE_BINARY_VERSION_ORIGINAL_ACQUISITION_RETAINED' } } });
}
async function lock(tx: Tx, id: string) { await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))::text', 'admin-record:' + id); }
type Source = Awaited<ReturnType<typeof adminPrivateDocumentSource>>;
const sourceVersion = (source: Source) => digest({ sourceVersion: source.expectedVersion, versions: source.saved.administrativeVersions.current });
function versionOptions(source: Source) {
  return [{ versionId: source.saved.version.id, version: 1, fileName: source.document.fileName, mimeType: source.document.mimeType,
    sizeBytes: source.document.sizeBytes, sha256: source.saved.version.checksum!, at: source.saved.version.createdAt.toISOString(),
    reason: 'Acquisizione originale', actorId: source.saved.record.receipt.actorId },
  ...source.saved.administrativeVersions.additions.map(v => ({ versionId: v.version.id, version: v.version.version, ...v.file, at: v.at, reason: v.reason, actorId: v.actorId }))];
}
export async function readAdminPrivateVersions(db: PrismaClient, session: AuthSession, id: string) {
  return transaction(db, async tx => {
    const current = await adminPrivateDocumentAuthority(tx, session), source = await adminPrivateDocumentSource(tx, current, id);
    const versions = versionOptions(source);
    const people = await tx.user.findMany({ where: { id: { in: [...new Set(versions.map(v => v.actorId))] } }, select: { id: true, name: true, email: true } });
    await current.finish(); return { id, title: source.saved.effectiveDocument.title, clientId: source.document.clientId!,
      canWrite: recordUpdatePermission(current.actor, 'document.upload'), expectedVersion: sourceVersion(source),
      versions: versions.map(v => ({ ...v, actor: people.find(p => p.id === v.actorId) ?? null })) };
  });
}
export async function saveAdminPrivateVersion(db: PrismaClient, session: AuthSession, raw: unknown, incoming: File | null, proof: UpdateCredentials) {
  const input = command.parse(raw);
  if (input.restoreVersionId ? incoming !== null : !incoming || validateUploadSelection([incoming])) throw new PrivateVersionError('INVALID');
  if (incoming && incoming.size > documentUploadMaxBytes) throw new PrivateVersionError('INVALID');
  return transaction(db, async tx => {
    const current = await adminPrivateDocumentAuthority(tx, session, proof); await lock(tx, input.commandId);
    const previous = await tx.adminRecordRevision.findUnique({ where: { commandId: input.commandId } });
    if (previous && (previous.model !== privateVersionModel || previous.recordId !== input.id || previous.actorId !== current.actor.id)) throw new PrivateVersionError('DENIED');
    if (previous?.operation === 'CLOSE') throw new PrivateVersionError('CLOSED');
    const source = await adminPrivateDocumentSource(tx, current, input.id, true);
    const options = versionOptions(source), restored = input.restoreVersionId ? options.find(v => v.versionId === input.restoreVersionId) : null;
    if (input.restoreVersionId && !restored) throw new PrivateVersionError('INVALID');
    let file = incoming;
    if (restored) {
      const version = restored.version === 1 ? source.saved.version : source.saved.administrativeVersions.additions.find(v => v.version.id === restored.versionId)!.version;
      const bytes = await readPrivateDocumentBounded(version.storagePath, documentUploadMaxBytes);
      if (bytes.length !== restored.sizeBytes || createHash('sha256').update(bytes).digest('hex') !== restored.sha256) throw new PrivateVersionError('INTEGRITY');
      file = new File([bytes], restored.fileName, { type: restored.mimeType });
    }
    if (!file) throw new PrivateVersionError('INVALID');
    const fileName = sanitizeFileName(file.name); assertSafeUploadName(fileName);
    const bytes = Buffer.from(await file.arrayBuffer());
    if (bytes.length !== file.size || !bytes.length || bytes.length > documentUploadMaxBytes) throw new PrivateVersionError('INVALID');
    const mimeType = selectedDocumentMode({ fileName, mimeType: file.type }) ? file.type : 'application/octet-stream';
    const metadata = privateVersionFile.parse({ fileName, mimeType, sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    const requestHash = digest({ protocol: 'ADMIN_PRIVATE_DOCUMENT_VERSION_V1', input, file: metadata });
    if (previous) {
      if (previous.requestHash !== requestHash) throw new PrivateVersionError('STALE');
      await current.finish(); return { replayed: true };
    }
    await assertOperationalActive(tx, 'Document', input.id);
    if (sourceVersion(source) !== input.expectedVersion) throw new PrivateVersionError('STALE');
    const before = source.saved.administrativeVersions.current;
    const stored = await savePrivateDocumentFile({ file: new File([bytes], fileName, { type: mimeType }), clientId: source.document.clientId!,
      clientServiceId: source.document.clientServiceId ?? undefined, fileName, storageToken: digest({ protocol: 'ADMIN_PRIVATE_VERSION_FILE_V1', commandId: input.commandId, id: input.id }) });
    if (stored.checksum !== metadata.sha256 || stored.sizeBytes !== metadata.sizeBytes) throw new PrivateVersionError('INTEGRITY');
    const createdAt = await current.finish();
    const version = await tx.documentVersion.create({ data: { id: 'admin-version-' + input.commandId, documentId: input.id,
      version: before.versionCount + 1, storagePath: stored.storagePath, checksum: stored.checksum, createdAt } });
    const after = { ...before, versionCount: version.version, latestVersionId: version.id, version: { ...version, createdAt: version.createdAt.toISOString() }, file: metadata };
    await journal(tx, current, input, requestHash, 'UPDATE', before, after);
    await adminPrivateDocumentSource(tx, current, input.id); await current.finish(); return { replayed: false };
  });
}
export async function reconcileAdminPrivateVersion(db: PrismaClient, session: AuthSession, raw: unknown) {
  const input = z.object({ commandId: z.string().uuid(), id: z.string().min(1).max(128), close: z.boolean() }).strict().parse(raw);
  for (let attempt = 0; ; attempt++) {
    try { return await transaction(db, async tx => {
      const current = await adminPrivateDocumentAuthority(tx, session); await lock(tx, input.commandId);
      await adminPrivateDocumentSource(tx, current, input.id);
      const previous = await tx.adminRecordRevision.findUnique({ where: { commandId: input.commandId } });
      if (previous) {
        if (previous.model !== privateVersionModel || previous.recordId !== input.id || previous.actorId !== current.actor.id) throw new PrivateVersionError('DENIED');
        await current.finish(); return { status: previous.operation === 'CLOSE' ? 'CLOSED' as const : 'RECORDED' as const };
      }
      if (!input.close) { await current.finish(); return { status: 'UNKNOWN' as const }; }
      await journal(tx, current, { ...input, reason: 'Chiusura esplicita del tentativo di nuova versione privata' }, digest(input), 'CLOSE', null, null);
      await current.finish(); return { status: 'CLOSED' as const };
    }); } catch (error) { if (!(error instanceof SerializableConflictError) || attempt >= 2) throw error; }
  }
}
