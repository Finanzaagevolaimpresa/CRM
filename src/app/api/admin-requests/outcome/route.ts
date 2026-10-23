import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { readAdminRequestOutcome, isRequestUnavailable } from '@/lib/admin-request-service';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  const session = await requireSession();
  try {
    const outcome = await readAdminRequestOutcome(prisma, session, request.nextUrl.searchParams.get('commandId') ?? '');
    return NextResponse.json(outcome, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    if (isRequestUnavailable(error) || error instanceof z.ZodError) return NextResponse.json({ error: 'UNAVAILABLE' }, { status: 404, headers: { 'Cache-Control': 'private, no-store' } });
    throw error;
  }
}
