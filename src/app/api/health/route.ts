import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

type HealthStatus = 'ok' | 'degraded';

export async function GET() {
  const timestamp = new Date().toISOString();
  let databaseReachable = false;

  try {
    await prisma.$queryRaw`SELECT 1`;
    databaseReachable = true;
  } catch {
    databaseReachable = false;
  }

  const status: HealthStatus = databaseReachable ? 'ok' : 'degraded';

  return NextResponse.json(
    {
      ok: databaseReachable,
      status,
      app: 'fai-crm',
      database: { reachable: databaseReachable },
      timestamp,
    },
    { status: databaseReachable ? 200 : 503 },
  );
}
