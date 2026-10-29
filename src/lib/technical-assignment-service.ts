import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { AuthSession } from './auth';
import { hasSelectiveClientContext } from './selective-client-policy';
import { hasSelectiveContext } from './selective-project-policy';
import { loadTechnicalAssignmentIndependentScope } from './selective-project-scope';
import { isSelectivePractice } from './selective-practice-policy';
import { lockTechnicalAssignmentContext } from './technical-assignment-context';
import { assertTechnicalAssignmentDocuments } from './technical-assignment-documents';
import { prepareTechnicalAssignmentDecision, readTechnicalAssignmentDecisionOutcome, parseTechnicalAssignmentDecision,
  technicalAssignmentReference, technicalAssignmentRequestDigest, type TechnicalAssignmentReference } from './technical-assignment-decision';
import { readRetainedTechnicalAssignmentJournal } from './technical-assignment-journal';
import { admitsTechnicalRolePermission } from './technical-assignment-permissions';
import { createTechnicalAssignmentPreview, readTechnicalAssignmentPreview,
  type TechnicalAssignmentPreviewAdmission, type TechnicalAssignmentPreviewOperation } from './technical-assignment-preview';
import { loadTechnicalAssignmentDecisionJournal, loadTechnicalAssignmentJournal, lockTechnicalAssignmentRecord,
  persistTechnicalAssignmentDecision } from './technical-assignment-storage';
import { TechnicalAssignmentError, technicalAssignmentClock, withTechnicalAssignmentDecision,
  withTechnicalAssignmentManagementRead, type TechnicalAssignmentPersonalProof,
  type TechnicalAssignmentTransaction } from './technical-assignment-transaction';
import { technicalFieldPreview } from './technical-assignment-display';
import { technicalAssignmentTargetFields } from './technical-assignment-target';
import { technicalImplementedActions } from './technical-assignment-contract';
import { assertTechnicalWorkItemChoices } from './technical-work-item-source';
import { withTechnicalAssignmentAttemptSettlement } from './technical-assignment-transaction';
import { readTechnicalAttemptClosure, persistTechnicalAttemptClosure } from './technical-assignment-attempt';
import { TechnicalAssignmentAttemptClosedError } from './technical-assignment-errors';

type Tx = Prisma.TransactionClient;
type Input = ReturnType<typeof parseTechnicalAssignmentDecision>;
function deny(): never { throw new TechnicalAssignmentError('DENIED'); }
function stale(): never { throw new TechnicalAssignmentError('STALE'); }
const inactive = { inactiveRecipientForRevocation: true } as const;

async function lockedState(tx: Tx, state: TechnicalAssignmentTransaction,
  reference: TechnicalAssignmentReference, write: boolean, allowInactive: boolean) {
  const context = await lockTechnicalAssignmentContext(tx, { kind: reference.kind, targetId: reference.targetId }, { allowInactive });
  if (!context || hasSelectiveClientContext(state.current, context) || hasSelectiveContext(state.current, context)
    || (reference.kind === 'TechnicalPractice' && isSelectivePractice(state.current, reference.targetId))) deny();
  const previous = await lockTechnicalAssignmentRecord(tx, reference, write ? 'decision' : 'read');
  const journal = previous ? await loadTechnicalAssignmentJournal(tx, previous) : null;
  if (previous && !readRetainedTechnicalAssignmentJournal(journal, state.key, await technicalAssignmentClock(tx))) {
    throw new TechnicalAssignmentError('UNAVAILABLE');
  }
  return { context, previous, journal };
}
type Locked = Awaited<ReturnType<typeof lockedState>>;

