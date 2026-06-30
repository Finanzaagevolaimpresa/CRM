import { NextResponse } from 'next/server';
import { auditClientDossierExport } from '@/lib/actions';
import { canViewClient } from '@/lib/access-control';
import { requirePermission } from '@/lib/auth';
import { buildClientDossierDocx } from '@/lib/docx-export';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';

function safeFileName(value: string) { return value.toLowerCase().replace(/[^a-z0-9-_]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'dossier'; }

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requirePermission('dossier.read');
  const dossier = await prisma.clientDossier.findUnique({ where: { id } });
  if (!dossier) return new NextResponse('Not found', { status: 404 });
  const client = await prisma.client.findUnique({ where: { id: dossier.clientId } });
  if (!client || !canViewClient(session, client)) return new NextResponse('Forbidden', { status: 403 });

  const docx = buildClientDossierDocx({
    title: dossier.title,
    client: { displayName: client.displayName, type: client.type, status: client.status, notes: client.notes },
    dossierType: dossier.type,
    dossierStatus: dossier.status,
    exportedAt: new Date(),
    content: dossier.content,
  });

  await auditClientDossierExport(id, 'docx');
  return new NextResponse(docx, { headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'Content-Disposition': `attachment; filename="${safeFileName(dossier.title)}.docx"` } });
}
