import { NextResponse } from 'next/server';
import { unstable_rethrow } from 'next/navigation';
import { requireSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { assertOrdinaryEmailRequestOrigin } from '@/lib/ordinary-email-request-contract';
import { readCommunicationFile } from '@/lib/communication-files';

export const dynamic = 'force-dynamic';
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession();
    assertOrdinaryEmailRequestOrigin({ origin: request.headers.get('origin'), secFetchSite: request.headers.get('sec-fetch-site') }, process.env);
    const { id } = await params, form = await request.formData();
    if ([...form.keys()].length !== 3 || ['kind','contextId','sha256'].some(key => form.getAll(key).length !== 1)) throw new Error('INVALID');
    const file = await readCommunicationFile(prisma, session, { id, context: { kind: form.get('kind'), id: form.get('contextId') }, sha256: form.get('sha256') });
    return new NextResponse(new Uint8Array(file.bytes), { headers: {
      'Content-Type': 'application/octet-stream', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'", 'Referrer-Policy': 'no-referrer',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
      'Content-Length': String(file.bytes.length), 'Cache-Control': 'private, no-store',
    } });
  } catch (error) {
    unstable_rethrow(error);
    return new NextResponse('Allegato non disponibile. Aggiorna la comunicazione.', { status: 404, headers: { 'Cache-Control': 'private, no-store' } });
  }
}
