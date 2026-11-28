import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { cancelGoogleCalendarConnection, completeGoogleCalendarConnection } from '@/lib/google-calendar-oauth';
import { assertTechnicalFileRoute } from '@/lib/technical-server-guards';
import { isAllowedMutationOrigin } from '@/lib/application-security-policy';
import { calendarCallbackBridge, calendarCallbackFailure, calendarCallbackPath, parseCalendarCallback, readCalendarCallbackForm } from '@/lib/google-calendar-callback';

export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  try {
    await assertTechnicalFileRoute('/settings/integrations/google-calendar/callback');
    const input = parseCalendarCallback(request.nextUrl.searchParams, 'query');
    return input ? calendarCallbackBridge(input) : calendarCallbackFailure();
  } catch { return calendarCallbackFailure(403); }
}

export async function POST(request: NextRequest) {
  try {
    await assertTechnicalFileRoute('/settings/integrations/google-calendar/callback');
    if (!isAllowedMutationOrigin({ origin: request.headers.get('origin'), configuredOrigin: process.env.APP_ORIGIN,
      secFetchSite: request.headers.get('sec-fetch-site') })) return calendarCallbackFailure(403);
    if (request.nextUrl.pathname !== calendarCallbackPath || request.nextUrl.search) return calendarCallbackFailure();
    const actor = await getSession();
    if (!actor) return calendarCallbackFailure(401, 'session');
    const input = await readCalendarCallbackForm(request);
    if (!input) return calendarCallbackFailure();
    if ('cancelled' in input) {
      await cancelGoogleCalendarConnection(prisma, actor, input.state);
      return calendarCallbackFailure(400, 'cancelled');
    }
    await completeGoogleCalendarConnection(prisma, actor, input);
    const response = NextResponse.redirect(new URL('/calendars?connection=connected', process.env.APP_ORIGIN), 303);
    response.headers.set('Cache-Control', 'no-store, private'); response.headers.set('Referrer-Policy', 'no-referrer');
    return response;
  } catch { return calendarCallbackFailure(403); } // Never reflect provider/authentication error details.
}