async function currentAdmission(tx: Tx, state: TechnicalAssignmentTransaction, locked: Locked,
  reference: TechnicalAssignmentReference, operation: TechnicalAssignmentPreviewOperation, input: Input) {
  if (!state.recipient) deny();
  let validUntil = Math.min(state.current.expiresAt * 1000, state.current.registryExpiresAt.getTime());
  if (operation === 'ASSIGN') {
    if (!('selection' in input) || !locked.context.operational || input.targetId !== reference.targetId
      || input.selection.kind !== reference.kind || input.selection.userId !== reference.recipientId
      || input.selection.actions.some(action => !technicalImplementedActions.some(implemented => implemented === action))
      || input.selection.actions.some(action => !admitsTechnicalRolePermission(state.recipient!, reference.kind, action))) deny();
    // Existing read-only selections are independent ceilings. An assignment must
    // not silently replace a narrower client/project/practice choice.
    const scope = await loadTechnicalAssignmentIndependentScope(tx, reference.recipientId);
    if (hasSelectiveClientContext(scope, locked.context) || hasSelectiveContext(scope, locked.context)
      || (reference.kind === 'TechnicalPractice' && isSelectivePractice(scope, reference.targetId))) deny();
    await assertTechnicalWorkItemChoices(tx, state, locked.context, input.selection);
    const documents = await assertTechnicalAssignmentDocuments(tx, state, locked.context, input.selection.documents);
    validUntil = Math.min(validUntil, documents.validUntil);
  } else if ('selection' in input || !locked.previous || locked.previous.revokedAt !== null
    || input.assignmentId !== locked.previous.id) stale();
  return { actorId: state.current.userId, sessionId: state.current.sessionId!, authorityRevision: state.authority.revision,
    actorEpoch: state.actor.recordUpdateEpoch, recipientEpoch: state.recipient.recordUpdateEpoch,
    ...reference, assignmentId: locked.previous?.id ?? null, assignmentRevision: locked.previous?.revision ?? 0,
    assignmentStateSha256: locked.previous?.stateSha256 ?? null, contextSha256: locked.context.contextSha256,
    validUntil } satisfies TechnicalAssignmentPreviewAdmission;
}

async function previousOutcome(tx: Tx, state: TechnicalAssignmentTransaction, reference: TechnicalAssignmentReference,
  commandId: string, requestDigest?: string) {
  const journal = await loadTechnicalAssignmentDecisionJournal(tx, commandId);
  if (!journal) return null;
  const receipt = readTechnicalAssignmentDecisionOutcome(journal, state.key, { ...reference,
    actorId: state.current.userId, sessionId: state.current.sessionId!, commandId, requestDigest }, await technicalAssignmentClock(tx));
  if (!receipt) stale();
  return receipt;
}

/** POST preview with current locks, no DB writes.
 * A recipient catalogue and management UI must never supply admission facts. */
export async function previewTechnicalAssignment(db: PrismaClient, claimed: AuthSession,
  rawReference: TechnicalAssignmentReference, operation: TechnicalAssignmentPreviewOperation, raw: unknown) {
  const reference = technicalAssignmentReference.parse(rawReference), input = parseTechnicalAssignmentDecision(operation, raw);
  return withTechnicalAssignmentManagementRead(db, claimed, reference.kind, reference.recipientId, async (tx, state) => {
    const locked = await lockedState(tx, state, reference, false, operation === 'REVOKE');
    const admission = await currentAdmission(tx, state, locked, reference, operation, input);
    const documents = 'selection' in input
      ? await assertTechnicalAssignmentDocuments(tx, state, locked.context, input.selection.documents) : null;
    const fields = 'selection' in input ? technicalFieldPreview(reference.kind, input.selection.readableFields,
      await technicalAssignmentTargetFields(tx, reference)) : [];
    const workItems = 'selection' in input ? await assertTechnicalWorkItemChoices(tx, state, locked.context, input.selection) : [];
    return { input, reference, operation, token: createTechnicalAssignmentPreview(operation, state.key, input, admission,
      (await technicalAssignmentClock(tx)).getTime()), fields, workItems, documents: documents?.metadata ?? [],
      recipient: { id: state.recipient!.id, name: state.recipient!.name, email: state.recipient!.email },
      replacesAssignment: locked.previous !== null };
  }, operation === 'REVOKE' ? inactive : {});
}

