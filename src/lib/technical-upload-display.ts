import { technicalTargetReference, type TechnicalTargetReference } from './technical-assignment-display';
import type { TechnicalAssignmentReference } from './technical-assignment-decision';
export function technicalUploadPath(target: TechnicalTargetReference) {
  return `/technical-uploads/${target.kind === 'Project' ? 'projects' : 'practices'}/${encodeURIComponent(target.targetId)}`;
}
export function technicalUploadReviewPath(ref: TechnicalAssignmentReference) {
  return `/technical-upload-review/${ref.kind === 'Project' ? 'projects' : 'practices'}/${encodeURIComponent(ref.targetId)}/${encodeURIComponent(ref.recipientId)}`;
}
export function parseTechnicalUploadTarget(p: { kind: string; id: string }) {
  return technicalTargetReference.safeParse({ kind: p.kind === 'projects' ? 'Project' : p.kind === 'practices' ? 'TechnicalPractice' : null, targetId: p.id });
}
export const technicalUploadVerdictLabels = { APPROVE_PRIVATE: 'Approvato · deposito privato', REJECT_PRIVATE: 'Rifiutato · storico conservato' } as const;
