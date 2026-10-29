import { canonicalSha256 } from './canonical-json';
import { technicalAssignmentPayload } from './technical-assignment-proof';
import { technicalImplementedActions } from './technical-assignment-contract';
import type { TechnicalAssignmentSelection } from './technical-assignment-contract';

/** Principal-only decision. The DB adapter authenticates the caller's session
 * and verifies the retained journal; it never fabricates a recipient session.
 * This function accepts internal facts only and is not an HTTP boundary. */
export function admitTechnicalReminderSelection(raw: unknown, current: {
  kind: TechnicalAssignmentSelection['kind']; targetId: string; taskId: string;
  assignmentId: string; assignmentRevision: number; journalVerified: boolean; revoked: boolean;
  authority: { enabled: boolean; userId: string; revision: number; managerEpoch: number; managerAllowed: boolean };
  recipient: { id: string; epoch: number; active: boolean; allowed: boolean; selectiveCeilingAllows: boolean };
  contextSha256: string; scopeSha256: string; scopeGeneration: number; keyVersion: number; now: Date;
}) {
  const parsed = technicalAssignmentPayload.safeParse(raw);
  if (!parsed.success || !current.journalVerified || current.revoked || !Number.isFinite(current.now.getTime())) return null;
  const p = parsed.data, a = current.authority, r = current.recipient;
  if (!a.enabled || !a.managerAllowed || !r.active || !r.allowed || !r.selectiveCeilingAllows
    || p.id !== current.assignmentId || p.revision !== current.assignmentRevision
    || p.approvedById !== a.userId || p.approvedById === r.id || p.authorityRevision !== a.revision
    || p.actorEpoch !== a.managerEpoch || p.recipientEpoch !== r.epoch || p.selection.userId !== r.id
    || p.targetId !== current.targetId || p.selection.kind !== current.kind || p.keyVersion !== current.keyVersion
    || p.contextSha256 !== current.contextSha256 || Date.parse(p.approvedAt) > current.now.getTime()
    || Date.parse(p.selection.expiresAt) <= current.now.getTime()
    || !p.selection.actions.includes('manage_deadlines')
    || p.selection.actions.some(action => !technicalImplementedActions.some(known => known === action))) return null;
  const item = p.selection.workItems?.find(choice => choice.kind === 'Task' && choice.itemId === current.taskId);
  if (!item || item.kind !== 'Task' || !item.readableFields.includes('dueAt') || item.scopeSha256 !== current.scopeSha256
    || item.scopeGeneration !== current.scopeGeneration) return null;
  return { accessUntil: Date.parse(p.selection.expiresAt), accessBinding: canonicalSha256({
    protocol: 'TECHNICAL_REMINDER_ADMISSION_V1', assignmentId: p.id, revision: p.revision,
    authority: a.revision, managerId: a.userId, managerEpoch: a.managerEpoch,
    recipientId: r.id, recipientEpoch: r.epoch, keyVersion: p.keyVersion,
    target: [current.kind, current.targetId], task: current.taskId,
    contextSha256: current.contextSha256, scopeSha256: current.scopeSha256, scopeGeneration: current.scopeGeneration,
  }) };
}
