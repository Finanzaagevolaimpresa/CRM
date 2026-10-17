import { NextResponse } from 'next/server';
import { unstable_rethrow } from 'next/navigation';
import { requirePermission } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { assertOrdinaryEmailRequestOrigin } from '@/lib/ordinary-email-request-contract';
import { readStoredOrdinaryAttachment } from '@/lib/ordinary-email-attachment';

export const dynamic = 'force-dynamic';
export async function POST(request: Request, { params }: { params: Promise<{ id: string; ordinal: string }> }) {
  try {
    const session = await requirePermission('practice_communications.read');
    assertOrdinaryEmailRequestOrigin({ origin: request.headers.get('origin'), secFetchSite: request.headers.get('sec-fetch-site') }, process.env);
    const { id, ordinal } = await params, form = await request.formData();
    if (!/^(?:[0-9]|[12][0-9]|3[01])$/.test(ordinal) || [...form.keys()].length !== 2
      || form.getAll('payloadHash').length !== 1 || form.getAll('attachmentHash').length !== 1) throw new Error('INVALID');
    const file = await readStoredOrdinaryAttachment(prisma, session, { replyId: id, ordinal: Number(ordinal),
      payloadHash: form.get('payloadHash'), attachmentHash: form.get('attachmentHash') });
    return new NextResponse(new Uint8Array(file.bytes), { headers: {
      'Content-Type': 'application/octet-stream', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox allow-downloads; default-src 'none'", 'Referrer-Policy': 'no-referrer',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
      'Content-Length': String(file.bytes.length), 'Cache-Control': 'private, no-store',
    } });
  } catch (error) {
    unstable_rethrow(error);
    return new NextResponse('Allegato non disponibile. Aggiorna la pratica.', { status: 404,
      headers: { 'Cache-Control': 'private, no-store' } });
  }
}
