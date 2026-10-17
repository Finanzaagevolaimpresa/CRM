import { RecordUpdateError, recordUpdateSummary, type RecordUpdateKind, type RecordUpdateSummary } from './record-update-contract';

type Snapshot = Readonly<Record<string, unknown>>;
function value(raw: unknown): unknown {
  return raw instanceof Date ? raw.toISOString() : raw === undefined ? null : raw;
}
function different(before: Snapshot, after: Snapshot, field: string) {
  return JSON.stringify(value(before[field])) !== JSON.stringify(value(after[field]));
}
const fields: Record<RecordUpdateKind, ReadonlyArray<{ field: string; event: RecordUpdateSummary['event']; label: string }>> = {
  LEAD: [{ field: 'status', event: 'STATE_CHANGED', label: 'status' },
    { field: 'companyName', event: 'RECORD_CHANGED', label: 'displayName' },
    { field: 'firstName', event: 'RECORD_CHANGED', label: 'displayName' },
    { field: 'lastName', event: 'RECORD_CHANGED', label: 'displayName' },
    { field: 'nextActionDate', event: 'NEXT_ACTION', label: 'nextActionDate' },
    { field: 'nextActionNote', event: 'NEXT_ACTION', label: 'nextAction' }],
  CLIENT: [{ field: 'status', event: 'STATE_CHANGED', label: 'status' },
    { field: 'displayName', event: 'RECORD_CHANGED', label: 'displayName' },
    { field: 'type', event: 'RECORD_CHANGED', label: 'type' }],
  PRACTICE: [{ field: 'status', event: 'STATE_CHANGED', label: 'status' },
    { field: 'clientVisibleStatus', event: 'STATE_CHANGED', label: 'progress' },
    { field: 'dueDate', event: 'DEADLINE', label: 'dueDate' },
    { field: 'nextClientUpdateAt', event: 'NEXT_ACTION', label: 'nextActionDate' }],
  PROJECT: [{ field: 'status', event: 'STATE_CHANGED', label: 'status' },
    { field: 'title', event: 'RECORD_CHANGED', label: 'displayName' }],
};
const securityFields: Record<RecordUpdateKind, readonly string[]> = {
  LEAD: ['assignedToId', 'clientId', 'deletedAt'],
  CLIENT: ['salesOwnerId', 'consultantId', 'leadId', 'deletedAt'],
  PRACTICE: ['clientId', 'projectId', 'clientServiceId', 'commercialOwnerId', 'technicalOwnerId', 'deletedAt'],
  PROJECT: ['clientId', 'companyId', 'consultantId', 'deletedAt'],
};
/** Values and private free text are never part of the notification payload.
 * Record writers remain responsible for their existing business validation. */
export function projectRecordChange(kind: RecordUpdateKind, before: Snapshot, after: Snapshot) {
  if (!Object.hasOwn(fields, kind)) throw new RecordUpdateError('INVALID');
  const lifecycleChanged = different(before, after, 'status')
    && (before.status === 'archiviato' || after.status === 'archiviato'
      || before.status === 'archiviata' || after.status === 'archiviata'
      || before.status === 'sospeso' || after.status === 'sospeso');
  const invalidate = lifecycleChanged || securityFields[kind].some(field => different(before, after, field));
  if (invalidate || after.deletedAt || ['archiviato', 'archiviata', 'sospeso'].includes(String(after.status))) {
    return { invalidate, summaries: [] as RecordUpdateSummary[] };
  }
  const byEvent = new Map<RecordUpdateSummary['event'], string[]>();
  for (const change of fields[kind]) {
    if (different(before, after, change.field)) byEvent.set(change.event, [...(byEvent.get(change.event) ?? []), change.label]);
  }
  return { invalidate: false, summaries: [...byEvent].map(([event, changed]) => recordUpdateSummary(event, changed)) };
}

export type UpdateDeliveryEvidence = {
  recipientId: string; eventId: string; scopeEpoch: string; directoryBinding: string;
  ruleId: string | null; ruleRevision: number | null;
  availableAt: Date; readAt: Date | null; emailDraftId: string | null;
};
export type CurrentUpdateDeliveryAdmission = {
  userId: string; active: boolean; hasCurrentAccess: boolean; operational: boolean;
  scopeEpoch: string; directoryBinding: string; now: Date;
  rule: { id: string; revision: number; active: boolean; expiresAt: Date | null } | null;
};
/** Run before selecting labels/metadata, counts, links or a read receipt.
 * A persisted work item means available in CRM; it never means an email sent. */
export function mayExposeRecordUpdate(stored: UpdateDeliveryEvidence, current: CurrentUpdateDeliveryAdmission) {
  if (!current.active || !current.hasCurrentAccess || !current.operational
    || current.userId !== stored.recipientId || !stored.eventId
    || !stored.scopeEpoch || stored.scopeEpoch !== current.scopeEpoch
    || !stored.directoryBinding || stored.directoryBinding !== current.directoryBinding
    || !Number.isFinite(current.now.getTime()) || !Number.isFinite(stored.availableAt.getTime())
    || stored.availableAt > current.now) return false;
  if (stored.ruleId) {
    const rule = current.rule;
    if (!rule || rule.id !== stored.ruleId || rule.revision !== stored.ruleRevision || !rule.active
      || (rule.expiresAt !== null && (!Number.isFinite(rule.expiresAt.getTime()) || rule.expiresAt <= current.now))) return false;
  } else if (stored.ruleRevision !== null) return false;
  return true;
}
export function recordUpdateDeliveryState(stored: UpdateDeliveryEvidence) {
  return { crm: stored.readAt ? 'LETTO' as const : 'DISPONIBILE' as const,
    email: stored.emailDraftId ? 'BOZZA_DA_APPROVARE' as const : 'NON_PREPARATA' as const };
}

