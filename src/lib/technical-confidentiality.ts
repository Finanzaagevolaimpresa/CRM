/** Mandatory disclosure ceiling. It is applied after grants and role presets,
 * never inferred from an object's name or from the currently selected menu. */
export type TechnicalConfidentialityActor = {
  role: string; technicalRestricted?: boolean;
  permissionOverrides?: readonly { permission: string; allowed: boolean }[];
};
export const technicalOfficeRoles = ['consulente', 'backoffice'] as const;
export function isTechnicalAccount(actor: TechnicalConfidentialityActor) {
  if (actor.role === 'admin') return false;
  return actor.technicalRestricted === true
    || (technicalOfficeRoles as readonly string[]).includes(actor.role)
    || !!actor.permissionOverrides?.some(item => item.allowed
      && ['technical.write', 'technical.status', 'technical.assign', 'technical.admin'].includes(item.permission));
}
/** These sources contain unclassified narratives, commercial evidence or
 * complete snapshots. A positive override cannot make them technical data. */
const restrictedPermissions = new Set([
  'contract.read', 'contract.write', 'payment.read', 'payment.write', 'audit.read',
  'dossier.read', 'dossier.write', 'dossier.approve', 'ai.review', 'ai.approve',
  'ai.execution.audit', 'ai.orchestrator.audit', 'legal.read', 'privacy.evidence.read',
  'practice_communications.read', 'practice_communications.review', 'practice_communications.mark_used',
  'communications.internal.read', 'user.read', 'user.write', 'settings.manage',
]);
export function technicalPermissionCeiling(actor: TechnicalConfidentialityActor, permission: string) {
  return !isTechnicalAccount(actor) || !restrictedPermissions.has(permission);
}
/** Free/common/internal notes never become public by renaming them "technical".
 * Historical signed selections remain parseable; projection and mutation apply
 * this current ceiling without rewriting those decisions. */
const technicalFields: Record<string, ReadonlySet<string>> = {
  Project: new Set(['title', 'status', 'priority', 'technicalOwnerName', 'commercialOwnerName',
    'region', 'province', 'sector', 'totalInvestment', 'requestedAmount']),
  TechnicalPractice: new Set(['title', 'practiceType', 'status', 'priority', 'dueDate',
    'targetEntity', 'targetPortal', 'protocolNumber', 'submittedAt', 'nextClientUpdateAt',
    'technicalOwnerName', 'commercialOwnerName']),
  Task: new Set(['title', 'status', 'priority', 'dueAt']),
  ChecklistItem: new Set(['title', 'status']),
  Client: new Set(['displayName', 'legalName', 'firstName', 'lastName', 'taxCode', 'vatNumber',
    'email', 'phone', 'city', 'province', 'region', 'clientType']),
  Lead: new Set(['firstName', 'lastName', 'companyName', 'email', 'phone', 'status',
    'region', 'province', 'city']),
};
export function technicalFieldAllowed(kind: string, field: string) {
  return technicalFields[kind]?.has(field) === true;
}
export function technicalFieldsFor<T extends string>(kind: string, fields: readonly T[]): T[] {
  return fields.filter(field => technicalFieldAllowed(kind, field));
}
export function fieldsForDisclosure<T extends string>(actor: TechnicalConfidentialityActor, kind: string, fields: readonly T[]): T[] {
  return isTechnicalAccount(actor) ? technicalFieldsFor(kind, fields) : [...fields];
}
/** Classified project investment is not a fee/payment. Generic amount fields
 * and expense descriptions have no such provenance and remain denied. */
export const technicalInvestmentSources = {
  totalInvestment: { model: 'Project', meaning: 'Investimento previsto del progetto' },
  requestedAmount: { model: 'Project', meaning: 'Agevolazione o finanziamento richiesto dal progetto' },
} as const;
