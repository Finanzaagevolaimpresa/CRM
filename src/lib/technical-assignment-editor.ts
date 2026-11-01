import type { TechnicalAssignmentSelection } from './technical-assignment-contract';
import type { TechnicalDocumentChoices, TechnicalDocumentOption } from './technical-document-catalog';
import { technicalWorkItemOptionKey, type TechnicalWorkItemChoices, type TechnicalWorkItemOption } from './technical-work-item-catalog';

type RetainedAssignment = { id: string; recipientId: string; revokedAt: Date | string | null; selection: TechnicalAssignmentSelection };
type Input = { kind: TechnicalAssignmentSelection['kind']; recipientId: string | null; assignmentId: string | null;
  assignments: RetainedAssignment[]; documents: TechnicalDocumentOption[]; workItems: TechnicalWorkItemOption[] };

/** Copy the retained decision, not the current catalogue. Off-page or no-longer
 * admitted references remain explicit until the operator removes them. Preview
 * and confirmation must still validate every reference and current authority. */
export function retainedTechnicalAssignmentEditor(input: Input) {
  const record = input.assignments.find(row => row.id === input.assignmentId && row.recipientId === input.recipientId
    && row.selection.userId === input.recipientId && row.selection.kind === input.kind && !row.revokedAt);
  const selection = record?.selection;
  const documents: TechnicalDocumentChoices = {}, workItems: TechnicalWorkItemChoices = {};
  for (const doc of selection?.documents ?? []) {
    const metadata = input.documents.find(row => row.documentId === doc.documentId && row.fileId === doc.fileId
      && row.version === doc.version && row.contentSha256 === doc.contentSha256 && row.contextSha256 === doc.contextSha256);
    documents[doc.fileId] = { option: metadata ? { ...metadata, ...doc } : { ...doc,
      title: '', fileName: '', mimeType: '', retainedReference: true }, download: doc.allowDownload };
  }
  for (const item of selection?.workItems ?? []) {
    const metadata = input.workItems.find(row => row.kind === item.kind && row.itemId === item.itemId
      && row.generation === item.generation && row.scopeGeneration === item.scopeGeneration && row.scopeSha256 === item.scopeSha256);
    workItems[technicalWorkItemOptionKey(item)] = { option: { kind: item.kind, itemId: item.itemId,
      generation: item.generation, scopeGeneration: item.scopeGeneration, scopeSha256: item.scopeSha256,
      title: metadata?.title ?? '', ...(!metadata ? { retainedReference: true as const } : {}) },
      readable: [...item.readableFields], editable: [...item.editableFields] };
  }
  const upload = selection?.uploadProfile;
  return { retained: !!selection, responsibility: selection?.responsibility ?? 'supporto' as const,
    readable: [...selection?.readableFields ?? []] as string[], editable: [...selection?.editableFields ?? []] as string[],
    actions: [...selection?.actions ?? []], documents, workItems, expires: selection?.expiresAt ?? '',
    upload: { purpose: upload?.purpose ?? '', formats: [...upload?.formats ?? []],
      fileMiB: upload ? String(upload.maxFileBytes / 1048576) : '',
      files: upload ? String(upload.maxFilesPerRevision) : '',
      totalMiB: upload ? String(upload.maxBytesPerRevision / 1048576) : '' } };
}
