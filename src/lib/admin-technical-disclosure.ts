import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { AuthSession } from './auth';
import { updateActor, type UpdateCredentials } from './record-updates';
import { recordUpdatePermission } from './record-update-context';
import { readPrivateDocumentBounded } from './storage';
import { technicalDocumentPrivateVisibility } from './technical-document-visibility';
import { adminTechnicalAcquisitionHistory, acquiredVersionDocument } from './technical-document-acquired-access';
import { disclosureSnapshot, disclosureAssertions, disclosureDigest as digest, disclosureSource, hasRestrictedDocumentBinding,
  readDisclosure, restrictedDocumentMetadata, technicalDisclosureModel } from './technical-document-disclosure';
import { mapSerializableConflict, SerializableConflictError } from './serializable';
export class TechnicalDisclosureError extends Error {
  constructor(readonly code: 'DENIED' | 'STALE' | 'CLOSED' | 'INVALID') { super('TECHNICAL_DISCLOSURE_' + code); }
}
const deny = (): never => { throw new TechnicalDisclosureError('DENIED'); };
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
export const technicalDisclosureCommand = z.object({
  commandId: z.string().uuid(), id, expectedVersion: z.string().regex(/^[a-f0-9]{64}$/),
  expectedSource: z.string().regex(/^[a-f0-9]{64}$/),
  classification: z.enum(['RESTRICTED', 'TECHNICAL_CONTENT']),
  assertions: disclosureAssertions, reason: z.string().trim().min(3).max(2000), confirmed: z.literal(true),
}).strict();
type Tx = Prisma.TransactionClient;
type Authority = Awaited<ReturnType<typeof updateActor>>;
async function transaction<T>(db: PrismaClient, work: (tx: Tx) => Promise<T>) {
  try { return await db.$transaction(async tx => {
    const value = await work(tx); await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`; return value;
  }, { isolationLevel: 'Serializable', maxWait: 10000, timeout: 30000 }); }
  catch (error) { throw mapSerializableConflict(error); }
}
async function authority(tx: Tx, session: AuthSession, proof?: UpdateCredentials) {
  const current = await updateActor(tx, session, proof);
  if (current.actor.role !== 'admin' || !recordUpdatePermission(current.actor, 'document.download')
    || proof && !recordUpdatePermission(current.actor, 'document.upload')) deny();
  return current;
}
async function source(tx: Tx, current: Authority, versionId: string, write = false) {
  const identity = await tx.documentVersion.findUnique({ where: { id: versionId }, select: { documentId: true } });
  if (!identity) return deny();
  await tx.$queryRaw(Prisma.sql`SELECT id FROM "Document" WHERE id=${identity.documentId} ${write ? Prisma.sql`FOR UPDATE` : Prisma.sql`FOR SHARE`}`);
  await tx.$queryRaw`SELECT id FROM "DocumentVersion" WHERE id=${versionId} FOR SHARE`;
  const original = await tx.document.findUnique({ where: { id: identity.documentId } });
  const version = await tx.documentVersion.findUnique({ where: { id: versionId } });
  if (!original || !version || version.documentId !== original.id || original.deletedAt || !version.checksum) return deny();
  const saved = original.visibilityLevel === technicalDocumentPrivateVisibility
    ? await adminTechnicalAcquisitionHistory(tx, current.actor.id, original) : null;
  const document = saved ? acquiredVersionDocument(saved, versionId) : original;
  if (!document || document.containsSensitiveData && !recordUpdatePermission(current.actor, 'document.sensitive.read')) return deny();
  const profile = await readDisclosure(tx, versionId, write);
  const prohibited = restrictedDocumentMetadata(original) || restrictedDocumentMetadata(document)
    || await hasRestrictedDocumentBinding(tx, document.id);
  return { document, version, profile, sourceSha256: disclosureSource(document, version), prohibited };
}
async function journal(tx: Tx, current: Authority, input: { commandId: string; id: string; reason: string }, requestHash: string,
  operation: 'UPDATE' | 'CLOSE', before: unknown, after: unknown) {
  const beforeHash = digest(before), afterHash = digest(after), plain = (v: unknown) => v === null ? Prisma.JsonNull : JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
  await tx.adminRecordRevision.create({ data: { commandId: input.commandId, model: technicalDisclosureModel, recordId: input.id,
    actorId: current.actor.id, sessionId: current.registry.id, operation, requestHash, beforeHash, afterHash,
    before: plain(before), after: plain(after), reason: input.reason } });
  await tx.auditLog.create({ data: { id: 'admin-record:' + input.commandId, actorId: current.actor.id, entityType: technicalDisclosureModel,
    entityId: input.id, event: operation === 'CLOSE' ? 'admin_record_attempt_closed' : 'admin_record_changed',
    after: operation === 'CLOSE' ? { commandId: input.commandId }
      : { commandId: input.commandId, action: operation, beforeHash, afterHash, changedPaths: ['technicalDisclosure'], grantsChanged: false } } });
}
export async function readAdminTechnicalDisclosure(db: PrismaClient, session: AuthSession, versionId: string) {
  id.parse(versionId);
  return transaction(db, async tx => {
    const current = await authority(tx, session), s = await source(tx, current, versionId); await current.finish();
    return { id: versionId, documentId: s.document.id, title: s.document.title, fileName: s.document.fileName,
      documentVersion: s.version.version, contentSha256: s.version.checksum!, sourceSha256: s.sourceSha256,
      prohibited: s.prohibited, version: s.profile.version, current: s.profile.current,
      history: s.profile.history.slice(-50).reverse(), canWrite: recordUpdatePermission(current.actor, 'document.upload'),
      private: s.document.visibilityLevel === technicalDocumentPrivateVisibility };
  });
}
export async function saveAdminTechnicalDisclosure(db: PrismaClient, session: AuthSession, raw: unknown, proof: UpdateCredentials) {
  const input = technicalDisclosureCommand.parse(raw), requestHash = digest({ protocol: 'ADMIN_TECHNICAL_DISCLOSURE_V1', input });
  return transaction(db, async tx => {
    const current = await authority(tx, session, proof);
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'admin-record:' + input.commandId},0))::text`;
    const previous = await tx.adminRecordRevision.findUnique({ where: { commandId: input.commandId } });
    if (previous) {
      if (previous.model !== technicalDisclosureModel || previous.recordId !== input.id || previous.actorId !== current.actor.id) return deny();
      if (previous.operation === 'CLOSE') throw new TechnicalDisclosureError('CLOSED');
      if (previous.requestHash !== requestHash) throw new TechnicalDisclosureError('STALE');
      await source(tx, current, input.id); await current.finish(); return { replayed: true };
    }
    const s = await source(tx, current, input.id, true);
    if (s.profile.version !== input.expectedVersion || s.sourceSha256 !== input.expectedSource) throw new TechnicalDisclosureError('STALE');
    if (input.classification === 'TECHNICAL_CONTENT' && (s.prohibited || !input.assertions)) return deny();
    const bytes = await readPrivateDocumentBounded(s.version.storagePath, 25 * 1024 * 1024);
    if (!bytes.length || createHash('sha256').update(bytes).digest('hex') !== s.version.checksum) return deny();
    const after = disclosureSnapshot.parse({ id: input.id, revision: s.profile.current.revision + 1,
      classification: input.classification, sourceSha256: s.sourceSha256, contentSha256: s.version.checksum,
      assertions: input.classification === 'TECHNICAL_CONTENT' ? input.assertions : null });
    await journal(tx, current, input, requestHash, 'UPDATE', s.profile.current, after);
    await current.finish(); return { replayed: false };
  });
}
export async function reconcileAdminTechnicalDisclosure(db: PrismaClient, session: AuthSession, raw: unknown) {
  const input = z.object({ commandId: z.string().uuid(), id, close: z.boolean() }).strict().parse(raw);
  for (let attempt = 0; ; attempt++) {
    try { return await transaction(db, async tx => {
      const current = await authority(tx, session);
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'admin-record:' + input.commandId},0))::text`;
      await source(tx, current, input.id);
      const row = await tx.adminRecordRevision.findUnique({ where: { commandId: input.commandId } });
      if (row) {
        if (row.model !== technicalDisclosureModel || row.recordId !== input.id || row.actorId !== current.actor.id) return deny();
        await current.finish(); return { status: row.operation === 'CLOSE' ? 'CLOSED' as const : 'RECORDED' as const };
      }
      if (!input.close) { await current.finish(); return { status: 'UNKNOWN' as const }; }
      await journal(tx, current, { ...input, reason: 'Chiusura di una classificazione senza esito registrato' },
        digest({ protocol: 'ADMIN_TECHNICAL_DISCLOSURE_CLOSE_V1', input }), 'CLOSE', null, null);
      await current.finish(); return { status: 'CLOSED' as const };
    }); } catch (error) { if (!(error instanceof SerializableConflictError) || attempt >= 2) throw error; }
  }
}
