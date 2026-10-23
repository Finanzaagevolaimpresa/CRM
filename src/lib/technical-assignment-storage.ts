import { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { PrivilegedStepUpKey } from './privileged-step-up-token';
import type { CurrentTechnicalAssignmentProof } from './technical-assignment-proof';
import { readRetainedTechnicalAssignmentJournal, readTechnicalAssignmentJournal } from './technical-assignment-journal';
import type { PreparedTechnicalAssignmentDecision } from './technical-assignment-decision';
import { canonicalSha256 } from './canonical-json';
import { decodeTechnicalAssignmentRecord, type StoredTechnicalAssignment } from './technical-assignment-record';
import { TechnicalAssignmentError, technicalAssignmentClock, type TechnicalAssignmentTransaction } from './technical-assignment-transaction';

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
export async function loadTechnicalAssignmentJournal(tx: Tx, record: StoredTechnicalAssignment) {
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
  const journal = await loadTechnicalAssignmentJournal(tx, record);
  return journal ? readTechnicalAssignmentJournal(journal, key, current, now) : null;
}

/** Historical command lookup for lost-response reconciliation. The revision,
 * rather than the mutable current assignment, supplies its original outcome.
 * Fresh management admission and the signed actor/session/request linkage are
 * still required before exposing even a minimized receipt. */
export async function loadTechnicalAssignmentDecisionJournal(tx: Tx, commandId: string) {
  z.string().uuid().parse(commandId);
  const decisions = await tx.$queryRaw<DecisionRow[]>`
    SELECT id,"actorId","sessionId",kind,"targetId","recipientId","expectedRevision",
      operation,"requestDigest",receipt,"receiptProof","transactionId"
    FROM "TechnicalAssignmentDecision" WHERE id=${commandId}::uuid FOR SHARE`;
  if (!decisions.length) return null;
  const revisions = await tx.$queryRaw<RevisionRow[]>`
    SELECT id,"assignmentId",revision,"commandId",payload,proof,"revokedAt","transactionId"
    FROM "TechnicalAssignmentRevision" WHERE "commandId"=${commandId}::uuid FOR SHARE`;
  if (decisions.length !== 1 || revisions.length !== 1) unavailable();
  const revision = revisions[0];
  if (revision.revokedAt !== null && (!(revision.revokedAt instanceof Date)
    || !Number.isFinite(revision.revokedAt.getTime()))) unavailable();
  const audit = await tx.auditLog.findUnique({ where: { id: revision.id }, select: {
    id: true, actorId: true, event: true, entityType: true, entityId: true, before: true, after: true } });
  if (!audit) unavailable();
  const revokedAt = revision.revokedAt?.toISOString() ?? null;
  return { assignment: { payload: revision.payload, proof: revision.proof, revokedAt },
    decision: decisions[0], revision: { ...revision, revokedAt }, audit };
}

/** Internal persistence only, under withTechnicalAssignmentDecision. No route
 * calls this yet. Never retries with a fresh command or overwrites a conflict.
 * A DB trigger requires the assignment, immutable decision/revision and exact
 * minimized AuditLog to have been inserted in this same transaction. */
export async function persistTechnicalAssignmentDecision(tx: Tx, state: TechnicalAssignmentTransaction,
  change: PreparedTechnicalAssignmentDecision, expectedStateSha256: string | null) {
  const { assignment: a, decision: d, revision: h, audit } = change;
  if (d.actorId !== state.current.userId || d.sessionId !== state.current.sessionId
    || d.actorId !== state.authority.userId || d.recipientId !== state.recipient?.id
    || a.payload.authorityRevision !== state.authority.revision || a.payload.keyVersion !== state.key.version) unavailable();
  const reference = { kind: d.kind, targetId: d.targetId, recipientId: d.recipientId };
  const previous = await lockTechnicalAssignmentRecord(tx, reference, 'decision');
  if ((previous?.stateSha256 ?? null) !== expectedStateSha256 || (previous?.revision ?? 0) !== d.expectedRevision
    || (previous && previous.id !== a.payload.id)) throw new TechnicalAssignmentError('STALE');
  const now = await technicalAssignmentClock(tx);
  const revokedAt = a.revokedAt === null ? null : new Date(a.revokedAt);
  await tx.$executeRaw`INSERT INTO "TechnicalAssignmentDecision"
    (id,"actorId","sessionId",kind,"targetId","recipientId","expectedRevision",operation,"requestDigest",receipt,"receiptProof")
    VALUES (${d.id}::uuid,${d.actorId},${d.sessionId}::uuid,${d.kind},${d.targetId},${d.recipientId},${d.expectedRevision},
      ${d.operation},${d.requestDigest},${JSON.stringify(d.receipt)}::jsonb,${d.receiptProof})`;
  const changed = previous ? await tx.$executeRaw`UPDATE "TechnicalAssignment"
    SET revision=${a.payload.revision},payload=${JSON.stringify(a.payload)}::jsonb,proof=${a.proof},
      "revokedAt"=${revokedAt},"updatedAt"=${now}
    WHERE id=${a.payload.id}::uuid AND revision=${d.expectedRevision}`
    : await tx.$executeRaw`INSERT INTO "TechnicalAssignment"
      (id,kind,"projectId","practiceId","recipientId",revision,payload,proof,"revokedAt","createdAt","updatedAt")
      VALUES (${a.payload.id}::uuid,${d.kind},${d.kind === 'Project' ? d.targetId : null},
        ${d.kind === 'TechnicalPractice' ? d.targetId : null},${d.recipientId},${a.payload.revision},
        ${JSON.stringify(a.payload)}::jsonb,${a.proof},${revokedAt},${now},${now})`;
  if (changed !== 1) throw new TechnicalAssignmentError('STALE');
  await tx.$executeRaw`INSERT INTO "TechnicalAssignmentRevision"
    (id,"assignmentId",revision,"commandId",payload,proof,"revokedAt")
    VALUES (${h.id}::uuid,${h.assignmentId}::uuid,${h.revision},${h.commandId}::uuid,
      ${JSON.stringify(h.payload)}::jsonb,${h.proof},${revokedAt})`;
  await tx.auditLog.create({ data: { ...audit, createdAt: now } });
  const stored = await lockTechnicalAssignmentRecord(tx, reference, 'decision');
  if (!stored || canonicalSha256({ payload: stored.payload, proof: stored.proof, revokedAt: stored.revokedAt })
      !== canonicalSha256(a)) return unavailable();
  const journal = await loadTechnicalAssignmentJournal(tx, stored);
  const verified = readRetainedTechnicalAssignmentJournal(journal, state.key, await technicalAssignmentClock(tx));
  if (!verified || canonicalSha256(verified.decision.receipt) !== canonicalSha256(d.receipt)) return unavailable();
  return verified.decision.receipt;
}
