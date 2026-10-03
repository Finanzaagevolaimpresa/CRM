import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { isAllowedMutationOrigin } from '@/lib/application-security-policy';
import { prepareManualMessage } from '@/lib/approved-communications';
import { ApprovedCommunicationError } from '@/lib/approved-communication-contract';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isAllowedMutationOrigin({ origin: request.headers.get('origin'), secFetchSite: request.headers.get('sec-fetch-site'),
    configuredOrigin: process.env.APP_ORIGIN ?? process.env.NEXT_PUBLIC_APP_URL })) return new NextResponse('Operazione non autorizzata.', { status: 403 });
  const session = await getSession();
  if (!session) return new NextResponse('Accesso richiesto.', { status: 401 });
  try {
    const { id } = await params;
    const form = await request.formData();
    const result = await prepareManualMessage(prisma, session, { messageId: id, expectedRevision: Number(form.get('expectedRevision')),
      snapshotHash: String(form.get('snapshotHash') ?? ''), requestId: String(form.get('requestId') ?? '') });
    return new NextResponse(new Uint8Array(result.bytes), { headers: { 'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="messaggio-approvato-${id}.zip"`, 'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff', 'X-FAI-Artifact-SHA256': result.artifactHash, 'X-FAI-Manual-Attempt': result.attemptId } });
  } catch (error) {
    if (!(error instanceof ApprovedCommunicationError)) throw error;
    return new NextResponse(error.code === 'RECONCILIATION_REQUIRED' ? 'Tentativo già aperto: registra o riconcilia l’esito.'
      : 'Versione, approvazione, mittente o accesso non più validi. Aggiorna la pratica.', { status: 409, headers: { 'Cache-Control': 'no-store' } });
  }
}
