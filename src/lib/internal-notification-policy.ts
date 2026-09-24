import type { Client, ClientService, CommercialOffer, Lead, PracticeCommunication, Prisma, Project, Task, TechnicalPractice } from '@prisma/client';
import { canViewClient, canViewCommercialOffer, canViewLead, canViewProject, canViewService, canViewTask, getActorId, hasGlobalAccess, type Actor } from './access-control';
import { buildDashboardTechnicalCounterContext } from './dashboard-technical-counter-context';

type ClientContext = Pick<Client, 'id' | 'salesOwnerId' | 'consultantId' | 'deletedAt'>;
type ProjectContext = Pick<Project, 'id' | 'clientId' | 'consultantId' | 'deletedAt'>;
type ServiceContext = Pick<ClientService, 'id' | 'clientId' | 'projectId' | 'assignedToId' | 'deletedAt'>;
type PracticeContext = Pick<TechnicalPractice, 'id' | 'clientId' | 'projectId' | 'clientServiceId' | 'commercialOwnerId' | 'technicalOwnerId' | 'deletedAt'>;
type LeadContext = Pick<Lead, 'id' | 'assignedToId' | 'clientId'>;

export function buildNotificationAccess(session: Actor, input: {
  clients: ClientContext[]; projects: ProjectContext[]; services: ServiceContext[];
  practices: PracticeContext[]; leads: LeadContext[];
}) {
  const clientById = new Map(input.clients.filter(row => !row.deletedAt).map(row => [row.id, row]));
  const projectById = new Map(input.projects.filter(row => !row.deletedAt).map(row => [row.id, { ...row, client: clientById.get(row.clientId) ?? null }]));
  const serviceById = new Map(input.services.filter(row => !row.deletedAt).map(row => [row.id, {
    ...row, client: clientById.get(row.clientId) ?? null, project: row.projectId ? projectById.get(row.projectId) ?? null : null,
  }]));
  const clientIds = [...clientById.values()].filter(row => canViewClient(session, row)).map(row => row.id);
  const projectIds = [...projectById.values()].filter(row => canViewProject(session, row)).map(row => row.id);
  const serviceIds = [...serviceById.values()].filter(row => canViewService(session, row)).map(row => row.id);
  const technical = buildDashboardTechnicalCounterContext({ session, ...input, communications: [] });
  const practices = new Map(technical.visiblePractices.map(row => [row.id, row]));
  const leadById = new Map(input.leads.map(row => [row.id, row]));
  const userId = getActorId(session);
  const global = hasGlobalAccess(session);
  const taskWhere: Prisma.TaskWhereInput = global ? {} : { OR: [
    { assignedToId: userId }, { clientId: { in: clientIds } }, { projectId: { in: projectIds } },
    { clientServiceId: { in: serviceIds } },
    { clientId: null, projectId: null, clientServiceId: null, assignedToId: null, createdById: userId },
  ] };
  const visibleLeadIds = input.leads.filter(row => canViewLead(session, row)).map(row => row.id);
  const offerWhere: Prisma.CommercialOfferWhereInput = global ? {} : { OR: [
    { clientId: { in: clientIds } }, { leadId: { in: visibleLeadIds } },
    { clientId: null, leadId: null, createdById: userId },
  ] };
  return {
    taskWhere, offerWhere, practiceIds: [...practices.keys()],
    canViewTask: (row: Pick<Task, 'clientId' | 'projectId' | 'clientServiceId' | 'assignedToId' | 'createdById'>) => canViewTask(session, {
      ...row, client: row.clientId ? clientById.get(row.clientId) ?? null : null,
      project: row.projectId ? projectById.get(row.projectId) ?? null : null,
      clientService: row.clientServiceId ? serviceById.get(row.clientServiceId) ?? null : null,
    }),
    canViewOffer: (row: Pick<CommercialOffer, 'clientId' | 'leadId' | 'createdById'>) => canViewCommercialOffer(session, {
      ...row, client: row.clientId ? clientById.get(row.clientId) ?? null : null, lead: row.leadId ? leadById.get(row.leadId) ?? null : null,
    }),
    canViewCommunication: (row: Pick<PracticeCommunication, 'technicalPracticeId' | 'clientId' | 'projectId' | 'clientServiceId'>) => {
      const practice = practices.get(row.technicalPracticeId);
      return Boolean(practice && row.clientId === practice.clientId && row.projectId === practice.projectId && row.clientServiceId === practice.clientServiceId);
    },
  };
}
