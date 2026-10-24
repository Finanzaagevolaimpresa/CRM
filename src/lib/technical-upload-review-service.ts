import type { Prisma, PrismaClient } from '@prisma/client';
import type { AuthSession } from './auth';
import { canonicalJson, canonicalSha256 } from './canonical-json';
import { technicalAssignmentReference, type TechnicalAssignmentReference } from './technical-assignment-decision';
import { lockTechnicalAssignmentContext } from './technical-assignment-context';
import { loadTechnicalAssignmentJournal, lockTechnicalAssignmentRecord } from './technical-assignment-storage';
import { readRetainedTechnicalAssignmentJournal } from './technical-assignment-journal';
import { admitsTechnicalRolePermission } from './technical-assignment-permissions';
import { loadTechnicalAssignmentIndependentScope } from './selective-project-scope';
import { hasSelectiveClientContext } from './selective-client-policy';
import { hasSelectiveContext } from './selective-project-policy';
import { isSelectivePractice } from './selective-practice-policy';
import { TechnicalAssignmentError, technicalAssignmentClock, withTechnicalAssignmentManagementRead, withTechnicalAssignmentDecision,
  type TechnicalAssignmentPersonalProof, type TechnicalAssignmentTransaction } from './technical-assignment-transaction';
import { loadTechnicalUploadRecord } from './technical-upload-persistence';
import { readTechnicalUploadPrivateFile } from './technical-upload-storage';
import { createTechnicalUploadReviewPreview, readTechnicalUploadReviewPreview, prepareTechnicalUploadReview,
  technicalUploadReviewCommand, technicalUploadReviewDigest, type TechnicalUploadReviewAdmission } from './technical-upload-review-contract';
import { loadTechnicalUploadReview, loadTechnicalUploadReviewForSubmission, persistTechnicalUploadReview } from './technical-upload-review-persistence';

type Tx = Prisma.TransactionClient;
function denied(): never { throw new TechnicalAssignmentError('DENIED'); }
function stale(): never { throw new TechnicalAssignmentError('STALE'); }
/** The personal Admin's own live session authorizes this route. No fabricated
 * technician session is used: the retained source and both current scopes are
 * independently checked under directory/user/context/assignment locks. */
