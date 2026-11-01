import { isTechnicalAccount, type TechnicalConfidentialityActor } from './technical-confidentiality';
export type TechnicalPageMode = 'original' | 'workspace' | 'record' | 'denied';
/** Audited server surfaces. A new route defaults to denied for a technical
 * account until its projection and direct-access path have been qualified. */
export function technicalPageMode(route: string): TechnicalPageMode {
  if (['/', '/login', '/settings/account', '/technical-uploads/[kind]/[id]',
    '/notifications/updates', '/notifications/updates/[id]', '/technical-office/integrations',
    '/admin-requests', '/admin-requests/new', '/admin-requests/[id]', '/assignments', '/assignments/[kind]/[id]'].includes(route)) return 'original';
  if (['/dashboard', '/projects', '/technical-office', '/technical-office/practices',
    '/tasks', '/deadlines', '/documents', '/document-checklists', '/search',
    '/notifications',
    '/communications', '/communications/updates'].includes(route)) return 'workspace';
  if (['/projects/[id]', '/technical-office/practices/[id]'].includes(route)) return 'record';
  if (['/technical-work', '/technical-work/[kind]/[id]', '/technical-work/[kind]/[id]/items/[itemKind]/[itemId]'].includes(route)
    || ['/shared-projects', '/shared-projects/[id]', '/shared-practices', '/shared-practices/[id]',
      '/shared-clients', '/shared-clients/[id]', '/shared-leads', '/shared-leads/[id]'].includes(route)) return 'original';
  return 'denied';
}
const fileRoutes = new Set([
  '/api/admin-requests/outcome',
  '/documents/[id]/download', '/documents/[id]/view', '/acquired-documents/[id]',
  '/shared-projects/[id]/documents/[versionId]', '/shared-clients/[id]/documents/[versionId]',
  '/shared-practices/[id]/documents/[versionId]', '/technical-work/[kind]/[id]/documents/[versionId]',
]);
export function technicalFileRouteAllowed(route: string) { return fileRoutes.has(route); }
const allowedActions = new Set([
  'login-actions:loginAction', 'login-actions:logoutAction',
  'user-account-actions:saveAccountProfile', 'user-account-actions:saveOwnPassword',
  'technical-work-actions:prepareTechnicalWork', 'technical-work-actions:saveTechnicalWork', 'technical-work-actions:checkTechnicalWork',
  'technical-work-item-actions:prepareTechnicalWorkItem', 'technical-work-item-actions:saveTechnicalWorkItem', 'technical-work-item-actions:checkTechnicalWorkItem',
  'record-update-actions:markRecordUpdateReadAction',
  'responsibility-actions:acceptResponsibilityAction', 'admin-request-actions:mutateAdminRequest',
  'technical-upload-actions:prepareTechnicalUpload', 'technical-upload-actions:saveTechnicalUpload', 'technical-upload-actions:checkTechnicalUpload',
]);
export function technicalActionAllowed(actor: TechnicalConfidentialityActor, action: string) {
  return !isTechnicalAccount(actor) || allowedActions.has(action);
}
