import type { Client, ClientService, Document, DocumentChecklistItem, Lead, Project, RoleCode, Task, User } from '@prisma/client';
import type { AuthSession } from './auth';

export type Actor = Pick<User, 'id' | 'role'> | Pick<AuthSession, 'userId' | 'role'>;
type ClientAccessContext = Pick<Client, 'id' | 'salesOwnerId' | 'consultantId'>;
type ProjectAccessContext = Pick<Project, 'clientId' | 'consultantId'> & { client?: ClientAccessContext | null };
type ServiceAccessContext = Pick<ClientService, 'clientId' | 'assignedToId'> & {
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

const actorId = (user: Actor) => 'userId' in user ? user.userId : user.id;
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

export function canViewClient(user: Actor, client: Pick<Client, 'salesOwnerId' | 'consultantId'>) {
  if (hasGlobalAccess(user)) return true;
  const id = actorId(user);
  if (user.role === 'commerciale') return client.salesOwnerId === id;
  if (user.role === 'consulente') return client.consultantId === id;
  if (user.role === 'collaboratore_limitato') return client.salesOwnerId === id || client.consultantId === id;
  return ['revisore', 'backoffice', 'amministrazione'].includes(user.role);
}
export function canViewProject(user: Actor, project: Pick<Project, 'consultantId'> & { client?: Pick<Client, 'salesOwnerId' | 'consultantId'> | null }) {
  if (hasGlobalAccess(user)) return true;
  const id = actorId(user);
  if (user.role === 'consulente' || user.role === 'collaboratore_limitato') return project.consultantId === id || (!!project.client && canViewClient(user, project.client));
  if (user.role === 'commerciale') return !!project.client && canViewClient(user, project.client);
  return ['revisore', 'backoffice', 'amministrazione'].includes(user.role);
}
export function canViewDocument(user: Actor, document: Pick<Document, 'uploadedById' | 'containsSensitiveData' | 'documentCategory' | 'type'> & { client?: Pick<Client, 'salesOwnerId' | 'consultantId'> | null; project?: (Pick<Project, 'consultantId'> & { client?: Pick<Client, 'salesOwnerId' | 'consultantId'> | null }) | null; clientService?: Pick<ClientService, 'assignedToId'> | null }, canReadSensitive = false) {
  if (isSensitiveDocument(document) && !canReadSensitive) return false;
  if (hasGlobalAccess(user)) return true;
  const id = actorId(user);
  if (document.uploadedById === id || document.clientService?.assignedToId === id) return true;
  if (document.project && canViewProject(user, document.project)) return true;
  if (document.client && canViewClient(user, document.client)) return true;
  return ['revisore', 'backoffice', 'amministrazione'].includes(user.role) && !isSensitiveDocument(document);
}

export function canEditLead(user: Actor, lead: Pick<Lead, 'assignedToId'>) {
  if (hasGlobalAccess(user)) return true;
  if (user.role !== 'commerciale') return false;
  return lead.assignedToId === null || lead.assignedToId === actorId(user);
}

export function canEditCommercialOffer(user: Actor, offer: CommercialOfferAccessContext) {
  if (offer.leadId && !offer.lead) return false;
  if (offer.clientId && !offer.client) return false;
  if (offer.lead?.clientId && offer.clientId && offer.lead.clientId !== offer.clientId) return false;
  if (hasGlobalAccess(user)) return true;

  const id = actorId(user);
  if (offer.createdById === id) return true;
  if (user.role !== 'commerciale') return false;
  if (offer.lead && canEditLead(user, offer.lead)) return true;
  return !!offer.client && canEditClient(user, offer.client);
}

export function canEditClient(user: Actor, client: Pick<Client, 'salesOwnerId' | 'consultantId'>) {
  if (hasGlobalAccess(user)) return true;
  const id = actorId(user);
  if (user.role === 'commerciale') return client.salesOwnerId === id;
  if (user.role === 'consulente') return client.consultantId === id;
  return false;
}

export function canEditProject(user: Actor, project: ProjectAccessContext) {
  if (!hasConsistentClientContext({ clientId: project.clientId, client: project.client })) return false;
  if (hasGlobalAccess(user)) return true;
  if (user.role !== 'consulente') return false;
  const id = actorId(user);
  return project.consultantId === id || (!!project.client && project.client.consultantId === id);
}

export function canEditService(user: Actor, service: ServiceAccessContext) {
  if (!hasConsistentClientContext({ clientId: service.clientId, client: service.client, project: service.project })) return false;
  if (hasGlobalAccess(user)) return true;
  if (user.role === 'backoffice') return true;
  if (user.role !== 'consulente') return false;
  const id = actorId(user);
  if (service.assignedToId === id) return true;
  return (!!service.project && canEditProject(user, service.project)) || service.client?.consultantId === id;
}

export function canAssignService(user: Actor, service: ServiceAccessContext) {
  if (!hasConsistentClientContext({ clientId: service.clientId, client: service.client, project: service.project })) return false;
  if (hasGlobalAccess(user)) return true;
  const id = actorId(user);
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
  const id = actorId(user);
  if (task.assignedToId === id || task.createdById === id) return true;
  if (task.clientService && canEditService(user, task.clientService)) return true;
  if (task.project && canEditProject(user, task.project)) return true;
  return !!task.client && canEditClient(user, task.client);
}

export function canEditChecklistItem(user: Actor, item: Pick<DocumentChecklistItem, 'clientId' | 'createdById' | 'updatedById'> & {
  client?: ClientAccessContext | null;
  project?: ProjectAccessContext | null;
  clientService?: ServiceAccessContext | null;
}) {
  if (!hasConsistentClientContext(item)) return false;
  if (hasGlobalAccess(user) || user.role === 'backoffice') return true;
  if (user.role !== 'consulente') return false;
  const id = actorId(user);
  if (item.createdById === id || item.updatedById === id) return true;
  if (item.clientService && canEditService(user, item.clientService)) return true;
  if (item.project && canEditProject(user, item.project)) return true;
  return !!item.client && canEditClient(user, item.client);
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
  const id = actorId(user);
  if (document.uploadedById === id) return true;
  if (document.clientService && canEditService(user, document.clientService)) return true;
  if (document.project && canEditProject(user, document.project)) return true;
  return !!document.client && canEditClient(user, document.client);
}

export function canViewTechnicalPractice(user: Actor, practice: { commercialOwnerId?: string | null; technicalOwnerId?: string | null; client?: Pick<Client, 'salesOwnerId' | 'consultantId'> | null }) {
  if (hasGlobalAccess(user)) return true;
  const id = actorId(user);
  if (practice.commercialOwnerId === id || practice.technicalOwnerId === id) return true;
  if (practice.client && canViewClient(user, practice.client)) return true;
  return ['revisore', 'backoffice', 'amministrazione', 'consulente'].includes(user.role);
}

export function canEditTechnicalPractice(user: Actor, practice?: { technicalOwnerId?: string | null }) {
  if (hasGlobalAccess(user)) return true;
  if (user.role === 'backoffice') return true;
  if (user.role !== 'consulente') return false;
  const id = actorId(user);
  return practice?.technicalOwnerId === id;
}
