import type { RoleCode } from '@prisma/client';
import {
  canAssignService,
  canEditChecklistItem,
  canEditClient,
  canEditCommercialOffer,
  canEditDocument,
  canEditLead,
  canEditProject,
  canEditService,
  canEditTask,
  canEditTechnicalPractice,
  canViewTechnicalPractice,
} from './access-control';
import { UserFacingActionError } from './action-errors';
import { hasPermission, type AuthSession } from './auth';
import { prisma } from './prisma';

const inaccessibleMessage = 'Risorsa non disponibile o non accessibile.';
const clientSelect = { id: true, salesOwnerId: true, consultantId: true } as const;

export type ClientWriteContext = {
  clientId: string;
  companyId?: string | null;
  projectId?: string | null;
  clientServiceId?: string | null;
};

export function denyWriteAccess(): never {
  throw new UserFacingActionError(inaccessibleMessage);
}

export async function requireActiveUser(userId?: string | null, allowedRoles?: readonly RoleCode[]) {
  if (!userId) return null;
  const user = await prisma.user.findFirst({
    where: { id: userId, active: true, deletedAt: null },
    select: { id: true, role: true },
  });
  if (!user || (allowedRoles && !allowedRoles.includes(user.role))) denyWriteAccess();
  return user;
}

export async function requireLeadEditAccess(session: AuthSession, leadId: string) {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, deletedAt: null } });
  if (!lead || !canEditLead(session, lead)) denyWriteAccess();
  return lead;
}

async function loadOfferContext(offerId: string) {
  const offer = await prisma.commercialOffer.findFirst({ where: { id: offerId, deletedAt: null } });
  if (!offer) denyWriteAccess();
  const [lead, client] = await Promise.all([
    offer.leadId ? prisma.lead.findFirst({ where: { id: offer.leadId, deletedAt: null } }) : null,
    offer.clientId ? prisma.client.findFirst({ where: { id: offer.clientId, deletedAt: null }, select: clientSelect }) : null,
  ]);
  return { offer, lead, client };
}

export async function requireCommercialOfferEditAccess(session: AuthSession, offerId: string) {
  const context = await loadOfferContext(offerId);
  if (!canEditCommercialOffer(session, { ...context.offer, lead: context.lead, client: context.client })) denyWriteAccess();
  return context;
}

export async function requireCommercialOfferTargetAccess(
  session: AuthSession,
  target: { leadId?: string | null; clientId?: string | null },
) {
  const [lead, client] = await Promise.all([
    target.leadId ? prisma.lead.findFirst({ where: { id: target.leadId, deletedAt: null } }) : null,
    target.clientId ? prisma.client.findFirst({ where: { id: target.clientId, deletedAt: null }, select: clientSelect }) : null,
  ]);
  if (target.leadId && (!lead || !canEditLead(session, lead))) denyWriteAccess();
  if (target.clientId && (!client || !canEditClient(session, client))) denyWriteAccess();
  if (lead?.clientId && target.clientId && lead.clientId !== target.clientId) denyWriteAccess();
  return { lead, client };
}

async function loadProjectContext(projectId: string) {
  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
  });
  if (!project) denyWriteAccess();
  const [client, company] = await Promise.all([
    prisma.client.findFirst({ where: { id: project.clientId, deletedAt: null }, select: clientSelect }),
    project.companyId
      ? prisma.company.findFirst({ where: { id: project.companyId, clientId: project.clientId, deletedAt: null }, select: { id: true } })
      : null,
  ]);
  if (!client || (project.companyId && !company)) denyWriteAccess();
  return { ...project, client };
}

async function loadServiceContext(serviceId: string) {
  const service = await prisma.clientService.findFirst({
    where: { id: serviceId, deletedAt: null },
  });
  if (!service) denyWriteAccess();
  const [client, company, project] = await Promise.all([
    prisma.client.findFirst({ where: { id: service.clientId, deletedAt: null }, select: clientSelect }),
    service.companyId
      ? prisma.company.findFirst({ where: { id: service.companyId, clientId: service.clientId, deletedAt: null }, select: { id: true } })
      : null,
    service.projectId ? loadProjectContext(service.projectId) : null,
  ]);
  if (!client || (service.companyId && !company) || (project && project.clientId !== service.clientId)) denyWriteAccess();
  if (company && project?.companyId && project.companyId !== company.id) denyWriteAccess();
  return { ...service, client, project };
}

