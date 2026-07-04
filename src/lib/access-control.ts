import type { Client, ClientService, Document, Project, RoleCode, User } from '@prisma/client';
import type { AuthSession } from './auth';

export type Actor = Pick<User, 'id' | 'role'> | Pick<AuthSession, 'userId' | 'role'>;
const actorId = (user: Actor) => 'userId' in user ? user.userId : user.id;
export const allAccessRoles: RoleCode[] = ['admin', 'direzione'];
export const sensitiveDocumentCategories = ['CRIF', 'Centrale Rischi', 'documenti identità', 'dichiarazioni fiscali', 'bilanci', 'estratti conto', 'contratti', 'contabili pagamento'];
export function isSensitiveDocument(document: Pick<Document, 'containsSensitiveData' | 'documentCategory' | 'type'>) {
  const category = `${document.documentCategory} ${document.type}`.toLowerCase();
  return document.containsSensitiveData || sensitiveDocumentCategories.some((item) => category.includes(item.toLowerCase()));
}
export function hasGlobalAccess(user: Actor) { return allAccessRoles.includes(user.role); }
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
export function canEditService(user: Actor, service: Pick<ClientService, 'assignedToId'> & { client?: Pick<Client, 'salesOwnerId' | 'consultantId'> | null; project?: Pick<Project, 'consultantId'> | null }) {
  if (hasGlobalAccess(user)) return true;
  const id = actorId(user);
  if (service.assignedToId === id) return true;
  if (user.role === 'consulente') return service.project?.consultantId === id || service.client?.consultantId === id;
  return false;
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
  const id = actorId(user);
  return ['backoffice', 'consulente'].includes(user.role) || practice?.technicalOwnerId === id;
}
