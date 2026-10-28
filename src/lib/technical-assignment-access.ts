import { lockAuthorizedTechnicalAssignment } from './technical-assignment-admission';
import { selectedDocumentMode } from './selected-document-formats';
import { selectedDocumentResponseMime } from './selected-document-content';
export { lockAuthorizedTechnicalAssignment } from './technical-assignment-admission';
import { listTechnicalWorkItemsInTransaction } from './technical-work-item-service';
import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { AuthSession } from './auth';
import { maxClientDocumentBytes } from './selective-client-document-policy';
import { assertTechnicalAssignmentDocuments } from './technical-assignment-documents';
import { technicalFieldPreview, technicalTargetReference, type TechnicalTargetReference } from './technical-assignment-display';
import { readTechnicalAssignmentJournal } from './technical-assignment-journal';
import { admitsTechnicalRolePermission } from './technical-assignment-permissions';
import { projectTechnicalFields } from './technical-assignment-projection';
import { technicalAssignmentTargetFields, technicalWorkTargetDigest } from './technical-assignment-target';
import { TechnicalAssignmentError, technicalAssignmentClock, withTechnicalAssignmentRecipient,
  type TechnicalAssignmentTransaction } from './technical-assignment-transaction';

function deny(): never { throw new TechnicalAssignmentError('DENIED'); }
type Tx = Prisma.TransactionClient;

async function projection(tx: Tx, state: TechnicalAssignmentTransaction, target: TechnicalTargetReference) {
  const found = await lockAuthorizedTechnicalAssignment(tx, state, target);
  const row = await technicalAssignmentTargetFields(tx, target), now = await technicalAssignmentClock(tx);
  const projected = projectTechnicalFields(found.current, found.payload.selection, target, row, now);
  if (!projected) deny();
  const documents = await assertTechnicalAssignmentDocuments(tx, state, found.context, found.payload.selection.documents);
  const workItems = await listTechnicalWorkItemsInTransaction(tx, state, target);
  if (!readTechnicalAssignmentJournal(found.journal, state.key, found.current, await technicalAssignmentClock(tx))) deny();
  return { target, assignmentId: found.payload.id, assignmentRevision: found.payload.revision,
    contextSha256: found.context.contextSha256, targetSha256: technicalWorkTargetDigest(target, row.updatedAt),
    responsibility: found.payload.selection.responsibility, expiresAt: found.payload.selection.expiresAt,
    fields: technicalFieldPreview(target.kind, found.payload.selection.readableFields, projected.fields),
    editableFields: found.payload.selection.editableFields,
    actions: found.payload.selection.actions.filter(action => admitsTechnicalRolePermission(state.current, target.kind, action)),
    documents: documents.metadata, workItems };
}

export async function readTechnicalWork(db: PrismaClient, claimed: AuthSession, raw: TechnicalTargetReference) {
  const target = technicalTargetReference.parse(raw);
  return withTechnicalAssignmentRecipient(db, claimed, target.kind, (tx, state) => projection(tx, state, target));
}

/** Complete admitted set for shared operational views. It must be called inside
 * the existing recipient transaction. The result contains only projected fields;
 * omitted title/status cannot influence counters, filters or pagination. */
export async function technicalWorkCatalogueInTransaction(tx: Tx, state: TechnicalAssignmentTransaction,
  kind: TechnicalTargetReference['kind']) {
  const rows = await tx.$queryRaw<Array<{ targetId: string }>>`SELECT COALESCE("projectId","practiceId") AS "targetId"
    FROM "TechnicalAssignment" WHERE "recipientId"=${state.current.userId} AND kind=${kind}
    ORDER BY id LIMIT 6001`;
  if (rows.length > 6000) throw new TechnicalAssignmentError('UNAVAILABLE');
  const records = [];
  let validUntil = Infinity;
  for (const row of rows) {
    try {
      const item = await projection(tx, state, { kind, targetId: row.targetId });
      validUntil = Math.min(validUntil, new Date(item.expiresAt).getTime());
      records.push({ target: item.target, fields: item.fields,
        responsibility: item.responsibility, expiresAt: item.expiresAt });
    } catch (error) {
      if (!(error instanceof TechnicalAssignmentError && ['DENIED', 'STALE'].includes(error.code))
        && !(error instanceof Error && ['SELECTIVE_CLIENT_DOCUMENT_UNAVAILABLE', 'SELECTIVE_PRACTICE_DOCUMENT_UNAVAILABLE'].includes(error.message))) throw error;
    }
  }
  if (validUntil <= (await technicalAssignmentClock(tx)).getTime()) deny();
  return records;
}