export async function requireClientContextWriteAccess(
  session: AuthSession,
  context: ClientWriteContext,
  options: { allowBackofficeClient?: boolean } = {},
) {
  const [client, company, project, clientService] = await Promise.all([
    prisma.client.findFirst({ where: { id: context.clientId, deletedAt: null }, select: clientSelect }),
    context.companyId
      ? prisma.company.findFirst({ where: { id: context.companyId, clientId: context.clientId, deletedAt: null }, select: { id: true, clientId: true } })
      : null,
    context.projectId ? loadProjectContext(context.projectId) : null,
    context.clientServiceId ? loadServiceContext(context.clientServiceId) : null,
  ]);
  if (!client) denyWriteAccess();
  if (context.companyId && !company) denyWriteAccess();
  if (context.projectId && (!project || project.clientId !== context.clientId)) denyWriteAccess();
  if (context.clientServiceId && (!clientService || clientService.clientId !== context.clientId)) denyWriteAccess();
  if (project && clientService?.projectId && clientService.projectId !== project.id) denyWriteAccess();
  if (company && project?.companyId && project.companyId !== company.id) denyWriteAccess();
  if (company && clientService?.companyId && clientService.companyId !== company.id) denyWriteAccess();

  const allowed = options.allowBackofficeClient === true && session.role === 'backoffice'
    ? true
    : clientService
      ? canEditService(session, clientService)
      : project
        ? canEditProject(session, project)
        : canEditClient(session, client);
  if (!allowed) denyWriteAccess();
  return { client, company, project, clientService };
}

export async function requireProjectEditAccess(session: AuthSession, projectId: string) {
  const project = await loadProjectContext(projectId);
  if (!canEditProject(session, project)) denyWriteAccess();
  return project;
}

export async function requireServiceEditAccess(session: AuthSession, serviceId: string) {
  const service = await loadServiceContext(serviceId);
  if (!canEditService(session, service)) denyWriteAccess();
  return service;
}

export async function requireServiceAssignAccess(session: AuthSession, serviceId: string) {
  const service = await loadServiceContext(serviceId);
  if (!canAssignService(session, service)) denyWriteAccess();
  return service;
}

async function loadDocumentContext(documentId: string) {
  const document = await prisma.document.findFirst({ where: { id: documentId, deletedAt: null } });
  if (!document) denyWriteAccess();
  const [client, company, project, clientService] = await Promise.all([
    document.clientId
      ? prisma.client.findFirst({ where: { id: document.clientId, deletedAt: null }, select: clientSelect })
      : null,
    document.companyId && document.clientId
      ? prisma.company.findFirst({ where: { id: document.companyId, clientId: document.clientId, deletedAt: null }, select: { id: true } })
      : null,
    document.projectId ? loadProjectContext(document.projectId) : null,
    document.clientServiceId ? loadServiceContext(document.clientServiceId) : null,
  ]);
  if (document.clientId && !client) denyWriteAccess();
  if (document.companyId && !company) denyWriteAccess();
  if (document.projectId && (!project || !document.clientId || project.clientId !== document.clientId)) denyWriteAccess();
  if (document.clientServiceId && (!clientService || !document.clientId || clientService.clientId !== document.clientId)) denyWriteAccess();
  if (company && project?.companyId && project.companyId !== document.companyId) denyWriteAccess();
  if (company && clientService?.companyId && clientService.companyId !== document.companyId) denyWriteAccess();
  if (project && clientService?.projectId && clientService.projectId !== project.id) denyWriteAccess();
  return { ...document, client, project, clientService };
}

export async function requireDocumentEditAccess(session: AuthSession, documentId: string) {
  const document = await loadDocumentContext(documentId);
  if (!canEditDocument(session, document, hasPermission(session, 'document.sensitive.read'))) denyWriteAccess();
  return document;
}

