import { canAccessFinancialDocument } from '@/lib/financial-document-access';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { hasPermission, requirePermission } from '@/lib/auth';
import { canViewDocument, isSensitiveDocument } from '@/lib/access-control';
import { privateDocumentExists, readPrivateDocument } from '@/lib/storage';
import { redactAuditPayload } from '@/lib/data-classification';
import { createHash } from 'node:crypto';
import { getEngagementMaterialDownloadAccess } from '@/lib/engagement-dossier';

async function audit(actorId: string, event: string, entityType: string, entityId?: string, after?: unknown) {
  await prisma.auditLog.create({ data: { actorId, event, entityType, entityId, after: redactAuditPayload(after) as object } });
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission('document.download');
  const { id } = await params;
  const document = await prisma.document.findFirst({ where: { id, deletedAt: null } });
  if (!document) return new NextResponse('Documento non trovato', { status: 404 });
  if (!await canAccessFinancialDocument(prisma, session, document)) return new NextResponse('Non autorizzato', { status: 403 });

  const [client, project, clientService] = await Promise.all([
    document.clientId ? prisma.client.findFirst({ where: { id: document.clientId, deletedAt: null }, select: { id: true, salesOwnerId: true, consultantId: true } }) : null,
    document.projectId ? prisma.project.findFirst({ where: { id: document.projectId, deletedAt: null }, select: { id: true, consultantId: true, clientId: true } }) : null,
    document.clientServiceId ? prisma.clientService.findFirst({ where: { id: document.clientServiceId, deletedAt: null }, select: { id: true, clientId: true, projectId: true, assignedToId: true } }) : null,
  ]);
  const [projectClient, serviceClient, serviceProject] = await Promise.all([
    project?.clientId ? prisma.client.findFirst({ where: { id: project.clientId, deletedAt: null }, select: { id: true, salesOwnerId: true, consultantId: true } }) : null,
    clientService?.clientId ? prisma.client.findFirst({ where: { id: clientService.clientId, deletedAt: null }, select: { id: true, salesOwnerId: true, consultantId: true } }) : null,
    clientService?.projectId
      ? prisma.project.findFirst({ where: { id: clientService.projectId, deletedAt: null }, select: { id: true, consultantId: true, clientId: true } })
      : null,
  ]);
  const serviceProjectClient = serviceProject?.clientId
    ? await prisma.client.findFirst({ where: { id: serviceProject.clientId, deletedAt: null }, select: { id: true, salesOwnerId: true, consultantId: true } })
    : null;
  const canReadSensitive = hasPermission(session, 'document.sensitive.read');
  const ordinaryAccess = canViewDocument(session, {
    ...document,
    client,
    project: project ? { ...project, client: projectClient } : null,
    clientService: clientService ? {
      ...clientService,
      client: serviceClient,
      project: serviceProject ? { ...serviceProject, client: serviceProjectClient } : null,
    } : null,
  }, canReadSensitive);
  const requestedVersionId = new URL(request.url).searchParams.get('versionId');
  const reviewAccess = ordinaryAccess ? null : await getEngagementMaterialDownloadAccess(prisma, session, document.id, requestedVersionId);
  if (!ordinaryAccess && !reviewAccess) return new NextResponse('Non autorizzato', { status: 403 });
  const version = ordinaryAccess && requestedVersionId
    ? await prisma.documentVersion.findFirst({ where: { id: requestedVersionId, documentId: document.id } }) : null;
  if (ordinaryAccess && requestedVersionId && !version) return new NextResponse('Documento non trovato', { status: 404 });
  const storagePath = reviewAccess?.storagePath ?? version?.storagePath ?? document.storagePath;
  const checksum = reviewAccess?.checksum ?? version?.checksum;
  if (isSensitiveDocument(document)) await audit(session.userId, 'document_sensitive_access', 'Document', document.id, { category: document.documentCategory });
  if (!(await privateDocumentExists(storagePath))) return new NextResponse('File non disponibile', { status: 404 });

  const body = await readPrivateDocument(storagePath);
  if (checksum && createHash('sha256').update(body).digest('hex') !== checksum) return new NextResponse('File non disponibile', { status: 409 });
  await audit(session.userId, 'document_download', 'Document', document.id, { fileName: document.fileName, sizeBytes: document.sizeBytes });
  return new NextResponse(body, {
    headers: {
      'Content-Type': document.mimeType || 'application/octet-stream',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(document.fileName)}`,
      'Content-Length': String(body.byteLength),
      'Cache-Control': 'private, no-store',
    },
  });
}
