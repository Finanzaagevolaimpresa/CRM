import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession, hasPermission } from '@/lib/auth';
import { DocumentDownloadError, readOrdinaryDocument } from '@/lib/ordinary-document-download';
import { ProjectUnavailableError } from '@/lib/project-lifecycle-lock';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session || !hasPermission(session, 'document.download')) return new NextResponse('Documento non disponibile', {
    status: 403, headers: { 'Cache-Control': 'private, no-store' },
  });
  const { id } = await params;
  try {
    const file = await readOrdinaryDocument(prisma, session, id, new URL(request.url).searchParams.get('versionId'));
    return new NextResponse(file.bytes, { headers: {
      'Content-Type': file.mimeType || 'application/octet-stream',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
      'Content-Length': String(file.bytes.byteLength), 'Cache-Control': 'private, no-store',
    } });
  } catch (error) {
    if (error instanceof DocumentDownloadError || error instanceof ProjectUnavailableError) {
      return new NextResponse('Documento non disponibile', { status: error instanceof DocumentDownloadError ? error.status : 403,
        headers: { 'Cache-Control': 'private, no-store' } });
    }
    throw error;
  }
}
