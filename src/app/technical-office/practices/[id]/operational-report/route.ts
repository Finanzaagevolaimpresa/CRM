import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth';
import { canViewTechnicalPractice } from '@/lib/access-control';
import { prisma } from '@/lib/prisma';
import { buildOperationalReportMarkdown, reportFileName } from '@/lib/operational-report';
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission('technical.read');
  const { id } = await params;
  const practice = await prisma.technicalPractice.findUnique({ where: { id } });
  const client = practice ? await prisma.client.findUnique({ where: { id: practice.clientId } }) : null;
  if (!practice || !client || !canViewTechnicalPractice(session, { ...practice, client })) return new NextResponse('Forbidden', { status: practice ? 403 : 404 });
  const report = await buildOperationalReportMarkdown(session, { technicalPracticeId: id });
  if (!report) return new NextResponse('Report non disponibile', { status: 404 });
  return new NextResponse(report.markdown, { headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="${reportFileName(report.title)}.md"` } });
}