export async function requireChecklistEditAccess(session: AuthSession, itemId: string) {
  const item = await prisma.documentChecklistItem.findFirst({
    where: { id: itemId, active: true, deletedAt: null },
  });
  if (!item) denyWriteAccess();
  const [client, project, clientService, document] = await Promise.all([
    prisma.client.findFirst({ where: { id: item.clientId, deletedAt: null }, select: clientSelect }),
    item.projectId ? loadProjectContext(item.projectId) : null,
    item.clientServiceId ? loadServiceContext(item.clientServiceId) : null,
    item.documentId ? loadDocumentContext(item.documentId) : null,
  ]);
  if (!client) denyWriteAccess();
  if (item.projectId && (!project || project.clientId !== item.clientId)) denyWriteAccess();
  if (item.clientServiceId && (!clientService || clientService.clientId !== item.clientId)) denyWriteAccess();
  if (document && document.clientId !== item.clientId) denyWriteAccess();
  if (document && !canEditDocument(session, document, hasPermission(session, 'document.sensitive.read'))) denyWriteAccess();
  const context = { ...item, client, project, clientService };
  if (!canEditChecklistItem(session, context)) denyWriteAccess();
  return context;
}

export async function requireTaskEditAccess(session: AuthSession, taskId: string) {
  const task = await prisma.task.findFirst({ where: { id: taskId, deletedAt: null } });
  if (!task?.clientId) denyWriteAccess();
  const [client, company, project, clientService] = await Promise.all([
    prisma.client.findFirst({ where: { id: task.clientId, deletedAt: null }, select: clientSelect }),
    task.companyId
      ? prisma.company.findFirst({ where: { id: task.companyId, clientId: task.clientId, deletedAt: null }, select: { id: true } })
      : null,
    task.projectId ? loadProjectContext(task.projectId) : null,
    task.clientServiceId ? loadServiceContext(task.clientServiceId) : null,
  ]);
  if (!client) denyWriteAccess();
  if (task.projectId && (!project || project.clientId !== task.clientId)) denyWriteAccess();
  if (task.clientServiceId && (!clientService || clientService.clientId !== task.clientId)) denyWriteAccess();
  if (task.companyId && !company) denyWriteAccess();
  if (company && project?.companyId && project.companyId !== company.id) denyWriteAccess();
  if (company && clientService?.companyId && clientService.companyId !== company.id) denyWriteAccess();
  if (project && clientService?.projectId && clientService.projectId !== project.id) denyWriteAccess();
  const context = { ...task, client, project, clientService };
  if (!canEditTask(session, context)) denyWriteAccess();
  return context;
}

async function loadTechnicalPracticeContext(practiceId: string) {
  const practice = await prisma.technicalPractice.findFirst({ where: { id: practiceId, deletedAt: null } });
  if (!practice) denyWriteAccess();
  const [client, project, clientService] = await Promise.all([
    prisma.client.findFirst({ where: { id: practice.clientId, deletedAt: null }, select: clientSelect }),
    practice.projectId ? loadProjectContext(practice.projectId) : null,
    practice.clientServiceId ? loadServiceContext(practice.clientServiceId) : null,
  ]);
  if (!client) denyWriteAccess();
  if (practice.projectId && (!project || project.clientId !== practice.clientId)) denyWriteAccess();
  if (practice.clientServiceId && (!clientService || clientService.clientId !== practice.clientId)) denyWriteAccess();
  if (project && clientService?.projectId && clientService.projectId !== project.id) denyWriteAccess();
  return { practice, client, project, clientService };
}

export async function requireTechnicalPracticeViewAccess(session: AuthSession, practiceId: string) {
  const context = await loadTechnicalPracticeContext(practiceId);
  if (!canViewTechnicalPractice(session, { ...context.practice, client: context.client })) denyWriteAccess();
  return context;
}

export async function requireTechnicalPracticeEditAccess(session: AuthSession, practiceId: string) {
  const { practice } = await loadTechnicalPracticeContext(practiceId);
  if (!canEditTechnicalPractice(session, practice)) denyWriteAccess();
  return practice;
}
