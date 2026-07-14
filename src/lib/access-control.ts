import type { Client, ClientService, Document, DocumentChecklistItem, Lead, Project, RoleCode, Task, User } from '@prisma/client';
import type { AuthSession } from './auth';

export type Actor = Pick<User, 'id' | 'role'> | Pick<AuthSession, 'userId' | 'role'>;
type ClientAccessContext = Pick<Client, 'id' | 'salesOwnerId' | 'consultantId'>;
type ProjectAccessContext = Pick<Project, 'clientId' | 'consultantId'> & {
  id?: Project['id'];
  client?: ClientAccessContext | null;
};
type ServiceAccessContext = Pick<ClientService, 'clientId' | 'assignedToId'> & {
  id?: string;
  projectId?: string | null;
  client?: ClientAccessContext | null;
  project?: ProjectAccessContext | null;
};
type ClientScopedContext = {
  clientId?: string | null;
  client?: ClientAccessContext | null;
  project?: ProjectAccessContext | null;
  clientService?: ServiceAccessContext | null;
};
type CommercialOfferAccessContext = {
  createdById?: string | null;
  leadId?: string | null;
  clientId?: string | null;
  lead?: Pick<Lead, 'assignedToId' | 'clientId'> | null;
  client?: ClientAccessContext | null;
};

type AiRunAccessContext = {
  clientId?: string | null;
  clientServiceId?: string | null;
  projectId?: string | null;
  createdById?: string | null;
};
type AiOutputAccessContext = {
  clientId?: string | null;
  clientServiceId?: string | null;
  projectId?: string | null;
  status?: string;
  requiresHumanReview?: boolean;
  forbiddenPhrases?: unknown;
  reviewedById?: string | null;
  reviewedAt?: Date | null;
  run?: AiRunAccessContext | null;
  client?: ClientAccessContext | null;
  project?: ProjectAccessContext | null;
  clientService?: ServiceAccessContext | null;
};

export const getActorId = (user: Actor) => 'userId' in user ? user.userId : user.id;
export const allAccessRoles: RoleCode[] = ['admin', 'direzione'];
export const sensitiveDocumentCategories = ['CRIF', 'Centrale Rischi', 'documenti identità', 'dichiarazioni fiscali', 'bilanci', 'estratti conto', 'contratti', 'contabili pagamento'];
export function isSensitiveDocument(document: Pick<Document, 'containsSensitiveData' | 'documentCategory' | 'type'>) {
  const category = `${document.documentCategory} ${document.type}`.toLowerCase();
  return document.containsSensitiveData || sensitiveDocumentCategories.some((item) => category.includes(item.toLowerCase()));
}
export function hasGlobalAccess(user: Actor) { return allAccessRoles.includes(user.role); }

export function hasConsistentClientContext(context: ClientScopedContext) {
  const clientIds = [
    context.clientId,
    context.client?.id,
    context.project?.clientId,
    context.project?.client?.id,
    context.clientService?.clientId,
    context.clientService?.client?.id,
    context.clientService?.project?.clientId,
    context.clientService?.project?.client?.id,
  ].filter((clientId): clientId is string => typeof clientId === 'string' && clientId.length > 0);

  return new Set(clientIds).size <= 1;
}

function hasValidProjectContext(project: ProjectAccessContext) {
  return Boolean(project.client)
    && hasConsistentClientContext({ clientId: project.clientId, client: project.client });
}

function hasValidServiceContext(service: ServiceAccessContext) {
  if (!service.client) return false;
  if (service.projectId && (!service.project?.id || service.project.id !== service.projectId)) return false;
  if (service.projectId === null && service.project) return false;
  if (service.project && !hasValidProjectContext(service.project)) return false;
  return hasConsistentClientContext({ clientId: service.clientId, client: service.client, project: service.project });
}

export function canViewClient(user: Actor, client: Pick<Client, 'salesOwnerId' | 'consultantId'>) {
  if (hasGlobalAccess(user)) return true;
  const id = getActorId(user);
  if (user.role === 'commerciale') return client.salesOwnerId === id;
  if (user.role === 'consulente') return client.consultantId === id;
  if (user.role === 'collaboratore_limitato') return client.salesOwnerId === id || client.consultantId === id;
  return ['revisore', 'backoffice', 'amministrazione'].includes(user.role);
}
export function canViewLead(user: Actor, lead: Pick<Lead, 'assignedToId'>) {
  if (hasGlobalAccess(user)) return true;
  return lead.assignedToId === null || lead.assignedToId === getActorId(user);
}
export function canViewProject(user: Actor, project: ProjectAccessContext) {
  const client = project.client;
  if (!client || !hasValidProjectContext(project)) return false;
  if (hasGlobalAccess(user)) return true;
  const id = getActorId(user);
  if (user.role === 'consulente' || user.role === 'collaboratore_limitato') return project.consultantId === id || canViewClient(user, client);
  if (user.role === 'commerciale') return canViewClient(user, client);
  return ['revisore', 'backoffice', 'amministrazione'].includes(user.role);
}
export function canViewService(user: Actor, service: ServiceAccessContext) {
  if (!hasValidServiceContext(service)) return false;
  if (hasGlobalAccess(user)) return true;
  if (service.assignedToId === getActorId(user)) return true;
  if (service.project && canViewProject(user, service.project)) return true;
  return !!service.client && canViewClient(user, service.client);
}

