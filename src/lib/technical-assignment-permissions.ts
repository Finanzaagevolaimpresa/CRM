import { hasPermission, type PermissionSession } from './permission-evaluator';
import type { Permission } from './permissions';
import type { TechnicalAssignmentSelection, technicalAssignmentActions } from './technical-assignment-contract';

export function technicalReadPermission(kind: TechnicalAssignmentSelection['kind']): Permission {
  return kind === 'Project' ? 'project.read' : 'technical.read';
}
function currentPermission(actor: PermissionSession, permission: Permission) {
  return hasPermission(actor, permission)
    && !actor.permissionOverrides.some(item => item.permission === permission && !item.allowed);
}

/** Role and permission are ceilings, never an assignment. Parent-list permissions
 * are deliberately absent: an assigned practice does not grant its client dossier. */
export function admitsTechnicalRolePermission(actor: PermissionSession, kind: TechnicalAssignmentSelection['kind'],
  action?: typeof technicalAssignmentActions[number]) {
  if (!['consulente', 'backoffice'].includes(actor.role) || !currentPermission(actor, technicalReadPermission(kind))) return false;
  if (!action) return true;
  const permissions: Record<typeof technicalAssignmentActions[number], Permission> = {
    update_fields: kind === 'Project' ? 'project.write' : 'technical.write',
    update_status: kind === 'Project' ? 'project.write' : 'technical.status',
    manage_checklist: 'service.write', manage_deadlines: 'service.write',
    request_admin: 'practice_communications.write', upload_document: 'document.upload',
  };
  return Object.hasOwn(permissions, action) && currentPermission(actor, permissions[action]);
}

export function admitsTechnicalAssignmentManager(actor: PermissionSession, kind: TechnicalAssignmentSelection['kind']) {
  return actor.role === 'admin' && currentPermission(actor, technicalReadPermission(kind))
    && currentPermission(actor, kind === 'Project' ? 'project.write' : 'technical.assign');
}