async function source(tx: Tx, state: TechnicalAssignmentTransaction, ref: TechnicalAssignmentReference, write = false) {
  if (!state.recipient || !admitsTechnicalRolePermission(state.recipient, ref.kind, 'upload_document')) denied();
  const context = await lockTechnicalAssignmentContext(tx, ref);
  if (!context || !context.operational) denied();
  const scope = await loadTechnicalAssignmentIndependentScope(tx, ref.recipientId);
  for (const candidate of [state.current, scope]) {
    if (hasSelectiveClientContext(candidate, context) || hasSelectiveContext(candidate, context)
      || (ref.kind === 'TechnicalPractice' && isSelectivePractice(candidate, ref.targetId))) denied();
  }
  const record = await lockTechnicalAssignmentRecord(tx, ref, write ? 'decision' : 'read');
  if (!record || record.revokedAt) denied();
  const now = await technicalAssignmentClock(tx);
  const retained = readRetainedTechnicalAssignmentJournal(await loadTechnicalAssignmentJournal(tx, record), state.key, now);
  const p = retained?.assignment.payload;
  if (!p || retained!.assignment.revokedAt || retained!.decision.operation !== 'ASSIGN'
    || p.id !== record.id || p.revision !== record.revision || canonicalSha256(p) !== canonicalSha256(record.payload)
    || p.approvedById !== state.authority.userId || p.authorityRevision !== state.authority.revision
    || p.actorEpoch !== state.author.recordUpdateEpoch || p.recipientEpoch !== state.recipient.recordUpdateEpoch
    || p.contextSha256 !== context.contextSha256 || p.selection.kind !== ref.kind || p.targetId !== ref.targetId
    || p.selection.userId !== ref.recipientId || !p.selection.actions.includes('upload_document') || !p.selection.uploadProfile
    || Date.parse(p.selection.expiresAt) <= now.getTime() || p.keyVersion !== state.key.version) denied();
  return { record, payload: p, context };
}
async function submission(tx: Tx, state: TechnicalAssignmentTransaction, ref: TechnicalAssignmentReference, commandId: string, write = false) {
  const found = await source(tx, state, ref, write), saved = await loadTechnicalUploadRecord(tx, state, commandId);
  const r = saved?.record;
  if (!r || r.assignmentId !== found.record.id || r.assignmentRevision !== found.record.revision
    || r.actorId !== ref.recipientId || r.target.kind !== ref.kind || r.target.targetId !== ref.targetId) denied();
  const admission: TechnicalUploadReviewAdmission = { reference: ref, submissionCommandId: r.commandId,
    sourceSha256: canonicalSha256(r), assignmentId: r.assignmentId, assignmentRevision: r.assignmentRevision,
    assignmentStateSha256: found.record.stateSha256, contextSha256: found.context.contextSha256,
    actorId: state.current.userId, sessionId: state.current.sessionId!, authorityRevision: state.authority.revision,
    actorEpoch: state.actor.recordUpdateEpoch, recipientEpoch: state.recipient!.recordUpdateEpoch, keyVersion: state.key.version,
    validUntil: Math.min(state.current.expiresAt * 1000, state.current.registryExpiresAt.getTime(), Date.parse(found.payload.selection.expiresAt)) };
  return { record: r, admission };
}
function descriptor(r: Awaited<ReturnType<typeof submission>>['record']) {
  return { commandId: r.commandId, title: r.command.title, fileName: r.command.file.fileName,
    sizeBytes: r.sizeBytes, contentSha256: r.contentSha256, previewMime: r.command.file.previewMime, createdAt: r.createdAt };
}
async function bytesAndRecheck(tx: Tx, state: TechnicalAssignmentTransaction, ref: TechnicalAssignmentReference,
  found: Awaited<ReturnType<typeof submission>>, write = false) {
  const r = found.record, bytes = await readTechnicalUploadPrivateFile({ storageKey: r.storageKey, sha256: r.contentSha256, sizeBytes: r.sizeBytes });
  const after = await submission(tx, state, ref, r.commandId, write);
  if (canonicalJson(after.admission) !== canonicalJson(found.admission)) stale();
  return bytes;
}
export async function readTechnicalUploadReviewQueue(db: PrismaClient, claimed: AuthSession, raw: TechnicalAssignmentReference) {
  const ref = technicalAssignmentReference.parse(raw);
  return withTechnicalAssignmentManagementRead(db, claimed, ref.kind, ref.recipientId, async (tx, state) => {
    const found = await source(tx, state, ref);
    const rows = await tx.$queryRaw<Array<{ commandId: string }>>`SELECT "commandId" FROM "TechnicalUploadSubmission"
      WHERE "assignmentId"=${found.record.id}::uuid AND "assignmentRevision"=${found.record.revision} ORDER BY "createdAt",id LIMIT 21`;
    if (rows.length > 20) denied();
    const deposits = [];
    for (const row of rows) {
      const item = await submission(tx, state, ref, row.commandId), review = await loadTechnicalUploadReviewForSubmission(tx, state, row.commandId);
      if (review && review.command.sourceSha256 !== item.admission.sourceSha256) denied();
      deposits.push({ ...descriptor(item.record), sourceSha256: item.admission.sourceSha256,
        review: review ? { verdict: review.command.verdict, reason: review.command.reason, recordedAt: review.receipt.recordedAt } : null });
    }
    return { reference: ref, recipient: { name: state.recipient!.name, email: state.recipient!.email }, deposits };
  });
}
export async function readTechnicalUploadForAdmin(db: PrismaClient, claimed: AuthSession, raw: TechnicalAssignmentReference, commandId: string) {
  const ref = technicalAssignmentReference.parse(raw); technicalUploadReviewCommand.shape.submissionCommandId.parse(commandId);
  return withTechnicalAssignmentManagementRead(db, claimed, ref.kind, ref.recipientId, async (tx, state) => {
    const found = await submission(tx, state, ref, commandId);
    return { ...descriptor(found.record), bytes: await bytesAndRecheck(tx, state, ref, found) };
  });
}
export async function previewTechnicalUploadReview(db: PrismaClient, claimed: AuthSession, rawRef: TechnicalAssignmentReference, raw: unknown) {
  const ref = technicalAssignmentReference.parse(rawRef), command = technicalUploadReviewCommand.parse(raw);
  return withTechnicalAssignmentManagementRead(db, claimed, ref.kind, ref.recipientId, async (tx, state) => {
    const found = await submission(tx, state, ref, command.submissionCommandId);
    if (await loadTechnicalUploadReviewForSubmission(tx, state, command.submissionCommandId)) stale();
    await bytesAndRecheck(tx, state, ref, found);
    return { reference: ref, command, file: descriptor(found.record),
      token: createTechnicalUploadReviewPreview(state.key, command, found.admission, (await technicalAssignmentClock(tx)).getTime()) };
  });
}
async function outcome(tx: Tx, state: TechnicalAssignmentTransaction, ref: TechnicalAssignmentReference, commandId: string, digest?: string) {
  const record = await loadTechnicalUploadReview(tx, state, commandId);
  if (!record) return null;
  const r = record.receipt;
  if (r.actorId !== state.current.userId || r.sessionId !== state.current.sessionId || canonicalJson(r.reference) !== canonicalJson(ref)
    || (digest !== undefined && r.requestDigest !== digest)) stale();
  return r;
}
export async function confirmTechnicalUploadReview(db: PrismaClient, claimed: AuthSession, proof: TechnicalAssignmentPersonalProof,
  rawRef: TechnicalAssignmentReference, raw: unknown, token: string, confirmed: boolean) {
  const ref = technicalAssignmentReference.parse(rawRef), command = technicalUploadReviewCommand.parse(raw);
  if (confirmed !== true || typeof token !== 'string' || token.length > 24_000) denied();
  return withTechnicalAssignmentDecision(db, claimed, ref.kind, ref.recipientId, proof, async (tx, state) => {
    const prior = await outcome(tx, state, ref, command.commandId, technicalUploadReviewDigest(ref, command));
    if (prior) return prior;
    const found = await submission(tx, state, ref, command.submissionCommandId, true);
    if (await loadTechnicalUploadReviewForSubmission(tx, state, command.submissionCommandId)) stale();
    if (!readTechnicalUploadReviewPreview(state.key, token, command, found.admission, (await technicalAssignmentClock(tx)).getTime())) stale();
    await bytesAndRecheck(tx, state, ref, found, true);
    const record = prepareTechnicalUploadReview(state.key, command, found.admission, await technicalAssignmentClock(tx));
    const receipt = await persistTechnicalUploadReview(tx, state, record);
    if (!readTechnicalUploadReviewPreview(state.key, token, command, found.admission, (await technicalAssignmentClock(tx)).getTime())) stale();
    await tx.$executeRaw`SET CONSTRAINTS technical_upload_review_atomic IMMEDIATE`;
    return receipt;
  });
}
export async function readTechnicalUploadReviewOutcome(db: PrismaClient, claimed: AuthSession, raw: TechnicalAssignmentReference, commandId: string) {
  const ref = technicalAssignmentReference.parse(raw); technicalUploadReviewCommand.shape.commandId.parse(commandId);
  return withTechnicalAssignmentManagementRead(db, claimed, ref.kind, ref.recipientId, async (tx, state) => {
    const receipt = await outcome(tx, state, ref, commandId);
    return receipt ? { status: 'RECORDED' as const, receipt } : { status: 'NOT_OBSERVED' as const };
  }, { inactiveRecipientForRevocation: true });
}
