import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { requirePermission } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { isAllowedMutationOrigin } from '@/lib/application-security-policy';
import { EngagementDossierError, exportEngagementWorkPackage } from '@/lib/engagement-dossier';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isAllowedMutationOrigin({ origin: request.headers.get('origin'), secFetchSite: request.headers.get('sec-fetch-site'), configuredOrigin: process.env.APP_ORIGIN ?? process.env.NEXT_PUBLIC_APP_URL })) return new NextResponse('Non autorizzato', { status: 403 });
  const session = await requirePermission('dossier.read');
  const { id } = await params;
  if (!request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded') || !request.body) return new NextResponse('Richiesta non valida', { status: 400 });
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    bytes += next.value.length;
    if (bytes > 8192) { await reader.cancel(); return new NextResponse('Richiesta troppo grande', { status: 413 }); }
    chunks.push(next.value);
  }
  const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  try {
    const { archive, receipt } = await exportEngagementWorkPackage(prisma, session, {
      dossierId: id, expectedVersionId: form.get('expectedVersionId'), packageId: form.get('packageId'),
      manualTransferAuthorized: form.get('manualTransferAuthorized') === 'on',
    });
    return new NextResponse(new Uint8Array(archive), { headers: {
      'Cache-Control': 'private, no-store', 'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="work-${receipt.manifest.packageId}.zip"`,
      'X-Work-Package-Id': receipt.manifest.packageId, 'X-Work-Package-Sha256': receipt.artifactHash,
    } });
  } catch (error) {
    const code = error instanceof EngagementDossierError ? error.code
      : error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034' ? 'CONFLICT' : null;
    if (!code) throw error;
    return NextResponse.redirect(new URL(`/client-dossiers/${encodeURIComponent(id)}?dossierError=${code}`, request.url), 303);
  }
}
