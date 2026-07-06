import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth';
import { canViewClient } from '@/lib/access-control';
import { prisma } from '@/lib/prisma';
import { buildOperationalReportMarkdown, reportFileName } from '@/lib/operational-report';

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission('client.read');
  const { id } = await params;
  const client = await prisma.client.findUnique({ where: { id } });
  if (!client || !canViewClient(session, client)) return new NextResponse('Forbidden', { status: client ? 403 : 404 });
  const report = await buildOperationalReportMarkdown(session, { clientId: id });
  if (!report) return new NextResponse('Report non disponibile', { status: 404 });
  return new NextResponse(report.markdown, { headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="${reportFileName(report.title)}.md"` } });
}
