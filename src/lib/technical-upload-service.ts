import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { AuthSession } from './auth';
import { canonicalJson } from './canonical-json';
import { lockAuthorizedTechnicalAssignment } from './technical-assignment-admission';
import { technicalTargetReference, type TechnicalTargetReference } from './technical-assignment-display';
import { admitsTechnicalRolePermission } from './technical-assignment-permissions';
import { TechnicalAssignmentError, technicalAssignmentClock, withTechnicalAssignmentRecipient,
  type TechnicalAssignmentTransaction } from './technical-assignment-transaction';
import { admitTechnicalUploadSource } from './technical-upload-admission';
import { technicalUploadCommand, readTechnicalUploadPreview, readTechnicalUploadReceipt,
  technicalUploadRequestDigest } from './technical-upload-contract';
import { previewTechnicalUploadDeposit, confirmTechnicalUploadDeposit, technicalUploadStorageKey } from './technical-upload-plan';
import { loadTechnicalUploadRecord, persistTechnicalUploadRecord, readTechnicalUploadQuota,
  withTechnicalUploadDecision } from './technical-upload-persistence';
import { prepareTechnicalUploadRecord } from './technical-upload-record';
import { readTechnicalUploadPhysicalQuota, readTechnicalUploadPrivateFile, storeTechnicalUploadPrivateFile } from './technical-upload-storage';
import { loadTechnicalUploadReviewForSubmission } from './technical-upload-review-persistence';

type Tx = Prisma.TransactionClient;
function denied(): never { throw new TechnicalAssignmentError('DENIED'); }
function stale(): never { throw new TechnicalAssignmentError('STALE'); }
function unavailable(): never { throw new TechnicalAssignmentError('UNAVAILABLE'); }

/** Admission is derived only from current locked assignment and quota rows. */
async function lockedUpload(tx: Tx, state: TechnicalAssignmentTransaction, target: TechnicalTargetReference, write = false) {
  const found = await lockAuthorizedTechnicalAssignment(tx, state, target, false, write ? { lockAssignmentForWrite: true } : {});
  if (!found.payload.selection.actions.includes('upload_document') || !found.payload.selection.uploadProfile
    || !admitsTechnicalRolePermission(state.current, target.kind, 'upload_document')) denied();
  const quota = await readTechnicalUploadQuota(tx, state, found.record.id, found.record.revision);
  const admission = admitTechnicalUploadSource(state.key, {
    record: { id: found.record.id, kind: found.record.kind,
      projectId: target.kind === 'Project' ? target.targetId : null,
      practiceId: target.kind === 'TechnicalPractice' ? target.targetId : null,
      recipientId: found.record.recipientId, revision: found.record.revision,
      payload: found.record.payload, proof: found.record.proof, revokedAt: found.record.revokedAt },
    journal: found.journal, current: found.current, target,
    contextSha256: found.context.contextSha256, scopeGeneration: found.context.rootEpoch,
    session: { userId: state.current.userId, id: state.current.sessionId!,
      tokenExpiresAt: state.current.expiresAt * 1000, registryExpiresAt: state.current.registryExpiresAt.getTime() },
    uploadActionAllowed: true, quota,
  }, await technicalAssignmentClock(tx));
  if (!admission) denied();
  return { found, admission };
}

async function outcome(tx: Tx, state: TechnicalAssignmentTransaction, target: TechnicalTargetReference,
  commandId: string, digest?: string) {
  const saved = await loadTechnicalUploadRecord(tx, state, commandId);
  if (!saved) return null;
  const r = saved.record;
  const receipt = readTechnicalUploadReceipt(state.key, r.receipt, r.proof, { commandId,
    actorId: state.current.userId, sessionId: state.current.sessionId!, target,
    requestDigest: digest ?? r.requestDigest }, (await technicalAssignmentClock(tx)).getTime());
  if (!receipt) stale();
  return receipt;
}

export async function previewTechnicalUpload(db: PrismaClient, claimed: AuthSession,
  rawTarget: TechnicalTargetReference, raw: unknown, fileName: string, bytes: Uint8Array) {
  const target = technicalTargetReference.parse(rawTarget);
  return withTechnicalAssignmentRecipient(db, claimed, target.kind, async (tx, state) => {
    const locked = await lockedUpload(tx, state, target);
    return { target, ...previewTechnicalUploadDeposit(state.key, raw, fileName, bytes,
      locked.admission, (await technicalAssignmentClock(tx)).getTime()) };
  });
}

/** Metadata for the current author and exact assignment revision only. Reads
 * never create a bucket or quota row. Physical orphans remain charged separately. */
