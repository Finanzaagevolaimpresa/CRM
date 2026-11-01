import { withTechnicalPage } from '@/lib/technical-surface-guards';
import { AdminRequestQueueView } from '@/components/admin-request-queue-view';
import type { AdminRequestQueueSearch } from '@/lib/admin-request-queue-query';
export const dynamic = 'force-dynamic';

  function Page({ searchParams }: { searchParams: Promise<AdminRequestQueueSearch> }) {
  return <AdminRequestQueueView searchParams={searchParams} />;
}

export default withTechnicalPage("/admin-requests", Page);
