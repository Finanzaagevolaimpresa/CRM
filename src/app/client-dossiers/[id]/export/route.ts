import { NextResponse } from 'next/server';
import { auditClientDossierExport } from '@/lib/actions';
import { requirePermission } from '@/lib/auth';
import { getClientDossierReadAccess } from '@/lib/read-access';
import { EngagementDossierError, exportApprovedEngagementDossier } from '@/lib/engagement-dossier';
import { prisma } from '@/lib/prisma';

function safeFileName(value: string) { return value.toLowerCase().replace(/[^a-z0-9-_]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'dossier'; }

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requirePermission('dossier.read');
  const context = await getClientDossierReadAccess(session, id);
  if (!context) return new NextResponse('Not found', { status: 404 });
  const { dossier } = context;
  if (dossier.practiceReadinessId) {
    const versionId = new URL(request.url).searchParams.get('versionId') ?? '';
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(versionId)) return new Response('Non autorizzato', { status: 403 });
    const version = await prisma.engagementDossierVersion.findUnique({ where: { id: versionId } });
    if (!version || version.dossierId !== dossier.id) return new NextResponse('Not found', { status: 404 });
    try {
      await exportApprovedEngagementDossier(prisma, session, { dossierId: dossier.id, versionId, format: 'markdown' }, version.content);
    } catch (error) {
      if (error instanceof EngagementDossierError) return new NextResponse('Non autorizzato', { status: 403 });
      throw error;
    }
    return new NextResponse(version.content, { headers: { 'Cache-Control': 'private, no-store', 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="${safeFileName(version.title)}-v${version.version}.md"`, 'X-Dossier-Version': String(version.version), 'X-Dossier-Content-Hash': version.contentHash } });
  }
  await auditClientDossierExport(id);
  return new NextResponse(dossier.content, { headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="${safeFileName(dossier.title)}.md"` } });
}
