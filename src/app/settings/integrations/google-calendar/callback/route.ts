import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { completeGoogleCalendarConnection } from '@/lib/google-calendar-oauth';
import { assertTechnicalFileRoute } from '@/lib/technical-server-guards';

export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  await assertTechnicalFileRoute('/settings/integrations/google-calendar/callback');
  const actor = await requireSession();
  let status = 'error';
  try {
    if (!request.nextUrl.searchParams.has('error')) {
      await completeGoogleCalendarConnection(prisma, actor, { state: request.nextUrl.searchParams.get('state'), code: request.nextUrl.searchParams.get('code') });
      status = 'connected';
    }
  } catch { /* Codes, tokens and provider error bodies never enter redirects/logs. */ }
  const response = NextResponse.redirect(new URL('/calendars?connection=' + status, request.url), 303);
  response.headers.set('Cache-Control', 'no-store, private'); response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}
