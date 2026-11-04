import { isSelectedContentPermission, isTechnicalAccount, technicalPermissionCeiling } from './technical-confidentiality';
import type { RoleCode, UserPermissionOverride } from '@prisma/client';
import { hasFinancialRole, isFinancialPermission } from './financial-privacy-policy';
import {
  adminOnlyAiExecutionPermissions,
  isPermission,
  permissionCodes,
  protectedLeadDuplicatePermissions,
  protectedCommercialLeadPermissions,
  roleHasPermission,
  type Permission,
} from './permissions';

export type PermissionOverrideSnapshot = Pick<UserPermissionOverride, 'permission' | 'allowed'>;

export interface PermissionSession {
  readonly role: RoleCode;
  readonly active: boolean;
  readonly technicalRestricted?: boolean;
  readonly permissionOverrides: readonly PermissionOverrideSnapshot[];
}

export type PermissionDecisionSource = 'ADMIN' | 'OVERRIDE' | 'ROLE';

export interface PermissionDecision {
  readonly allowed: boolean;
  readonly source: PermissionDecisionSource;
}

export function evaluatePermission(session: PermissionSession, permission: Permission): PermissionDecision {
  if (!isPermission(permission) || session.active !== true) return { allowed: false, source: 'ROLE' };
  if (!technicalPermissionCeiling(session, permission)) return { allowed: false, source: 'ROLE' };
  if (isFinancialPermission(permission) && !hasFinancialRole(session)) return { allowed: false, source: 'ROLE' };
  if (permission === 'ai.execution.consume') {
    return { allowed: false, source: session.role === 'admin' ? 'ADMIN' : 'ROLE' };
  }
  if (session.role === 'admin') return { allowed: true, source: 'ADMIN' };
  if (permission === 'video.manage') return { allowed: false, source: 'ROLE' };
  if ((protectedLeadDuplicatePermissions as readonly Permission[]).includes(permission)) {
    return { allowed: session.role === 'direzione', source: 'ROLE' };
  }
  if ((protectedCommercialLeadPermissions as readonly Permission[]).includes(permission)) {
    return { allowed: session.role === 'direzione', source: 'ROLE' };
  }
  if ((adminOnlyAiExecutionPermissions as readonly Permission[]).includes(permission)) {
    return { allowed: false, source: 'ROLE' };
  }
  const override = session.permissionOverrides.find((item) => item.permission === permission);
  if (override) return { allowed: override.allowed, source: 'OVERRIDE' };
  if (isSelectedContentPermission(permission) && isTechnicalAccount(session)) return { allowed: false, source: 'ROLE' };
  return { allowed: roleHasPermission(session.role, permission), source: 'ROLE' };
}

/** Use the same counterfactual decision on every individual permission selector.
 * A selectable override must actually control the server decision in both ways. */
export function permissionOverrideControl(session: PermissionSession, permission: Permission) {
  const active = { ...session, active: true };
  const editable = session.role !== 'admin' && [true, false].every(allowed =>
    evaluatePermission({ ...active, permissionOverrides: [
      ...active.permissionOverrides.filter(item => item.permission !== permission), { permission, allowed },
    ] }, permission).allowed === allowed);
  const reason = session.role === 'admin' ? 'Il ruolo Admin governa questa funzione; gli override individuali non si applicano.'
    : !technicalPermissionCeiling(session, permission) ? 'Contenuto riservato per la funzione tecnica: il permesso individuale non può aprirlo.'
    : isFinancialPermission(permission) && !hasFinancialRole(session) ? 'Riservato ad Admin e Amministrazione.'
    : permission === 'video.manage' ? 'Caricamento, modifica e pubblicazione dei video sono riservati all’Admin.'
    : permission === 'ai.execution.consume' ? 'Funzione interna non attivabile da un account.'
    : !editable ? 'Funzione riservata ai ruoli previsti: nessun override individuale applicabile.'
    : isSelectedContentPermission(permission) && isTechnicalAccount(session)
      ? 'Consenti abilita solo i contenuti selezionati e approvati per questa persona. Eredita mantiene il diniego.'
      : 'La scelta individuale prevale sul permesso ereditato; il perimetro dei singoli dati resta separato.';
  return { editable, reason, inherited: evaluatePermission({ ...active,
    permissionOverrides: active.permissionOverrides.filter(item => item.permission !== permission) }, permission).allowed,
    effective: evaluatePermission(session, permission) };
}

export function hasPermission(session: PermissionSession, permission: Permission) {
  return evaluatePermission(session, permission).allowed;
}

export function getEffectivePermissions(session: PermissionSession) {
  return permissionCodes.filter((permission) => hasPermission(session, permission));
}