export function canViewClientContext(user: Actor, context: ClientScopedContext) {
  if (!hasConsistentClientContext(context) || !context.client) return false;
  if (context.project && !hasValidProjectContext(context.project)) return false;
  if (context.clientService && !hasValidServiceContext(context.clientService)) return false;
  const clientAllowed = canViewClient(user, context.client);
  const projectAllowed = context.project ? canViewProject(user, context.project) : false;
  const serviceAllowed = context.clientService ? canViewService(user, context.clientService) : false;

  if (context.clientService && context.project) {
    const serviceProjectId = context.clientService.projectId;
    const selectedProjectId = 'id' in context.project ? context.project.id : undefined;
    if (serviceProjectId && (!selectedProjectId || serviceProjectId !== selectedProjectId)) return false;
    if (!serviceProjectId) return serviceAllowed && projectAllowed;
    return serviceAllowed || projectAllowed;
  }
  if (context.clientService) return serviceAllowed;
  if (context.project) return projectAllowed;
  return clientAllowed;
}
export function canViewDocument(user: Actor, document: Pick<Document, 'clientId' | 'projectId' | 'clientServiceId' | 'uploadedById' | 'containsSensitiveData' | 'documentCategory' | 'type'> & { client?: ClientAccessContext | null; project?: ProjectAccessContext | null; clientService?: ServiceAccessContext | null }, canReadSensitive = false) {
  if (isSensitiveDocument(document) && !canReadSensitive) return false;
  if (!hasConsistentClientContext(document)) return false;
  if (document.clientId && !document.client) return false;
  if (!document.clientId && (document.projectId || document.clientServiceId || document.project || document.clientService)) return false;
  if (document.projectId && (!document.project?.id || document.project.id !== document.projectId)) return false;
  if (!document.projectId && document.project) return false;
  if (document.clientServiceId && (!document.clientService?.id || document.clientService.id !== document.clientServiceId)) return false;
  if (!document.clientServiceId && document.clientService) return false;
  if (document.projectId && document.clientService?.projectId && document.clientService.projectId !== document.projectId) return false;
  if (document.project && !hasValidProjectContext(document.project)) return false;
  if (document.clientService && !hasValidServiceContext(document.clientService)) return false;
  if (hasGlobalAccess(user)) return true;
  const id = getActorId(user);
  if (document.uploadedById === id || document.clientService?.assignedToId === id) return true;
  if (document.project && canViewProject(user, document.project)) return true;
  if (document.client && canViewClient(user, document.client)) return true;
  return ['revisore', 'backoffice', 'amministrazione'].includes(user.role) && !isSensitiveDocument(document);
}

export function canEditLead(user: Actor, lead: Pick<Lead, 'assignedToId'>) {
  if (hasGlobalAccess(user)) return true;
  if (user.role !== 'commerciale') return false;
  return lead.assignedToId === null || lead.assignedToId === getActorId(user);
}

export function canViewCommercialOffer(user: Actor, offer: CommercialOfferAccessContext) {
  if (offer.leadId && !offer.lead) return false;
  if (offer.clientId && !offer.client) return false;
  if (offer.lead?.clientId && offer.clientId && offer.lead.clientId !== offer.clientId) return false;
  if (hasGlobalAccess(user)) return true;

  const id = getActorId(user);
  if (offer.createdById === id) return true;
  if (offer.lead && canViewLead(user, offer.lead)) return true;
  return !!offer.client && canViewClient(user, offer.client);
}

export function canEditCommercialOffer(user: Actor, offer: CommercialOfferAccessContext) {
  if (offer.leadId && !offer.lead) return false;
  if (offer.clientId && !offer.client) return false;
  if (offer.lead?.clientId && offer.clientId && offer.lead.clientId !== offer.clientId) return false;
  if (hasGlobalAccess(user)) return true;

  const id = getActorId(user);
  if (offer.createdById === id) return true;
  if (user.role !== 'commerciale') return false;
  if (offer.lead && canEditLead(user, offer.lead)) return true;
  return !!offer.client && canEditClient(user, offer.client);
}

export function canEditClient(user: Actor, client: Pick<Client, 'salesOwnerId' | 'consultantId'>) {
  if (hasGlobalAccess(user)) return true;
  const id = getActorId(user);
  if (user.role === 'commerciale') return client.salesOwnerId === id;
  if (user.role === 'consulente') return client.consultantId === id;
  return false;
}