/** One personal command, serializable on the recipient/target. Explicit step-up
 * is fresh before and after the callback. Repeated exact requests return only
 * their retained receipt; they cannot mutate again or renew an expired grant. */
export async function confirmTechnicalAssignment(db: PrismaClient, claimed: AuthSession,
  proof: TechnicalAssignmentPersonalProof, rawReference: TechnicalAssignmentReference,
  operation: TechnicalAssignmentPreviewOperation, raw: unknown, token: string, confirmed: boolean) {
  if (confirmed !== true || typeof token !== 'string' || token.length > 32_000) deny();
  const reference = technicalAssignmentReference.parse(rawReference), input = parseTechnicalAssignmentDecision(operation, raw);
  return withTechnicalAssignmentDecision(db, claimed, reference.kind, reference.recipientId, proof, async (tx, state) => {
    const locked = await lockedState(tx, state, reference, true, operation === 'REVOKE');
    const previous = await previousOutcome(tx, state, reference, input.commandId,
      technicalAssignmentRequestDigest(operation, reference, input));
    if (previous) return previous;
    if (await readTechnicalAttemptClosure(tx, state, reference, input.commandId)) throw new TechnicalAssignmentAttemptClosedError();
    const admission = await currentAdmission(tx, state, locked, reference, operation, input);
    const change = prepareTechnicalAssignmentDecision({ operation, key: state.key, raw: input, token, admission,
      previous: locked.previous, journal: locked.journal, assignmentId: locked.previous?.id ?? randomUUID(),
      revisionId: randomUUID(), now: await technicalAssignmentClock(tx) });
    const receipt = await persistTechnicalAssignmentDecision(tx, state, change, admission.assignmentStateSha256);
    if ('selection' in input) await assertTechnicalAssignmentDocuments(tx, state, locked.context, input.selection.documents);
    if (!readTechnicalAssignmentPreview(operation, state.key, token, admission, (await technicalAssignmentClock(tx)).getTime())) stale();
    return receipt;
  }, operation === 'REVOKE' ? inactive : {});
}

/** Read-only, opaque-reference recovery. Absence is NOT_OBSERVED, never an
 * invented failed/successful outcome or permission to submit another ID. */
export async function readTechnicalAssignmentOutcome(db: PrismaClient, claimed: AuthSession,
  rawReference: TechnicalAssignmentReference, commandId: string) {
  const reference = technicalAssignmentReference.parse(rawReference);
  z.string().uuid().parse(commandId);
  return withTechnicalAssignmentManagementRead(db, claimed, reference.kind, reference.recipientId, async (tx, state) => {
    await lockedState(tx, state, reference, false, true);
    const receipt = await previousOutcome(tx, state, reference, commandId);
    return receipt ? { status: 'RECORDED' as const, receipt }
      : await readTechnicalAttemptClosure(tx, state, reference, commandId) ?? { status: 'NOT_OBSERVED' as const };
  }, inactive);
}

/** Explicit settlement waits for the same locks as an in-flight decision.
 * It returns the committed receipt or durably prevents any future execution
 * of that command. An empty read alone never unlocks the editor. */
export async function settleTechnicalAssignmentAttempt(db: PrismaClient, claimed: AuthSession,
  rawReference: TechnicalAssignmentReference, commandId: string) {
  const reference = technicalAssignmentReference.parse(rawReference);
  z.string().uuid().parse(commandId);
  return withTechnicalAssignmentAttemptSettlement(db, claimed, reference.kind, reference.recipientId, async (tx, state) => {
    await lockedState(tx, state, reference, true, true);
    const receipt = await previousOutcome(tx, state, reference, commandId);
    if (receipt) return { status: 'RECORDED' as const, receipt };
    return persistTechnicalAttemptClosure(tx, state, reference, commandId);
  });
}
