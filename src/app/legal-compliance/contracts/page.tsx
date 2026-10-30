import Contracts from '@/app/contracts/page';
import { requirePermission } from '@/lib/auth';
export const dynamic = 'force-dynamic';
export default async function Page() { await requirePermission('legal.read'); return Contracts(); }
