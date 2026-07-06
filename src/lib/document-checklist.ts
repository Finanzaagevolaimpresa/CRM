const receivedChecklistStatuses = ['ricevuto', 'validato', 'non_necessario'];

type ChecklistDocumentState = {
  documentId?: string | null;
  status: string;
};

export function isMissingChecklistDocument(item: ChecklistDocumentState) {
  return !item.documentId && !receivedChecklistStatuses.includes(item.status);
}
