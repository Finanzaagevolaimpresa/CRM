import type { Prisma, PrismaClient } from '@prisma/client';
import type { AuthSession } from './auth';
import type { TechnicalTargetReference } from './technical-assignment-display';
import { technicalUploadRecord, readTechnicalUploadRecord, type TechnicalUploadRecord } from './technical-upload-record';
import { loadTechnicalAssignmentDecisionJournal } from './technical-assignment-storage';
import { TechnicalAssignmentError, technicalAssignmentClock, withTechnicalAssignmentRecipient,
  type TechnicalAssignmentTransaction } from './technical-assignment-transaction';

type Tx = Prisma.TransactionClient;
type RawRow = Omit<TechnicalUploadRecord, 'target' | 'createdAt'> & {
  targetKind: string; targetId: string; createdAt: Date;
};
function unavailable(): never { throw new TechnicalAssignmentError('UNAVAILABLE'); }

/** The ORM callback result is not proof that a deferred COMMIT check passed.
 * Flush the complete submission after all callback writes, while errors still
 * propagate through the transaction callback. No receipt escapes on failure. */
export function withTechnicalUploadDecision<T>(db: PrismaClient, claimed: AuthSession,
  kind: TechnicalTargetReference['kind'], work: (tx: Tx, state: TechnicalAssignmentTransaction) => Promise<T>) {
  return withTechnicalAssignmentRecipient(db, claimed, kind, async (tx, state) => {
    const result = await work(tx, state);
    await tx.$executeRaw`SET CONSTRAINTS technical_upload_atomic IMMEDIATE`;
    return result;
  });
}

/** Internal preparation against the isolated SQL draft only. No runtime route
 * imports this module. Current caller must hold the assignment FOR UPDATE for
 * inserts/quota and FOR SHARE for read-only lookups after normal registry locks. */
export async function loadTechnicalUploadRecord(tx: Tx, state: Pick<TechnicalAssignmentTransaction, 'key'>, commandId: string) {
  technicalUploadRecord.shape.commandId.parse(commandId);
  const rows = await tx.$queryRaw<RawRow[]>`SELECT id,"commandId","assignmentId","assignmentRevision",
    "actorId","sessionId","targetKind","targetId","requestDigest",command,"storageKey","contentSha256",
    "sizeBytes",receipt,proof,"createdAt" FROM "TechnicalUploadSubmission" WHERE "commandId"=${commandId}::uuid FOR SHARE`;
  if (!rows.length) return null;
  if (rows.length !== 1) unavailable();
  const { targetKind, targetId, createdAt, ...row } = rows[0];
  if (!(createdAt instanceof Date) || !Number.isFinite(createdAt.getTime())) unavailable();
  const record = technicalUploadRecord.parse({ ...row, target: { kind: targetKind, targetId }, createdAt: createdAt.toISOString() });
  const revisions = await tx.$queryRaw<Array<{ commandId: string }>>`SELECT "commandId" FROM "TechnicalAssignmentRevision"
    WHERE "assignmentId"=${record.assignmentId}::uuid AND revision=${record.assignmentRevision}`;
  if (revisions.length !== 1) unavailable();
  const retained = await loadTechnicalAssignmentDecisionJournal(tx, revisions[0].commandId);
  const audit = await tx.auditLog.findUnique({ where: { id: commandId },
    select: { id: true, actorId: true, event: true, entityType: true, entityId: true, before: true, after: true } });
  const valid = readTechnicalUploadRecord(state.key, { record, audit }, retained, await technicalAssignmentClock(tx));
  if (!valid) unavailable();
  return valid;
}

/** No quota row is silently created on GET. Immutable submissions are the
 * authoritative quota, verified individually instead of trusting an aggregate
 * with missing or foreign audit. A private proposal remains outside Document. */
export async function readTechnicalUploadQuota(tx: Tx, state: TechnicalAssignmentTransaction,
  assignmentId: string, revision: number) {
  technicalUploadRecord.shape.assignmentId.parse(assignmentId);
  technicalUploadRecord.shape.assignmentRevision.parse(revision);
  const refs = await tx.$queryRaw<Array<{ commandId: string }>>`SELECT "commandId" FROM "TechnicalUploadSubmission"
    WHERE "assignmentId"=${assignmentId}::uuid AND "assignmentRevision"=${revision} ORDER BY id LIMIT 21`;
  if (refs.length > 20) unavailable();
  let bytes = 0;
  for (const ref of refs) {
    const value = await loadTechnicalUploadRecord(tx, state, ref.commandId);
    if (!value || value.record.assignmentId !== assignmentId || value.record.assignmentRevision !== revision) unavailable();
    bytes += value.record.sizeBytes;
  }
  return { assignmentId, revision, files: refs.length, bytes };
}

export async function persistTechnicalUploadRecord(tx: Tx, state: TechnicalAssignmentTransaction,
  proposed: NonNullable<ReturnType<typeof readTechnicalUploadRecord>>) {
  const r = technicalUploadRecord.parse(proposed.record);
  if (r.actorId !== state.current.userId || r.sessionId !== state.current.sessionId
    || r.receipt.keyVersion !== state.key.version) unavailable();
  await tx.$executeRaw`INSERT INTO "TechnicalUploadSubmission" (id,"commandId","assignmentId","assignmentRevision",
    "actorId","sessionId","targetKind","targetId","requestDigest",command,"storageKey","contentSha256",
    "sizeBytes",receipt,proof,"createdAt") VALUES (${r.id}::uuid,${r.commandId}::uuid,${r.assignmentId}::uuid,
    ${r.assignmentRevision},${r.actorId},${r.sessionId}::uuid,${r.target.kind},${r.target.targetId},${r.requestDigest},
    ${JSON.stringify(r.command)}::jsonb,${r.storageKey},${r.contentSha256},${r.sizeBytes},${JSON.stringify(r.receipt)}::jsonb,
    ${r.proof},${new Date(r.createdAt)})`;
  await tx.auditLog.create({ data: { ...proposed.audit, createdAt: new Date(r.createdAt) } });
  const saved = await loadTechnicalUploadRecord(tx, state, r.commandId);
  if (!saved) unavailable();
  return saved.record.receipt;
}
