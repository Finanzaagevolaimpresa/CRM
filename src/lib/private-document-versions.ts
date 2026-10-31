import type { Prisma, DocumentVersion } from '@prisma/client';
import { z } from 'zod';
import { canonicalSha256 } from './canonical-json';
import { documentUploadMaxBytes } from './document-upload-contract';
import { selectedDocumentMimeTypes, selectedDocumentMode } from './selected-document-formats';
export const privateVersionModel = 'AdminPrivateDocumentVersion';
export class PrivateVersionError extends Error {
  constructor(readonly code: 'DENIED' | 'INVALID' | 'STALE' | 'CLOSED' | 'INTEGRITY') { super('ADMIN_PRIVATE_VERSION_' + code); }
}
const id = z.string().min(1).max(128), sha = z.string().regex(/^[a-f0-9]{64}$/);
export const privateVersionState = z.object({ id, sourceAcquisitionCommandId: z.string().uuid(), versionCount: z.number().int().positive(), latestVersionId: id }).strict();
export const privateVersionFile = z.object({ fileName: z.string().min(1).max(255).refine(v => !/[\\/\u0000-\u001f\u007f]/.test(v) && !v.includes('..')), mimeType: z.enum(selectedDocumentMimeTypes),
  sizeBytes: z.number().int().min(1).max(documentUploadMaxBytes), sha256: sha }).strict();
export const privateVersionSnapshot = privateVersionState.extend({
  version: z.object({ id, documentId: id, version: z.number().int().min(2), storagePath: z.string().min(1).max(1000), checksum: sha,
    createdAt: z.string().datetime() }).strict(), file: privateVersionFile,
}).strict();
export const privateVersionDigest = (v: unknown) => canonicalSha256(JSON.parse(JSON.stringify(v)));
export function originalPrivateVersionState(documentId: string, acquisitionId: string, version: DocumentVersion) {
  return { id: documentId, sourceAcquisitionCommandId: acquisitionId, versionCount: 1, latestVersionId: version.id };
}
export async function readPrivateDocumentVersions(tx: Prisma.TransactionClient, documentId: string, acquisitionId: string,
  original: DocumentVersion, versions: DocumentVersion[], originalActorId: string) {
  const rows = await tx.adminRecordRevision.findMany({ where: { model: privateVersionModel, recordId: documentId, operation: { not: 'CLOSE' } } });
  const parsed = rows.map(row => ({ row, before: privateVersionState.parse(row.before), after: privateVersionSnapshot.parse(row.after) }))
    .sort((a, b) => a.after.versionCount - b.after.versionCount);
  let current = originalPrivateVersionState(documentId, acquisitionId, original);
  let previousCreatedAt = original.createdAt;
  if (versions.length !== rows.length + 1) throw new PrivateVersionError('INTEGRITY');
  const additions = [];
  for (const { row, before, after } of parsed) {
    const actual = versions.find(v => v.id === after.version.id);
    if (row.operation !== 'UPDATE' || row.actorId !== originalActorId || privateVersionDigest(before) !== row.beforeHash || privateVersionDigest(after) !== row.afterHash
      || privateVersionDigest(before) !== privateVersionDigest(current) || after.id !== documentId || after.sourceAcquisitionCommandId !== acquisitionId
      || after.versionCount !== current.versionCount + 1 || after.version.version !== after.versionCount || after.latestVersionId !== after.version.id
      || after.version.documentId !== documentId || after.file.sha256 !== after.version.checksum || !actual
      || privateVersionDigest(actual) !== privateVersionDigest(after.version) || !selectedDocumentMode(after.file)
      || actual.createdAt < previousCreatedAt || actual.createdAt > row.createdAt) throw new PrivateVersionError('INTEGRITY');
    current = { id: documentId, sourceAcquisitionCommandId: acquisitionId, versionCount: after.versionCount, latestVersionId: after.latestVersionId };
    previousCreatedAt = actual.createdAt;
    additions.push({ commandId: row.commandId, actorId: row.actorId, reason: row.reason, at: row.createdAt.toISOString(),
      version: actual, file: after.file });
  }
  return { current, additions };
}
