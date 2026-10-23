import type { RoleCode } from '@prisma/client';
import type { Permission } from './permissions';

// Presentation policy only. Every destination retains its server-side record,
// session and selective-access checks; appearing here never grants access.
const commonDestinations = new Set(['/dashboard', '/settings/account', '/notifications', '/search', '/videos', '/shared-projects']);
const salesDestinations = new Set(['/leads', '/commercial-offers', '/clients', '/progress', '/assignments', '/tasks', '/deadlines', '/communications', '/admin-requests']);
const technicalDestinations = new Set(['/projects', '/technical-office', '/technical-office/practices', '/technical-work', '/assignments', '/tasks', '/deadlines', '/documents', '/document-checklists', '/communications', '/admin-requests']);
const limitedDestinations = new Set(['/clients', '/projects', '/tasks', '/deadlines', '/documents', '/communications']);

export function operationalNavigationAllows(role: RoleCode | null | undefined, destination: string) {
  if (!role) return false;
  if (commonDestinations.has(destination)) return true;
  if (role === 'commerciale') return salesDestinations.has(destination);
  if (role === 'consulente' || role === 'backoffice') return technicalDestinations.has(destination);
  if (role === 'collaboratore_limitato') return limitedDestinations.has(destination);
  return true;
}

export function operationalDashboardView(role: RoleCode, permitted: (permission: Permission) => boolean) {
  const sales = role === 'commerciale';
  const technical = role === 'consulente' || role === 'backoffice';
  const limited = role === 'collaboratore_limitato';
  const focused = sales || technical || limited;
  const canReviewAiOutputs = !focused && permitted('ai.review');
  const access = {
    canReadLeads: !technical && !limited && permitted('lead.read'),
    canReadTechnical: !sales && !limited && permitted('technical.read'),
    canReadPracticeCommunications: !focused && permitted('practice_communications.read'),
    canReviewPracticeCommunications: !focused && permitted('practice_communications.review'),
    canReadClients: !technical && permitted('client.read'),
    canReadProjects: !sales && permitted('project.read'),
    canReadServices: permitted('service.read'),
    canReadDossiers: !focused && permitted('dossier.read'),
    canReadPayments: !focused && permitted('payment.read'),
    canReadAiOutputs: !focused && (canReviewAiOutputs || permitted('ai.approve')),
    canReviewAiOutputs,
    canReadAudit: !focused && permitted('audit.read'),
  };
  return {
    ...access,
    canReadCommercialProgress: sales && permitted('client.read'),
    showServicePortfolio: !focused && access.canReadServices,
    showPipeline: !focused && access.canReadServices,
    // The old extended dashboard contains cross-area summaries. Keep it only
    // for an Admin who still has every permission those summaries require.
    showLegacyDetails: role === 'admin' && Object.values(access).every(Boolean),
  };
}