export function canEditProject(user: Actor, project: ProjectAccessContext) {
  if (!hasConsistentClientContext({ clientId: project.clientId, client: project.client })) return false;
  if (hasGlobalAccess(user)) return true;
  if (user.role !== 'consulente') return false;
  const id = getActorId(user);
  return project.consultantId === id || (!!project.client && project.client.consultantId === id);
}

export function canEditService(user: Actor, service: ServiceAccessContext) {
  if (!hasConsistentClientContext({ clientId: service.clientId, client: service.client, project: service.project })) return false;
  if (hasGlobalAccess(user)) return true;
  if (user.role === 'backoffice') return true;
  if (user.role !== 'consulente') return false;
  const id = getActorId(user);
  if (service.assignedToId === id) return true;
  return (!!service.project && canEditProject(user, service.project)) || service.client?.consultantId === id;
}

export function canAssignService(user: Actor, service: ServiceAccessContext) {
  if (!hasConsistentClientContext({ clientId: service.clientId, client: service.client, project: service.project })) return false;
  if (hasGlobalAccess(user)) return true;
  const id = getActorId(user);
  if (user.role === 'commerciale') return service.client?.salesOwnerId === id;
  if (user.role === 'consulente') {
    return service.assignedToId === id
      || (!!service.project && canEditProject(user, service.project))
      || service.client?.consultantId === id;
  }
  return false;
}

export function canEditTask(user: Actor, task: Pick<Task, 'clientId' | 'assignedToId' | 'createdById'> & {
  client?: ClientAccessContext | null;
  project?: ProjectAccessContext | null;
  clientService?: ServiceAccessContext | null;
}) {
  if (!hasConsistentClientContext(task)) return false;
  if (hasGlobalAccess(user) || user.role === 'backoffice') return true;
  if (!['commerciale', 'consulente'].includes(user.role)) return false;
  const id = getActorId(user);
  if (task.assignedToId === id || task.createdById === id) return true;
  if (task.clientService && canEditService(user, task.clientService)) return true;
  if (task.project && canEditProject(user, task.project)) return true;
  return !!task.client && canEditClient(user, task.client);
}

export function canViewTask(user: Actor, task: Pick<Task, 'clientId' | 'assignedToId' | 'createdById'> & {
  projectId?: string | null;
  clientServiceId?: string | null;
  client?: ClientAccessContext | null;
  project?: ProjectAccessContext | null;
  clientService?: ServiceAccessContext | null;
}) {
  if (!hasConsistentClientContext(task)) return false;
  if (task.clientId && !task.client) return false;
  if (!task.clientId && (task.projectId || task.clientServiceId || task.project || task.clientService)) return false;
  if (task.projectId && (!task.project?.id || task.project.id !== task.projectId)) return false;
  if (task.projectId === null && task.project) return false;
  if (task.clientServiceId && (!task.clientService?.id || task.clientService.id !== task.clientServiceId)) return false;
  if (task.clientServiceId === null && task.clientService) return false;
  if (task.projectId && task.clientService?.projectId && task.clientService.projectId !== task.projectId) return false;
  if (task.project && !hasValidProjectContext(task.project)) return false;
  if (task.clientService && !hasValidServiceContext(task.clientService)) return false;
  if (hasGlobalAccess(user)) return true;
  const id = getActorId(user);
  if (task.assignedToId === id || task.createdById === id) return true;
  if (task.clientService && canViewService(user, task.clientService)) return true;
  if (task.project && canViewProject(user, task.project)) return true;
  return !!task.client && canViewClient(user, task.client);
}

export function canEditChecklistItem(user: Actor, item: Pick<DocumentChecklistItem, 'clientId' | 'createdById' | 'updatedById'> & {
  client?: ClientAccessContext | null;
  project?: ProjectAccessContext | null;
  clientService?: ServiceAccessContext | null;
}) {
  if (!hasConsistentClientContext(item)) return false;
  if (hasGlobalAccess(user) || user.role === 'backoffice') return true;
  if (user.role !== 'consulente') return false;
  const id = getActorId(user);
  if (item.createdById === id || item.updatedById === id) return true;
  if (item.clientService && canEditService(user, item.clientService)) return true;
  if (item.project && canEditProject(user, item.project)) return true;
  return !!item.client && canEditClient(user, item.client);
}

