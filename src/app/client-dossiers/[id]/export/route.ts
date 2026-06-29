import { NextResponse } from 'next/server';
import { auditClientDossierExport } from '@/lib/actions';
import { canViewClient } from '@/lib/access-control';
import { requirePermission } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

function safeFileName(value: string) { return value.toLowerCase().replace(/[^a-z0-9-_]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'dossier'; }

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requirePermission('dossier.read');
  const dossier = await prisma.clientDossier.findUnique({ where: { id } });
  if (!dossier) return new NextResponse('Not found', { status: 404 });
  const client = await prisma.client.findUnique({ where: { id: dossier.clientId } });
  if (!client || !canViewClient(session, client)) return new NextResponse('Forbidden', { status: 403 });
  await auditClientDossierExport(id);
  return new NextResponse(dossier.content, { headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="${safeFileName(dossier.title)}.md"` } });
}
