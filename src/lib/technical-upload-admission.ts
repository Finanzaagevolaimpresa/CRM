import { canonicalSha256 } from './canonical-json';
import type { PrivilegedStepUpKey } from './privileged-step-up-token';
import type { TechnicalTargetReference } from './technical-assignment-display';
import { readTechnicalAssignmentJournal } from './technical-assignment-journal';
import type { CurrentTechnicalAssignmentProof } from './technical-assignment-proof';
import { decodeTechnicalAssignmentRecord } from './technical-assignment-record';
import { technicalUploadAdmission, type TechnicalUploadAdmission } from './technical-upload-contract';

export type LockedTechnicalUploadSource = {
  record: unknown; journal: unknown; current: CurrentTechnicalAssignmentProof;
  target: TechnicalTargetReference; contextSha256: string; scopeGeneration: number;
  session: { userId: string; id: string; tokenExpiresAt: number; registryExpiresAt: number };
  uploadActionAllowed: boolean;
  quota: { assignmentId: string; revision: number; files: number; bytes: number };
};

/** Pure bridge for a future serializable service. Every supplied source must
 * come from freshly locked registry/authority/context/assignment/quota rows,
 * never form fields. No route invokes this preparation and upload stays absent
 * from technicalImplementedActions. Historical proof alone cannot grant it. */
export function admitTechnicalUploadSource(key: PrivilegedStepUpKey, source: LockedTechnicalUploadSource,
  now: Date): TechnicalUploadAdmission | null {
  try {
    const record = decodeTechnicalAssignmentRecord(source.record);
    const payload = readTechnicalAssignmentJournal(source.journal, key, source.current, now);
    if (!record || !payload || source.uploadActionAllowed !== true
      || !payload.selection.actions.includes('upload_document') || !payload.selection.uploadProfile
      || record.id !== payload.id || record.revision !== payload.revision || record.revokedAt !== null
      || canonicalSha256(record.payload) !== canonicalSha256(payload)
      || record.kind !== source.target.kind || record.targetId !== source.target.targetId
      || record.recipientId !== source.current.userId
      || source.contextSha256 !== source.current.currentContextSha256
      || source.contextSha256 !== payload.contextSha256
      || source.session.userId !== source.current.userId
      || source.quota.assignmentId !== record.id || source.quota.revision !== record.revision
      || !Number.isSafeInteger(source.session.tokenExpiresAt) || !Number.isSafeInteger(source.session.registryExpiresAt)) return null;
    // Verify that the record used to derive the state digest is the very same
    // signed record in the retained journal, not an otherwise valid neighbour.
    const journal = source.journal as { assignment: { proof: string } };
    if (record.proof !== journal.assignment.proof) return null;
    const validUntil = Math.min(source.session.tokenExpiresAt, source.session.registryExpiresAt,
      Date.parse(payload.selection.expiresAt));
    if (!Number.isFinite(now.getTime()) || validUntil <= now.getTime()) return null;
    const value = technicalUploadAdmission.safeParse({ target: source.target,
      actorId: source.current.userId, sessionId: source.session.id,
      assignmentId: record.id, assignmentRevision: record.revision, assignmentStateSha256: record.stateSha256,
      authorityRevision: source.current.authority.revision, actorEpoch: source.current.currentRecipientEpoch,
      authorEpoch: source.current.authority.actorEpoch, keyVersion: key.version,
      contextSha256: source.contextSha256, scopeGeneration: source.scopeGeneration,
      profile: payload.selection.uploadProfile, consumedFiles: source.quota.files, consumedBytes: source.quota.bytes,
      validUntil });
    return value.success ? value.data : null;
  } catch { return null; }
}
