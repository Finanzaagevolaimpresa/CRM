export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession, hasPermission } from '@/lib/auth';
import { DocumentDownloadError, readOrdinaryDocument } from '@/lib/ordinary-document-download';
import { ProjectUnavailableError } from '@/lib/project-lifecycle-lock';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const headers = { 'Cache-Control': 'private, no-store, max-age=0', 'Pragma': 'no-cache',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self'; frame-ancestors 'self'" };
  const session = await getSession();
  if (!session || !hasPermission(session, 'document.download')) return new NextResponse('Documento non disponibile', { status: 403, headers });
  const { id } = await params;
  try {
    const file = await readOrdinaryDocument(prisma, session, id, new URL(request.url).searchParams.get('versionId'), { intent: 'view' });
    return new NextResponse(file.bytes, { headers: { ...headers,
      'Content-Type': file.mimeType!, 'Content-Length': String(file.bytes.byteLength),
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    } });
  } catch (error) {
    if (error instanceof DocumentDownloadError || error instanceof ProjectUnavailableError) {
      const status = error instanceof DocumentDownloadError ? error.status : 403;
      return new NextResponse(status === 415
        ? 'Anteprima non disponibile per questo formato. Torna alla scheda e scegli Scarica. Formati visualizzabili: PDF, PNG, JPEG e testo UTF-8, fino a 25 MB.'
        : 'Documento non disponibile', { status, headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' } });
    }
    throw error;
  }
}
