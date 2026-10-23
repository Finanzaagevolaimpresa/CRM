import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { AuthSession } from './auth';
import { hasSelectiveClientContext } from './selective-client-policy';
import { hasSelectiveContext } from './selective-project-policy';
import { isSelectivePractice } from './selective-practice-policy';
import { maxClientDocumentBytes } from './selective-client-document-policy';
import { lockTechnicalAssignmentContext } from './technical-assignment-context';
import { assertTechnicalAssignmentDocuments } from './technical-assignment-documents';
import { technicalFieldPreview, technicalTargetReference, type TechnicalTargetReference } from './technical-assignment-display';
import { readTechnicalAssignmentJournal } from './technical-assignment-journal';
import { admitsTechnicalAssignmentManager, admitsTechnicalRolePermission } from './technical-assignment-permissions';
import { projectTechnicalFields } from './technical-assignment-projection';
import type { CurrentTechnicalAssignmentProof } from './technical-assignment-proof';
import { loadTechnicalAssignmentJournal, lockTechnicalAssignmentRecord } from './technical-assignment-storage';
import { technicalAssignmentTargetFields, technicalWorkTargetDigest } from './technical-assignment-target';
import { TechnicalAssignmentError, technicalAssignmentClock, withTechnicalAssignmentRecipient,
  type TechnicalAssignmentTransaction } from './technical-assignment-transaction';
import { technicalImplementedActions } from './technical-assignment-contract';

function deny(): never { throw new TechnicalAssignmentError('DENIED'); }
type Tx = Prisma.TransactionClient;

/** This is the only recipient admission to the new operational path. No legacy
 * ownership/client relationship or unverified JSON can substitute for the full
 * immutable decision journal and current personal authority. */
export async function lockAuthorizedTechnicalAssignment(tx: Tx, state: TechnicalAssignmentTransaction,
  target: TechnicalTargetReference, write = false) {
  const context = await lockTechnicalAssignmentContext(tx, target, { writeTarget: write });
  if (!context || !state.recipient || hasSelectiveClientContext(state.current, context)
    || hasSelectiveContext(state.current, context)
    || (target.kind === 'TechnicalPractice' && isSelectivePractice(state.current, target.targetId))) deny();
  const ref = { ...target, recipientId: state.current.userId };
  const record = await lockTechnicalAssignmentRecord(tx, ref, 'read');
  if (!record) deny();
  const current: CurrentTechnicalAssignmentProof = {
    userId: state.current.userId, role: state.current.role, active: state.current.active,
    sessionLive: true, ...target, targetWorkable: context.operational, parentContextValid: true, selectiveCeilingAllows: true,
    currentContextSha256: context.contextSha256, currentRecipientEpoch: state.recipient.recordUpdateEpoch,
    currentRevision: record.revision, assignmentRevision: record.payload.revision,
    assignmentContextSha256: record.payload.contextSha256, assignmentRecipientEpoch: record.payload.recipientEpoch,
    revoked: record.revokedAt !== null, assignmentId: record.id,
    recordReadAllowed: admitsTechnicalRolePermission(state.current, target.kind),
    authority: { purpose: 'technical-assignment', userId: state.authority.userId, enabled: state.authority.enabled,
      revision: state.authority.revision, actorEpoch: state.author.recordUpdateEpoch, actorActive: state.author.active && !state.author.deletedAt,
      actorRole: state.author.role, assignmentWriteAllowed: admitsTechnicalAssignmentManager(state.author, target.kind) },
  };
  const journal = await loadTechnicalAssignmentJournal(tx, record);
  const payload = readTechnicalAssignmentJournal(journal, state.key, current, await technicalAssignmentClock(tx));
  if (!payload || payload.selection.actions.some(action => !technicalImplementedActions.some(item => item === action))) deny();
  return { context, record, journal, current, payload };
}

