export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { readPreviewSelectiveDocument } from '@/lib/selective-project-access';
import { readPrivateDocumentBounded } from '@/lib/storage';
import { isAllowedMutationOrigin } from '@/lib/application-security-policy';

export async function POST(request: Request) {
  const session = await requireSession();
  if (!isAllowedMutationOrigin({ origin: request.headers.get('origin'), secFetchSite: request.headers.get('sec-fetch-site'), configuredOrigin: process.env.APP_ORIGIN ?? process.env.NEXT_PUBLIC_APP_URL })) {
    return new NextResponse('Non autorizzato', { status: 403 });
  }
  try {
    const form = await request.formData();
    const { bytes, document } = await readPreviewSelectiveDocument(prisma, session, String(form.get('token') ?? ''), String(form.get('versionId') ?? ''), readPrivateDocumentBounded);
    return new NextResponse(new Uint8Array(bytes), { headers: {
      'Content-Type': document.mimeType, 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(document.fileName)}`,
      'Cache-Control': 'private, no-store, max-age=0', 'Pragma': 'no-cache', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'; frame-ancestors 'self'", 'Referrer-Policy': 'no-referrer',
    } });
  } catch { return new NextResponse('Anteprima non disponibile', { status: 404, headers: { 'Cache-Control': 'private, no-store' } }); }
}
