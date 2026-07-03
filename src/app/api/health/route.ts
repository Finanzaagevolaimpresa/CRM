import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({
    ok: true,
    app: 'fai-crm',
    env: process.env.APP_ENV || process.env.NODE_ENV || 'development',
    timestamp: new Date().toISOString(),
  });
}