export async function readOwnTechnicalUploads(db: PrismaClient, claimed: AuthSession, rawTarget: TechnicalTargetReference) {
  const target = technicalTargetReference.parse(rawTarget);
  return withTechnicalAssignmentRecipient(db, claimed, target.kind, async (tx, state) => {
    const { admission: a } = await lockedUpload(tx, state, target);
    const rows = await tx.$queryRaw<Array<{ commandId: string }>>`SELECT "commandId" FROM "TechnicalUploadSubmission"
      WHERE "assignmentId"=${a.assignmentId}::uuid AND "assignmentRevision"=${a.assignmentRevision} ORDER BY "createdAt",id LIMIT 21`;
    if (rows.length > 20) unavailable();
    const deposits = [];
    for (const row of rows) {
      const saved = await loadTechnicalUploadRecord(tx, state, row.commandId), r = saved?.record;
      if (!r || r.actorId !== a.actorId || r.assignmentId !== a.assignmentId || r.assignmentRevision !== a.assignmentRevision
        || canonicalJson(r.target) !== canonicalJson(target)) denied();
      const review = await loadTechnicalUploadReviewForSubmission(tx, state, row.commandId);
      deposits.push({ commandId: r.commandId, title: r.command.title, fileName: r.command.file.fileName,
        sizeBytes: r.sizeBytes, createdAt: r.createdAt, previewMime: r.command.file.previewMime,
        review: review ? { verdict: review.command.verdict, reason: review.command.reason, recordedAt: review.receipt.recordedAt } : null });
    }
    const physical = await readTechnicalUploadPhysicalQuota(technicalUploadStorageKey(a, '00000000-0000-4000-8000-000000000000'), a.profile);
    if (physical.files < a.consumedFiles || physical.bytes < a.consumedBytes) unavailable();
    return { target, assignmentId: a.assignmentId, assignmentRevision: a.assignmentRevision, contextSha256: a.contextSha256,
      profile: a.profile, consumedFiles: physical.files, consumedBytes: physical.bytes,
      retainedWithoutReceipt: physical.files - a.consumedFiles, deposits };
  });
}

/** One explicit command; the original command ID and byte identity survive a
 * lost response. No new attempt is generated and no rollback cleanup is run. */
export async function confirmTechnicalUpload(db: PrismaClient, claimed: AuthSession,
  rawTarget: TechnicalTargetReference, raw: unknown, token: string, bytes: Uint8Array, confirmed: boolean) {
  if (confirmed !== true || typeof token !== 'string' || token.length > 32_000) denied();
  const target = technicalTargetReference.parse(rawTarget), command = technicalUploadCommand.parse(raw);
  return withTechnicalUploadDecision(db, claimed, target.kind, async (tx, state) => {
    const digest = technicalUploadRequestDigest(target, command);
    const prior = await outcome(tx, state, target, command.commandId, digest);
    if (prior) return prior;
    const locked = await lockedUpload(tx, state, target, true);
    // Another concurrent command cannot consume quota between this lock and
    // commit. Serializable conflicts are reported, never retried with a new ID.
    const again = await outcome(tx, state, target, command.commandId, digest);
    if (again) return again;
    const intent = confirmTechnicalUploadDeposit(state.key, command, token, bytes, true, locked.admission,
      (await technicalAssignmentClock(tx)).getTime());
    if (!intent) stale();
    const stored = await storeTechnicalUploadPrivateFile(intent.privateFile);
    const checked = await lockedUpload(tx, state, target, true);
    const now = await technicalAssignmentClock(tx);
    if (canonicalJson(checked.admission) !== canonicalJson(locked.admission)
      || !readTechnicalUploadPreview(state.key, token, checked.admission, now.getTime())) stale();
    const proposed = prepareTechnicalUploadRecord(state.key, intent, checked.admission, stored, randomUUID(), now);
    const receipt = await persistTechnicalUploadRecord(tx, state, proposed);
    const quota = await readTechnicalUploadQuota(tx, state, command.assignmentId, command.assignmentRevision);
    if (quota.files !== intent.quota.filesAfter || quota.bytes !== intent.quota.bytesAfter) unavailable();
    if (!readTechnicalUploadPreview(state.key, token, checked.admission,
      (await technicalAssignmentClock(tx)).getTime())) stale();
    return receipt;
  });
}

/** A historical receipt contains no metadata or bytes. Current session and the
 * original actor/session/target are checked even after assignment revocation. */
export async function readTechnicalUploadOutcome(db: PrismaClient, claimed: AuthSession,
  rawTarget: TechnicalTargetReference, commandId: string) {
  const target = technicalTargetReference.parse(rawTarget);
  z.string().uuid().parse(commandId);
  return withTechnicalAssignmentRecipient(db, claimed, target.kind, async (tx, state) => {
    const receipt = await outcome(tx, state, target, commandId);
    return receipt ? { status: 'RECORDED' as const, receipt } : { status: 'NOT_OBSERVED' as const };
  });
}

/** Private author access only. Current upload action, decision revision, scope,
 * role and expiry are rechecked after reading exact bytes. A valid old receipt
 * or an ordinary client/project relationship cannot grant this read. */
export async function readOwnTechnicalUpload(db: PrismaClient, claimed: AuthSession,
  rawTarget: TechnicalTargetReference, commandId: string) {
  const target = technicalTargetReference.parse(rawTarget);
  z.string().uuid().parse(commandId);
  return withTechnicalAssignmentRecipient(db, claimed, target.kind, async (tx, state) => {
    const locked = await lockedUpload(tx, state, target);
    const saved = await loadTechnicalUploadRecord(tx, state, commandId);
    if (!saved) denied();
    const r = saved.record;
    if (r.actorId !== state.current.userId || r.assignmentId !== locked.admission.assignmentId
      || r.assignmentRevision !== locked.admission.assignmentRevision || canonicalJson(r.target) !== canonicalJson(target)) denied();
    const bytes = await readTechnicalUploadPrivateFile({ storageKey: r.storageKey,
      sha256: r.contentSha256, sizeBytes: r.sizeBytes });
    const checked = await lockedUpload(tx, state, target);
    if (canonicalJson(checked.admission) !== canonicalJson(locked.admission)) denied();
    return { bytes, title: r.command.title, fileName: r.command.file.fileName, previewMime: r.command.file.previewMime };
  });
}
