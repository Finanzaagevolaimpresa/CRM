import { AdminRequestQueueView } from '@/components/admin-request-queue-view';
import type { AdminRequestQueueSearch } from '@/lib/admin-request-queue-query';
export const dynamic = 'force-dynamic';

export default function Page({ searchParams }: { searchParams: Promise<AdminRequestQueueSearch> }) {
  return <AdminRequestQueueView searchParams={searchParams} />;
}
