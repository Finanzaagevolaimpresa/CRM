export const manualPreAnalysisFields = ['internalSummary', 'scenarioA', 'scenarioB', 'blockingConditions', 'requiredDocuments'] as const;

export type ManualPreAnalysisState = {
  status: string;
  aiRunId: string | null;
  reviewedById: string | null;
  approvedById: string | null;
  approvedAt: Date | null;
};

export function isEditableManualPreAnalysis(record: ManualPreAnalysisState) {
  return (record.status === 'da_avviare' || record.status === 'raccolta_dati')
    && record.aiRunId === null
    && record.reviewedById === null
    && record.approvedById === null
    && record.approvedAt === null;
}
