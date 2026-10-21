export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { readSharedClientDocument } from '@/lib/selective-client-access';
import { readPrivateDocumentBounded } from '@/lib/storage';

export async function GET(request: Request, { params }: { params: Promise<{ id: string; versionId: string }> }) {
  const session = await requireSession(), { id, versionId } = await params;
  const download = new URL(request.url).searchParams.get('download') === '1';
  try {
    const { bytes, document } = await readSharedClientDocument(prisma, session, id, versionId, download, readPrivateDocumentBounded);
    return new NextResponse(new Uint8Array(bytes), { headers: {
      'Content-Type': document.mimeType,
      'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(document.fileName)}`,
      'Cache-Control': 'private, no-store, max-age=0', 'Pragma': 'no-cache',
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'; frame-ancestors 'self'",
      'Referrer-Policy': 'no-referrer', 'Content-Length': String(bytes.length),
    } });
  } catch { return new NextResponse('Documento non disponibile', { status: 404, headers: { 'Cache-Control': 'private, no-store' } }); }
}
