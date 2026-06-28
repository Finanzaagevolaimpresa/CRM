import type { Prisma } from '@prisma/client';
import type { Session } from './session';
import { hasPermission } from './auth';
import { canViewDocument, isSensitiveDocument } from './access-control';
import { prisma } from './prisma';
import { createSignedDocumentUrl } from './storage';

async function audit(actorId: string, event: string, entityType: string, entityId?: string, after?: unknown) {
  await prisma.auditLog.create({ data: { actorId, event, entityType, entityId, after: after as Prisma.InputJsonValue } });
}

export async function createAuthorizedDocumentDownloadUrl(session: Session, id: string) {
  const document = await prisma.document.findFirstOrThrow({ where: { id, deletedAt: null } });
  const [client, project, clientService] = await Promise.all([
    document.clientId ? prisma.client.findFirst({ where: { id: document.clientId, deletedAt: null }, select: { salesOwnerId: true, consultantId: true } }) : null,
    document.projectId ? prisma.project.findFirst({ where: { id: document.projectId, deletedAt: null }, select: { consultantId: true, clientId: true } }) : null,
    document.clientServiceId ? prisma.clientService.findFirst({ where: { id: document.clientServiceId, deletedAt: null }, select: { assignedToId: true, clientId: true, projectId: true } }) : null,
  ]);
  const [projectClient, serviceClient, serviceProject] = await Promise.all([
    project?.clientId ? prisma.client.findFirst({ where: { id: project.clientId, deletedAt: null }, select: { salesOwnerId: true, consultantId: true } }) : null,
    clientService?.clientId ? prisma.client.findFirst({ where: { id: clientService.clientId, deletedAt: null }, select: { salesOwnerId: true, consultantId: true } }) : null,
    clientService?.projectId ? prisma.project.findFirst({ where: { id: clientService.projectId, deletedAt: null }, select: { consultantId: true, clientId: true } }) : null,
  ]);
  const serviceProjectClient = serviceProject?.clientId ? await prisma.client.findFirst({ where: { id: serviceProject.clientId, deletedAt: null }, select: { salesOwnerId: true, consultantId: true } }) : null;
  const canReadSensitive = hasPermission(session, 'document.sensitive.read');
  const authorizationDocument = { ...document, client: client ?? serviceClient, project: project ? { ...project, client: projectClient } : serviceProject ? { ...serviceProject, client: serviceProjectClient } : null, clientService };
  if (!canViewDocument(session, authorizationDocument, canReadSensitive)) throw new Error('Documento non autorizzato');
  if (isSensitiveDocument(document)) await audit(session.userId, 'document_sensitive_access', 'Document', document.id, { category: document.documentCategory });
  await audit(session.userId, 'document_download', 'Document', document.id, { storagePath: document.storagePath });
  return createSignedDocumentUrl(document.storagePath);
}
