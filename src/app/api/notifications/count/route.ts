import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getInternalNotificationCount } from '@/lib/internal-notifications';
import { assertTechnicalFileRoute } from '@/lib/technical-server-guards';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const headers = { 'Cache-Control': 'no-store, private', Vary: 'Cookie' };
export async function GET() {
  await assertTechnicalFileRoute('/api/notifications/count');
  const session = await getSession();
  if (!session) return NextResponse.json({ count: 0 }, { status: 401, headers });
  try { return NextResponse.json({ count: await getInternalNotificationCount(session) }, { headers }); }
  catch { return NextResponse.json({ count: 0 }, { status: 503, headers }); }
}
