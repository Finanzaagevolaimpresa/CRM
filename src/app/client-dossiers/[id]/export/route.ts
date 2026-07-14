import { NextResponse } from 'next/server';
import { auditClientDossierExport } from '@/lib/actions';
import { requirePermission } from '@/lib/auth';
import { getClientDossierReadAccess } from '@/lib/read-access';

function safeFileName(value: string) { return value.toLowerCase().replace(/[^a-z0-9-_]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'dossier'; }

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requirePermission('dossier.read');
  const context = await getClientDossierReadAccess(session, id);
  if (!context) return new NextResponse('Not found', { status: 404 });
  const { dossier } = context;
  await auditClientDossierExport(id);
  return new NextResponse(dossier.content, { headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="${safeFileName(dossier.title)}.md"` } });
}
