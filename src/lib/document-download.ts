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
  const document = await prisma.document.findUniqueOrThrow({ where: { id } });
  const [client, project, clientService] = await Promise.all([
    document.clientId ? prisma.client.findUnique({ where: { id: document.clientId }, select: { salesOwnerId: true, consultantId: true } }) : null,
    document.projectId ? prisma.project.findUnique({ where: { id: document.projectId }, select: { consultantId: true, clientId: true } }) : null,
    document.clientServiceId ? prisma.clientService.findUnique({ where: { id: document.clientServiceId }, select: { assignedToId: true, clientId: true, projectId: true } }) : null,
  ]);
  const [projectClient, serviceClient, serviceProject] = await Promise.all([
    project?.clientId ? prisma.client.findUnique({ where: { id: project.clientId }, select: { salesOwnerId: true, consultantId: true } }) : null,
    clientService?.clientId ? prisma.client.findUnique({ where: { id: clientService.clientId }, select: { salesOwnerId: true, consultantId: true } }) : null,
    clientService?.projectId ? prisma.project.findUnique({ where: { id: clientService.projectId }, select: { consultantId: true, clientId: true } }) : null,
  ]);
  const serviceProjectClient = serviceProject?.clientId ? await prisma.client.findUnique({ where: { id: serviceProject.clientId }, select: { salesOwnerId: true, consultantId: true } }) : null;
  const canReadSensitive = hasPermission(session, 'document.sensitive.read');
  const authorizationDocument = { ...document, client: client ?? serviceClient, project: project ? { ...project, client: projectClient } : serviceProject ? { ...serviceProject, client: serviceProjectClient } : null, clientService };
  if (!canViewDocument(session, authorizationDocument, canReadSensitive)) throw new Error('Documento non autorizzato');
  if (isSensitiveDocument(document)) await audit(session.userId, 'document_sensitive_access', 'Document', document.id, { category: document.documentCategory });
  await audit(session.userId, 'document_download', 'Document', document.id, { storagePath: document.storagePath });
  return createSignedDocumentUrl(document.storagePath);
}
