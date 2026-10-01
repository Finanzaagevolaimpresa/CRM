import { hasPermission, type PermissionSession } from './permission-evaluator';
import { financialDocumentRequirements, type FinancialDocumentMetadata } from './financial-privacy-policy';

// Legacy access predicates also receive role-only actors. Live sessions retain
// their authoritative active flag and individual overrides through this helper.
export type FinancialActor = Pick<PermissionSession, 'role'> & Partial<Omit<PermissionSession, 'role'>>;

export function financialReadAccess(actor: FinancialActor) {
  const session = { role: actor.role, active: actor.active !== false, permissionOverrides: actor.permissionOverrides ?? [] };
  return { contract: hasPermission(session, 'contract.read'), payment: hasPermission(session, 'payment.read') };
}

export function canAccessFinancialDocumentMetadata(actor: FinancialActor, document: FinancialDocumentMetadata) {
  const required = financialDocumentRequirements(document), allowed = financialReadAccess(actor);
  return (!required.contract || allowed.contract) && (!required.payment || allowed.payment);
}

export function operationalServiceStatus(actor: FinancialActor, status: string) {
  return !financialReadAccess(actor).payment && status === 'pagato' ? 'disponibile' : status;
}
