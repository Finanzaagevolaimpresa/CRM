import type { TechnicalAssignmentSelection } from './technical-assignment-contract';
import { technicalFieldsFor } from './technical-confidentiality';
/** Explicit draft only. Responsibility remains a separate personal decision.
 * No live inheritance, future version, expiry renewal or identity is copied. */
export function technicalCollaborationSelection(source: { recipientId: string; revokedAt: Date | string | null;
  selection: TechnicalAssignmentSelection }, recipientId: string, now: Date): TechnicalAssignmentSelection {
  if (!recipientId || recipientId === source.recipientId || source.selection.userId !== source.recipientId
    || source.revokedAt !== null || !Number.isFinite(now.getTime()) || !Number.isFinite(Date.parse(source.selection.expiresAt)) || Date.parse(source.selection.expiresAt) <= now.getTime()) {
    throw new Error('TECHNICAL_COLLABORATION_SOURCE_UNAVAILABLE');
  }
  const s = source.selection, readableFields = technicalFieldsFor(s.kind, s.readableFields),
    editableFields = technicalFieldsFor(s.kind, s.editableFields);
  if (!readableFields.length) throw new Error('TECHNICAL_COLLABORATION_SOURCE_UNAVAILABLE');
  const workItems = s.workItems?.map(item => ({ ...item,
    readableFields: technicalFieldsFor(item.kind, item.readableFields),
    editableFields: technicalFieldsFor(item.kind, item.editableFields) })).filter(item => item.readableFields.length);
  const actions = s.actions.filter(action => action !== 'update_fields' || editableFields.length)
    .filter(action => action !== 'manage_deadlines' || workItems?.some(item => item.kind === 'Task'))
    .filter(action => action !== 'manage_checklist' || workItems?.some(item => item.kind === 'ChecklistItem'));
  if (!actions.length) throw new Error('TECHNICAL_COLLABORATION_SOURCE_UNAVAILABLE');
  return { ...structuredClone(s), userId: recipientId, responsibility: 'supporto', readableFields, editableFields, actions,
    ...(workItems ? { workItems } : {}) } as TechnicalAssignmentSelection;
}
