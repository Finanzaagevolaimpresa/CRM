import { AdminRequestQueueView } from '@/components/admin-request-queue-view';
import { requirePermission } from '@/lib/auth';
import type { AdminRequestQueueSearch } from '@/lib/admin-request-queue-query';
export const dynamic = 'force-dynamic';

export default async function Page({ searchParams }: { searchParams: Promise<AdminRequestQueueSearch> }) {
  await requirePermission('technical.read');
  return <AdminRequestQueueView searchParams={searchParams} integrations />;
}