export function canViewChecklistItem(user: Actor, item: Pick<DocumentChecklistItem, 'clientId' | 'createdById' | 'updatedById'> & {
  projectId?: string | null;
  clientServiceId?: string | null;
  client?: ClientAccessContext | null;
  project?: ProjectAccessContext | null;
  clientService?: ServiceAccessContext | null;
}) {
  if (!hasConsistentClientContext(item)) return false;
  if (!item.client) return false;
  if (item.projectId && (!item.project?.id || item.project.id !== item.projectId)) return false;
  if (item.projectId === null && item.project) return false;
  if (item.clientServiceId && (!item.clientService?.id || item.clientService.id !== item.clientServiceId)) return false;
  if (item.clientServiceId === null && item.clientService) return false;
  if (item.projectId && item.clientService?.projectId && item.clientService.projectId !== item.projectId) return false;
  if (item.project && !hasValidProjectContext(item.project)) return false;
  if (item.clientService && !hasValidServiceContext(item.clientService)) return false;
  if (hasGlobalAccess(user)) return true;
  const id = getActorId(user);
  if (item.createdById === id || item.updatedById === id) return true;
  if (item.clientService && canViewService(user, item.clientService)) return true;
  if (item.project && canViewProject(user, item.project)) return true;
  return !!item.client && canViewClient(user, item.client);
}

export function canEditDocument(user: Actor, document: Pick<Document, 'clientId' | 'uploadedById' | 'containsSensitiveData' | 'documentCategory' | 'type'> & {
  client?: ClientAccessContext | null;
  project?: ProjectAccessContext | null;
  clientService?: ServiceAccessContext | null;
}, canReadSensitive = false) {
  if (isSensitiveDocument(document) && !canReadSensitive) return false;
  if (!hasConsistentClientContext(document)) return false;
  if (hasGlobalAccess(user) || user.role === 'backoffice') return true;
  if (!['commerciale', 'consulente'].includes(user.role)) return false;
  const id = getActorId(user);
  if (document.uploadedById === id) return true;
  if (document.clientService && canEditService(user, document.clientService)) return true;
  if (document.project && canEditProject(user, document.project)) return true;
  return !!document.client && canEditClient(user, document.client);
}

export function canViewTechnicalPractice(user: Actor, practice: { commercialOwnerId?: string | null; technicalOwnerId?: string | null; client?: Pick<Client, 'salesOwnerId' | 'consultantId'> | null }) {
  if (!practice.client) return false;
  if (hasGlobalAccess(user)) return true;
  const id = getActorId(user);
  if (practice.commercialOwnerId === id || practice.technicalOwnerId === id) return true;
  if (practice.client && canViewClient(user, practice.client)) return true;
  return ['revisore', 'backoffice', 'amministrazione', 'consulente'].includes(user.role);
}

export function canEditTechnicalPractice(user: Actor, practice?: { technicalOwnerId?: string | null }) {
  if (hasGlobalAccess(user)) return true;
  if (user.role === 'backoffice') return true;
  if (user.role !== 'consulente') return false;
  const id = getActorId(user);
  return practice?.technicalOwnerId === id;
}

function hasForbiddenPhrases(value: unknown) {
  return Array.isArray(value) && value.length > 0;
}

export function hasConsistentAiContext(output: AiOutputAccessContext) {
  if (!output.run) return false;
  if ((output.clientId ?? null) !== (output.run.clientId ?? null)) return false;
  if ((output.clientServiceId ?? null) !== (output.run.clientServiceId ?? null)) return false;
  if ((output.projectId ?? null) !== (output.run.projectId ?? null)) return false;
  if (!output.clientId && (output.clientServiceId || output.projectId)) return false;
  return hasConsistentClientContext({
    clientId: output.clientId,
    client: output.client,
    project: output.project,
    clientService: output.clientService,
  });
}

export function canViewAiOutput(user: Actor, output: AiOutputAccessContext) {
  if (!hasConsistentAiContext(output)) return false;
  if (!output.clientId) return hasGlobalAccess(user);
  return canViewClientContext(user, {
    clientId: output.clientId,
    client: output.client,
    project: output.project,
    clientService: output.clientService,
  });
}

export function canReviewAiOutput(user: Actor, output: AiOutputAccessContext) {
  if (!canViewAiOutput(user, output)) return false;
  if (output.status !== 'needs_review' || output.requiresHumanReview !== true) return false;
  if (output.reviewedById || output.reviewedAt || hasForbiddenPhrases(output.forbiddenPhrases)) return false;
  return Boolean(output.run?.createdById) && output.run?.createdById !== getActorId(user);
}

export function canApproveAiOutput(user: Actor, output: AiOutputAccessContext) {
  if (!canViewAiOutput(user, output)) return false;
  if (output.status !== 'needs_review' || output.requiresHumanReview !== true) return false;
  if (!output.reviewedById || !output.reviewedAt || hasForbiddenPhrases(output.forbiddenPhrases)) return false;
  const actorId = getActorId(user);
  return Boolean(output.run?.createdById)
    && output.run?.createdById !== actorId
    && output.reviewedById !== actorId
    && output.reviewedById !== output.run?.createdById;
}