export async function listTechnicalWork(db: PrismaClient, claimed: AuthSession, kind: TechnicalTargetReference['kind'], page = 1, query = '') {
  z.enum(['Project', 'TechnicalPractice']).parse(kind);
  const term = z.string().trim().max(200).parse(query).toLocaleLowerCase('it-IT');
  const skip = (z.number().int().min(1).max(200).parse(page) - 1) * 20;
  return withTechnicalAssignmentRecipient(db, claimed, kind, async (tx, state) => {
    // Bound the recipient's complete candidate set independently of the query.
    // A title or a raw row count must never decide an offset or continuation.
    const rows = await tx.$queryRaw<Array<{ targetId: string }>>`SELECT COALESCE("projectId","practiceId") AS "targetId"
        FROM "TechnicalAssignment" WHERE "recipientId"=${state.current.userId} AND kind=${kind}
        ORDER BY "createdAt" DESC,id LIMIT 6001`;
    if (rows.length > 6000) throw new TechnicalAssignmentError('UNAVAILABLE');
    const records = [];
    let matched = 0, validUntil = Infinity;
    for (const row of rows) {
      try {
        const item = await projection(tx, state, { kind, targetId: row.targetId });
        const title = item.fields.find(field => field.key === 'title')?.value;
        if (term && (!title || !title.toLocaleLowerCase('it-IT').includes(term))) continue;
        validUntil = Math.min(validUntil, new Date(item.expiresAt).getTime());
        if (matched++ < skip) continue;
        records.push({ target: item.target, title: title ?? 'Incarico tecnico',
          responsibility: item.responsibility, expiresAt: item.expiresAt });
        // The extra row has passed the same admission as every displayed row.
        if (records.length === 21) break;
      } catch (error) {
        if (!(error instanceof TechnicalAssignmentError && ['DENIED', 'STALE'].includes(error.code))
          && !(error instanceof Error && ['SELECTIVE_CLIENT_DOCUMENT_UNAVAILABLE', 'SELECTIVE_PRACTICE_DOCUMENT_UNAVAILABLE'].includes(error.message))) throw error;
      }
    }
    // Earlier matches also determine the admitted offset. Do not publish stale
    // rows or pagination if any of those grants expired during the scan.
    if (validUntil <= (await technicalAssignmentClock(tx)).getTime()) deny();
    return { records: records.slice(0, 20), hasNext: records.length > 20 };
  });
}

/** Buffer the bounded exact version inside the admitted transaction, verify its
 * checksum, then recheck expiry/session before returning bytes. GET does not
 * create grants, acknowledgements or audit mutations. */
export async function readTechnicalWorkDocument(db: PrismaClient, claimed: AuthSession, raw: TechnicalTargetReference,
  fileId: string, download: boolean, readBytes: (path: string, limit: number) => Promise<Buffer>) {
  const target = technicalTargetReference.parse(raw);
  z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/).parse(fileId);
  return withTechnicalAssignmentRecipient(db, claimed, target.kind, async (tx, state) => {
    const found = await lockAuthorizedTechnicalAssignment(tx, state, target);
    const selected = found.payload.selection.documents.find(row => row.fileId === fileId);
    if (!selected || (download && !selected.allowDownload)) deny();
    const snapshot = await assertTechnicalAssignmentDocuments(tx, state, found.context, [selected]);
    const document = snapshot.metadata[0], path = snapshot.paths.get(fileId);
    if (!document || !path || (!download && selectedDocumentMode(document) !== 'preview')) deny();
    const bytes = await readBytes(path, maxClientDocumentBytes);
    if (!bytes.length || bytes.length > maxClientDocumentBytes || createHash('sha256').update(bytes).digest('hex') !== selected.contentSha256) deny();
    const contentType = selectedDocumentResponseMime(document, bytes, download);
    await assertTechnicalAssignmentDocuments(tx, state, found.context, [selected]);
    if (!readTechnicalAssignmentJournal(found.journal, state.key, found.current, await technicalAssignmentClock(tx))) deny();
    return { bytes, document, contentType };
  });
}
