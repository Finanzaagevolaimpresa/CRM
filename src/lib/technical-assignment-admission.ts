import type { Prisma } from '@prisma/client';
import { hasSelectiveClientContext } from './selective-client-policy';
import { hasSelectiveContext } from './selective-project-policy';
import { isSelectivePractice } from './selective-practice-policy';
import { lockTechnicalAssignmentContext } from './technical-assignment-context';
import type { TechnicalTargetReference } from './technical-assignment-display';
import { readTechnicalAssignmentJournal } from './technical-assignment-journal';
import { admitsTechnicalAssignmentManager, admitsTechnicalRolePermission } from './technical-assignment-permissions';
import type { CurrentTechnicalAssignmentProof } from './technical-assignment-proof';
import { loadTechnicalAssignmentJournal, lockTechnicalAssignmentRecord } from './technical-assignment-storage';
import { TechnicalAssignmentError, technicalAssignmentClock, type TechnicalAssignmentTransaction } from './technical-assignment-transaction';
import { technicalImplementedActions } from './technical-assignment-contract';
type Tx = Prisma.TransactionClient;
function deny(): never { throw new TechnicalAssignmentError('DENIED'); }

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
