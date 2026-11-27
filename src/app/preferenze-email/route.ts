import { prisma } from '@/lib/prisma';
import { marketingWithdrawalHandlers } from '@/lib/workflow-marketing-withdrawal';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) { return marketingWithdrawalHandlers(prisma).GET(request); }
export async function POST(request: Request) { return marketingWithdrawalHandlers(prisma).POST(request); }
