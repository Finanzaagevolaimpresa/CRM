import { NextResponse } from 'next/server';
import { auditClientDossierExport } from '@/lib/actions';
import { requirePermission } from '@/lib/auth';
import { buildClientDossierDocx, buildMarkdownDocx } from '@/lib/docx-export';
import { prisma } from '@/lib/prisma';
import { getClientDossierReadAccess } from '@/lib/read-access';
import { EngagementDossierError, exportApprovedEngagementDossier } from '@/lib/engagement-dossier';

export const runtime = 'nodejs';

function safeFileName(value: string) { return value.toLowerCase().replace(/[^a-z0-9-_]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'dossier'; }

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requirePermission('dossier.read');
  const context = await getClientDossierReadAccess(session, id);
  if (!context) return new NextResponse('Not found', { status: 404 });
  const { dossier } = context;
  const client = await prisma.client.findFirst({ where: { id: dossier.clientId, deletedAt: null } });
  if (!client) return new NextResponse('Not found', { status: 404 });

  const requestedVersionId = new URL(request.url).searchParams.get('versionId') ?? '';
  if (dossier.practiceReadinessId && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestedVersionId)) return new Response('Non autorizzato', { status: 403 });
  const approvedVersion = dossier.practiceReadinessId
    ? await prisma.engagementDossierVersion.findUnique({ where: { id: requestedVersionId } })
    : null;
  if (dossier.practiceReadinessId && (!approvedVersion || approvedVersion.dossierId !== dossier.id)) return new NextResponse('Not found', { status: 404 });

  const docx = approvedVersion ? buildMarkdownDocx({
    title: approvedVersion.title,
    content: approvedVersion.content,
    exportedAt: new Date(),
  }) : buildClientDossierDocx({
    title: dossier.title,
    client: { displayName: client.displayName, type: client.type, status: client.status, notes: client.notes },
    dossierType: dossier.type,
    dossierStatus: dossier.status,
    exportedAt: new Date(),
    content: dossier.content,
  });

  if (approvedVersion) {
    try {
      await exportApprovedEngagementDossier(prisma, session, { dossierId: dossier.id, versionId: approvedVersion.id, format: 'docx' }, docx);
    } catch (error) {
      if (error instanceof EngagementDossierError) return new NextResponse('Non autorizzato', { status: 403 });
      throw error;
    }
  }
  else await auditClientDossierExport(id, 'docx');
  return new NextResponse(docx, { headers: { 'Cache-Control': 'private, no-store', 'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'Content-Disposition': `attachment; filename="${safeFileName(approvedVersion?.title ?? dossier.title)}${approvedVersion ? `-v${approvedVersion.version}` : ''}.docx"`, ...(approvedVersion ? { 'X-Dossier-Version': String(approvedVersion.version), 'X-Dossier-Content-Hash': approvedVersion.contentHash } : {}) } });
}
