import { isFinancialDocument, type FinancialDocumentMetadata } from './financial-privacy-policy';
import { admitsTechnicalAssignmentRead, type CurrentTechnicalAssignmentAdmission, type TechnicalAssignmentSelection } from './technical-assignment-contract';

// Not an authorization loader. A future transaction must build these facts from
// current session, permissions, assignment and canonical document relationships.
// Neither a submitted form nor a previously rendered page can supply them.
export type TechnicalProjectionAdmission = CurrentTechnicalAssignmentAdmission & { recordReadAllowed: boolean };
type RequestedTarget = { targetId: string; kind: TechnicalAssignmentSelection['kind'] };
type TechnicalValue = string | null;
const dateFields = new Set(['dueDate', 'submittedAt', 'nextClientUpdateAt']);

export function projectTechnicalFields(
  current: TechnicalProjectionAdmission, selection: TechnicalAssignmentSelection,
  target: RequestedTarget, row: Readonly<Record<string, unknown>>, now: Date,
): { fields: Record<string, TechnicalValue> } | null {
  if (!current.recordReadAllowed || !admitsTechnicalAssignmentRead(current, selection, target, now)) return null;
  const fields: Record<string, TechnicalValue> = {};
  for (const key of selection.readableFields) {
    if (!Object.hasOwn(row, key)) return null;
    const value = row[key];
    if (value === null || typeof value === 'string') fields[key] = value;
    else if (dateFields.has(key) && value instanceof Date && Number.isFinite(value.getTime())) fields[key] = value.toISOString();
    else return null;
  }
  // Never spread the record: client data, parent relations, owners, financial
  // values, private notes and newly added fields are absent unless allowlisted.
  return { fields };
}

export type CurrentTechnicalDocument = FinancialDocumentMetadata & {
  documentId: string; fileId: string; version: number;
  targetId: string; kind: TechnicalAssignmentSelection['kind'];
  contentSha256: string; contextSha256: string;
  fileName: string; mimeType: string; sizeBytes: number;
  deleted: boolean; contextValid: boolean; readable: boolean;
  financialBindingsChecked: boolean; hasFinancialBinding: boolean;
  sensitive: boolean; sensitiveReadAllowed: boolean;
};
const previewTypes = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'text/plain']);

export function projectTechnicalDocument(
  current: TechnicalProjectionAdmission, selection: TechnicalAssignmentSelection,
  target: RequestedTarget, document: CurrentTechnicalDocument,
  mode: 'preview' | 'download', now: Date,
) {
  if (!current.recordReadAllowed || !admitsTechnicalAssignmentRead(current, selection, target, now)
      || document.targetId !== target.targetId || document.kind !== target.kind
      || document.deleted || !document.contextValid || !document.readable
      || !document.financialBindingsChecked || document.hasFinancialBinding || isFinancialDocument(document)
      || (document.sensitive && !document.sensitiveReadAllowed)
      || !Number.isSafeInteger(document.sizeBytes) || document.sizeBytes < 1
      || !document.fileName || (mode !== 'preview' && mode !== 'download')) return null;
  const selected = selection.documents.find(choice => choice.documentId === document.documentId
    && choice.fileId === document.fileId && choice.version === document.version
    && choice.contentSha256 === document.contentSha256 && choice.contextSha256 === document.contextSha256);
  if (!selected || (mode === 'download' && !selected.allowDownload)
      || (mode === 'preview' && !previewTypes.has(document.mimeType))) return null;
  return { documentId: document.documentId, fileId: document.fileId, version: document.version,
    fileName: document.fileName, mimeType: document.mimeType, sizeBytes: document.sizeBytes };
}
