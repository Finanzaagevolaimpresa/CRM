import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth';
import { canViewTechnicalPractice } from '@/lib/access-control';
import { prisma } from '@/lib/prisma';
import { buildMarkdownDocx } from '@/lib/docx-export';
import { buildOperationalReportMarkdown, reportFileName } from '@/lib/operational-report';
export const runtime = 'nodejs';
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission('technical.read');
  const { id } = await params;
  const practice = await prisma.technicalPractice.findUnique({ where: { id } });
  const client = practice ? await prisma.client.findUnique({ where: { id: practice.clientId } }) : null;
  if (!practice || !client || !canViewTechnicalPractice(session, { ...practice, client })) return new NextResponse('Forbidden', { status: practice ? 403 : 404 });
  const report = await buildOperationalReportMarkdown(session, { technicalPracticeId: id });
  if (!report) return new NextResponse('Report non disponibile', { status: 404 });
  const docx = buildMarkdownDocx({ title: report.title, exportedAt: new Date(), content: report.markdown });
  return new NextResponse(docx, { headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'Content-Disposition': `attachment; filename="${reportFileName(report.title)}.docx"` } });
}
