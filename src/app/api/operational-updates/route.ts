import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { assertTechnicalFileRoute } from '@/lib/technical-server-guards';
import { readSharedOperationalPanel } from '@/lib/shared-operational-updates';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const headers = { 'Cache-Control': 'no-store, private', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff' };
export async function GET(request: NextRequest) {
  await assertTechnicalFileRoute('/api/operational-updates');
  const session = await getSession();
  if (!session) return NextResponse.json({ available: false }, { status: 401, headers });
  try {
    const panel = await readSharedOperationalPanel(prisma, session, {
      kind: request.nextUrl.searchParams.get('kind'), id: request.nextUrl.searchParams.get('id'),
    });
    return NextResponse.json({ available: true, panel }, { headers });
  } catch {
    // Identical response for missing, private, revoked and stale targets.
    return NextResponse.json({ available: false }, { status: 404, headers });
  }
}
