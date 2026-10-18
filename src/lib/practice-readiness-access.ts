import type { Lead } from '@prisma/client';
import { isSelectiveLead } from './selective-lead-policy';
import { canViewClientContext, canViewLead, hasConsistentClientContext, type Actor } from './access-control';

/** Assignment follows service, then project, then the originating lead. */
export function canViewPracticeReadinessWork(user: Actor, context: Parameters<typeof canViewClientContext>[1] & {
  projectId?: string | null; clientServiceId?: string | null;
  lead?: Pick<Lead, 'assignedToId' | 'clientId'> & Partial<Pick<Lead, 'id' | 'deletedAt'>> | null;
}) {
  if (isSelectiveLead(user, context.lead?.id)) return false;
  if (!context.client || !context.lead || context.lead.deletedAt || context.lead.clientId !== context.client.id || !hasConsistentClientContext(context)) return false;
  if (context.projectId && context.project?.id !== context.projectId) return false;
  if (context.clientServiceId && context.clientService?.id !== context.clientServiceId) return false;
  if (context.project && context.clientService?.projectId && context.project.id !== context.clientService.projectId) return false;
  if (context.project || context.clientService) return canViewClientContext(user, context);
  return canViewLead(user, context.lead);
}
