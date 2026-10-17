export const recordUpdateKinds = ['LEAD', 'CLIENT', 'PRACTICE', 'PROJECT'] as const;
export type RecordUpdateKind = typeof recordUpdateKinds[number];
export const recordUpdateEvents = ['STATE_CHANGED', 'RECORD_CHANGED', 'COMMUNICATION', 'NEXT_ACTION', 'DEADLINE'] as const;
export type RecordUpdateEvent = typeof recordUpdateEvents[number];
export const recordUpdateModes = ['CRM', 'EMAIL_DRAFT', 'CRM_AND_EMAIL_DRAFT'] as const;
export type RecordUpdateMode = typeof recordUpdateModes[number];
export const recordUpdateRecipientLimit = 20;
export const recordUpdateEventLabels: Record<RecordUpdateEvent, string> = {
  STATE_CHANGED: 'Stato o avanzamento', RECORD_CHANGED: 'Dati del record',
  COMMUNICATION: 'Nuova comunicazione', NEXT_ACTION: 'Prossima azione', DEADLINE: 'Scadenza',
};
export const recordUpdateChangedLabels: Record<string, string> = {
  status: 'Stato', progress: 'Avanzamento', displayName: 'Denominazione o titolo', type: 'Tipo cliente', profile: 'Dati del record',
  communication: 'Nuova comunicazione', nextAction: 'Prossima azione', nextActionDate: 'Data della prossima azione', dueDate: 'Scadenza',
};
