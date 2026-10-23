import { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { PrivilegedStepUpKey } from './privileged-step-up-token';
import type { CurrentTechnicalAssignmentProof } from './technical-assignment-proof';
import { readTechnicalAssignmentJournal } from './technical-assignment-journal';
import { decodeTechnicalAssignmentRecord, type StoredTechnicalAssignment } from './technical-assignment-record';
import { TechnicalAssignmentError } from './technical-assignment-transaction';

type Tx = Prisma.TransactionClient;
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const lookupSchema = z.object({ kind: z.enum(['Project', 'TechnicalPractice']), targetId: id, recipientId: id }).strict();
type Lookup = z.infer<typeof lookupSchema>;
const unavailable = (): never => { throw new TechnicalAssignmentError('UNAVAILABLE'); };

/** Persistence preparation only: no route is connected. Call inside the existing
 * serializable assignment transaction, after directory, sorted-user/session and
 * canonical parent/target locks. The recipient lock also serializes creation
 * when no assignment row exists. Reading never creates or repairs a grant. */
export async function lockTechnicalAssignmentRecord(tx: Tx, requested: Lookup, intent: 'read' | 'decision') {
  const target = lookupSchema.parse(requested);
  if (intent !== 'read' && intent !== 'decision') unavailable();
  const column = target.kind === 'Project' ? '"projectId"' : '"practiceId"';
  const rows = await tx.$queryRaw<unknown[]>(Prisma.sql`
    SELECT id,kind,"projectId","practiceId","recipientId",revision,payload,proof,"revokedAt"
    FROM "TechnicalAssignment" WHERE kind=${target.kind}
      AND ${Prisma.raw(column)}=${target.targetId} AND "recipientId"=${target.recipientId}
    ${Prisma.raw(intent === 'decision' ? 'FOR UPDATE' : 'FOR SHARE')}`);
  if (!rows.length) return null;
  if (rows.length !== 1) unavailable();
  const record = decodeTechnicalAssignmentRecord(rows[0]);
  if (!record || record.kind !== target.kind || record.targetId !== target.targetId
    || record.recipientId !== target.recipientId) unavailable();
  return record;
}

type DecisionRow = { id: string; actorId: string; sessionId: string; kind: string;
  targetId: string; recipientId: string; expectedRevision: number; operation: string;
  requestDigest: string; receipt: unknown; receiptProof: string; transactionId: bigint };
type RevisionRow = { id: string; assignmentId: string; revision: number; commandId: string;
  payload: unknown; proof: string; revokedAt: Date | null; transactionId: bigint };

/** The assignment is already locked. Decision and revision are immutable by the
 * draft DB constraints; their exact linkage and minimized audit are checked by
 * the journal verifier. A partial or foreign history yields no readable grant. */
async function loadJournal(tx: Tx, record: StoredTechnicalAssignment) {
  const decisions = await tx.$queryRaw<DecisionRow[]>`
    SELECT id,"actorId","sessionId",kind,"targetId","recipientId","expectedRevision",
      operation,"requestDigest",receipt,"receiptProof","transactionId"
    FROM "TechnicalAssignmentDecision" WHERE id=${record.payload.commandId}::uuid`;
  const revisions = await tx.$queryRaw<RevisionRow[]>`
    SELECT id,"assignmentId",revision,"commandId",payload,proof,"revokedAt","transactionId"
    FROM "TechnicalAssignmentRevision" WHERE "assignmentId"=${record.id}::uuid AND revision=${record.revision}`;
  if (decisions.length !== 1 || revisions.length !== 1) return null;
  const decision = decisions[0], revision = revisions[0];
  if (revision.revokedAt !== null && (!(revision.revokedAt instanceof Date)
    || !Number.isFinite(revision.revokedAt.getTime()))) return null;
  const audit = await tx.auditLog.findUnique({ where: { id: revision.id },
    select: { id: true, actorId: true, event: true, entityType: true, entityId: true, before: true, after: true } });
  if (!audit) return null;
  return { assignment: { payload: record.payload, proof: record.proof, revokedAt: record.revokedAt },
    decision, revision: { ...revision, revokedAt: revision.revokedAt?.toISOString() ?? null }, audit };
}

/** Current facts are constructed under withTechnicalAssignmentRecipient, never
 * from a form or cached session. Canonical documents still require their own
 * fresh checks before projecting metadata or reading bytes. No fallback to a
 * legacy owner or read-sharing grant occurs on missing/invalid history. */
export async function readStoredTechnicalAssignment(tx: Tx, requested: Lookup, key: PrivilegedStepUpKey,
  current: CurrentTechnicalAssignmentProof, now: Date) {
  const record = await lockTechnicalAssignmentRecord(tx, requested, 'read');
  if (!record || record.revokedAt !== null || record.id !== current.assignmentId
    || record.revision !== current.currentRevision) return null;
  const journal = await loadJournal(tx, record);
  return journal ? readTechnicalAssignmentJournal(journal, key, current, now) : null;
}
