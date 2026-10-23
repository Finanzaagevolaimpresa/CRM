import { z } from 'zod';
import { canonicalSha256 } from './canonical-json';
import type { PrivilegedStepUpKey } from './privileged-step-up-token';
import { technicalAssignmentCommand, technicalAssignmentRevocation } from './technical-assignment-contract';
import { readRetainedTechnicalAssignmentJournal, technicalAssignmentReceipt } from './technical-assignment-journal';
import { readTechnicalAssignmentPreview, type TechnicalAssignmentPreviewAdmission,
  type TechnicalAssignmentPreviewOperation } from './technical-assignment-preview';
import { technicalAssignmentPayload, technicalAssignmentProof } from './technical-assignment-proof';
import type { StoredTechnicalAssignment } from './technical-assignment-record';

const referenceSchema = z.object({ kind: z.enum(['Project', 'TechnicalPractice']),
  targetId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  recipientId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/) }).strict();
export const technicalAssignmentReference = referenceSchema;
export type TechnicalAssignmentReference = z.infer<typeof referenceSchema>;

export function parseTechnicalAssignmentDecision(operation: TechnicalAssignmentPreviewOperation, raw: unknown) {
  if (operation === 'ASSIGN') return technicalAssignmentCommand.parse(raw);
  if (operation === 'REVOKE') return technicalAssignmentRevocation.parse(raw);
  throw new Error('TECHNICAL_ASSIGNMENT_INVALID_OPERATION');
}
export function technicalAssignmentRequestDigest(operation: TechnicalAssignmentPreviewOperation,
  reference: TechnicalAssignmentReference, raw: unknown) {
  return canonicalSha256({ protocol: 'TECHNICAL_ASSIGNMENT_REQUEST_V1', operation,
    reference: referenceSchema.parse(reference), input: parseTechnicalAssignmentDecision(operation, raw) });
}

/** Constructs exactly one proposed DB change from a current, locked admission.
 * No side effects, personal authority consumption or claim of DB commit here.
 * The service must verify current documents/permissions and persist all four
 * records atomically, then recheck time/session before the transaction ends. */
export function prepareTechnicalAssignmentDecision(args: {
  operation: TechnicalAssignmentPreviewOperation; key: PrivilegedStepUpKey;
  raw: unknown; token: string; admission: TechnicalAssignmentPreviewAdmission;
  previous: StoredTechnicalAssignment | null; journal: unknown;
  assignmentId: string; revisionId: string; now: Date;
}) {
  const { operation, key, admission, previous, now } = args;
  const input = parseTechnicalAssignmentDecision(operation, args.raw);
  const exact = readTechnicalAssignmentPreview(operation, key, args.token, admission, now.getTime());
  if (!exact || canonicalSha256(exact) !== canonicalSha256(input)
    || (previous?.id ?? null) !== admission.assignmentId
    || (previous?.revision ?? 0) !== admission.assignmentRevision
    || (previous?.stateSha256 ?? null) !== admission.assignmentStateSha256) {
    throw new Error('TECHNICAL_ASSIGNMENT_DECISION_STALE');
  }
  if (previous) {
    const retained = readRetainedTechnicalAssignmentJournal(args.journal, key, now);
    if (!retained || canonicalSha256(retained.assignment) !== canonicalSha256({ payload: previous.payload,
      proof: previous.proof, revokedAt: previous.revokedAt }) || args.assignmentId !== previous.id
      || previous.kind !== admission.kind || previous.targetId !== admission.targetId
      || previous.recipientId !== admission.recipientId) throw new Error('TECHNICAL_ASSIGNMENT_HISTORY_UNAVAILABLE');
  } else if (args.journal !== null || operation === 'REVOKE') {
    throw new Error('TECHNICAL_ASSIGNMENT_HISTORY_UNAVAILABLE');
  }
  if (operation === 'REVOKE' && previous?.revokedAt !== null) throw new Error('TECHNICAL_ASSIGNMENT_ALREADY_REVOKED');
  const selection = 'selection' in exact ? exact.selection : previous!.payload.selection;
  const payload = technicalAssignmentPayload.parse({ protocol: 'TECHNICAL_ASSIGNMENT_V1',
    id: z.string().uuid().parse(args.assignmentId), revision: admission.assignmentRevision + 1,
    commandId: exact.commandId, targetId: admission.targetId, selection,
    approvedById: admission.actorId, approvedAt: now.toISOString(), authorityRevision: admission.authorityRevision,
    actorEpoch: admission.actorEpoch, recipientEpoch: admission.recipientEpoch,
    contextSha256: admission.contextSha256, keyVersion: key.version });
  const requestDigest = technicalAssignmentRequestDigest(operation, {
    kind: admission.kind, targetId: admission.targetId, recipientId: admission.recipientId }, exact);
  const receipt = technicalAssignmentReceipt.parse({ protocol: 'TECHNICAL_ASSIGNMENT_RECEIPT_V1',
    commandId: exact.commandId, assignmentId: payload.id, revisionId: args.revisionId,
    revision: payload.revision, operation, fieldCount: selection.readableFields.length,
    actionCount: selection.actions.length, documentCount: selection.documents.length, keyVersion: key.version,
    actorId: admission.actorId, sessionId: admission.sessionId, requestDigest });
  const proof = technicalAssignmentProof(key, 'assignment', payload);
  const revokedAt = operation === 'REVOKE' ? now.toISOString() : null;
  return {
    assignment: { payload, proof, revokedAt },
    decision: { id: exact.commandId, actorId: admission.actorId, sessionId: admission.sessionId,
      kind: admission.kind, targetId: admission.targetId, recipientId: admission.recipientId,
      expectedRevision: admission.assignmentRevision, operation, requestDigest, receipt,
      receiptProof: technicalAssignmentProof(key, 'receipt', receipt) },
    revision: { id: receipt.revisionId, assignmentId: payload.id, revision: payload.revision,
      commandId: exact.commandId, payload, proof, revokedAt },
    audit: { id: receipt.revisionId, actorId: admission.actorId, event: 'technical_assignment_changed',
      entityType: 'TechnicalAssignmentRevision', entityId: receipt.revisionId,
      before: { version: admission.assignmentRevision }, after: { version: payload.revision, action: operation,
        fieldCount: receipt.fieldCount, actionCount: receipt.actionCount, documentCount: receipt.documentCount } },
  };
}
export type PreparedTechnicalAssignmentDecision = ReturnType<typeof prepareTechnicalAssignmentDecision>;

/** Reconcile an already committed command, including a subsequently revoked or
 * superseded assignment. The caller first proves current management admission.
 * A null result is not permission to repeat an uncertain operation with a new ID. */
export function readTechnicalAssignmentDecisionOutcome(raw: unknown, key: PrivilegedStepUpKey,
  expected: TechnicalAssignmentReference & { actorId: string; sessionId: string; commandId: string;
    requestDigest?: string }, now: Date) {
  const row = readRetainedTechnicalAssignmentJournal(raw, key, now);
  const d = row?.decision;
  if (!row || !d || d.id !== expected.commandId || d.actorId !== expected.actorId || d.sessionId !== expected.sessionId
    || d.kind !== expected.kind || d.targetId !== expected.targetId || d.recipientId !== expected.recipientId
    || (expected.requestDigest !== undefined && d.requestDigest !== expected.requestDigest)) return null;
  return row.decision.receipt;
}
