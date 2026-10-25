import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { readTechnicalWorkDocument } from '@/lib/technical-assignment-access';
import { technicalTargetReference } from '@/lib/technical-assignment-display';
import { readPrivateDocumentBounded } from '@/lib/storage';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, { params }: { params: Promise<{ kind: string; id: string; versionId: string }> }) {
  const session = await requireSession(), p = await params;
  const download = new URL(request.url).searchParams.get('download') === '1';
  try {
    const target = technicalTargetReference.parse({ kind: p.kind === 'projects' ? 'Project' : p.kind === 'practices' ? 'TechnicalPractice' : null, targetId: p.id });
    const { bytes, document, contentType } = await readTechnicalWorkDocument(prisma, session, target, p.versionId, download, readPrivateDocumentBounded);
    return new NextResponse(new Uint8Array(bytes), { headers: { 'Content-Type': contentType,
      'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(document.fileName)}`,
      'Cache-Control': 'private, no-store, max-age=0', 'Pragma': 'no-cache', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self'; frame-ancestors 'self'",
      'Referrer-Policy': 'no-referrer', 'Content-Length': String(bytes.length) } });
  } catch { return new NextResponse('Documento non disponibile', { status: 404, headers: { 'Cache-Control': 'private, no-store' } }); }
}