async function projection(tx: Tx, state: TechnicalAssignmentTransaction, target: TechnicalTargetReference) {
  const found = await lockAuthorizedTechnicalAssignment(tx, state, target);
  const row = await technicalAssignmentTargetFields(tx, target), now = await technicalAssignmentClock(tx);
  const projected = projectTechnicalFields(found.current, found.payload.selection, target, row, now);
  if (!projected) deny();
  const documents = await assertTechnicalAssignmentDocuments(tx, state, found.context, found.payload.selection.documents);
  if (!readTechnicalAssignmentJournal(found.journal, state.key, found.current, await technicalAssignmentClock(tx))) deny();
  return { target, assignmentId: found.payload.id, assignmentRevision: found.payload.revision,
    contextSha256: found.context.contextSha256, targetSha256: technicalWorkTargetDigest(target, row.updatedAt),
    responsibility: found.payload.selection.responsibility, expiresAt: found.payload.selection.expiresAt,
    fields: technicalFieldPreview(target.kind, found.payload.selection.readableFields, projected.fields),
    editableFields: found.payload.selection.editableFields,
    actions: found.payload.selection.actions.filter(action => admitsTechnicalRolePermission(state.current, target.kind, action)),
    documents: documents.metadata };
}

export async function readTechnicalWork(db: PrismaClient, claimed: AuthSession, raw: TechnicalTargetReference) {
  const target = technicalTargetReference.parse(raw);
  return withTechnicalAssignmentRecipient(db, claimed, target.kind, (tx, state) => projection(tx, state, target));
}

export async function listTechnicalWork(db: PrismaClient, claimed: AuthSession, kind: TechnicalTargetReference['kind'], page = 1, query = '') {
  z.enum(['Project', 'TechnicalPractice']).parse(kind);
  const term = z.string().trim().max(200).parse(query).toLocaleLowerCase('it-IT');
  const skip = (z.number().int().min(1).max(200).parse(page) - 1) * 20;
  return withTechnicalAssignmentRecipient(db, claimed, kind, async (tx, state) => {
    const rows = term ? await tx.$queryRaw<Array<{ targetId: string }>>`
      SELECT COALESCE(a."projectId",a."practiceId") AS "targetId" FROM "TechnicalAssignment" a
      LEFT JOIN "Project" p ON p.id=a."projectId" LEFT JOIN "TechnicalPractice" t ON t.id=a."practiceId"
      WHERE a."recipientId"=${state.current.userId} AND a.kind=${kind}
      AND a.payload->'selection'->'readableFields' ? 'title' AND position(${term} IN lower(COALESCE(p.title,t.title)))>0
      ORDER BY a."createdAt" DESC,a.id OFFSET ${skip} LIMIT 21`
      : await tx.$queryRaw<Array<{ targetId: string }>>`SELECT COALESCE("projectId","practiceId") AS "targetId"
        FROM "TechnicalAssignment" WHERE "recipientId"=${state.current.userId} AND kind=${kind}
        ORDER BY "createdAt" DESC,id OFFSET ${skip} LIMIT 21`;
    const records = [];
    for (const row of rows.slice(0, 20)) {
      try {
        const item = await projection(tx, state, { kind, targetId: row.targetId });
        const title = item.fields.find(field => field.key === 'title')?.value;
        if (term && (!title || !title.toLocaleLowerCase('it-IT').includes(term))) continue;
        records.push({ target: item.target, title: title ?? 'Incarico tecnico',
          responsibility: item.responsibility, expiresAt: item.expiresAt });
      } catch (error) {
        if (!(error instanceof TechnicalAssignmentError && ['DENIED', 'STALE'].includes(error.code))
          && !(error instanceof Error && ['SELECTIVE_CLIENT_DOCUMENT_UNAVAILABLE', 'SELECTIVE_PRACTICE_DOCUMENT_UNAVAILABLE'].includes(error.message))) throw error;
      }
    }
    return { records, hasNext: rows.length > 20 };
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
    if (!document || !path) deny();
    const bytes = await readBytes(path, maxClientDocumentBytes);
    if (!bytes.length || bytes.length > maxClientDocumentBytes || createHash('sha256').update(bytes).digest('hex') !== selected.contentSha256) deny();
    await assertTechnicalAssignmentDocuments(tx, state, found.context, [selected]);
    if (!readTechnicalAssignmentJournal(found.journal, state.key, found.current, await technicalAssignmentClock(tx))) deny();
    return { bytes, document };
  });
}
