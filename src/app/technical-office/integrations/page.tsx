import { withTechnicalPage } from '@/lib/technical-surface-guards';
import { AdminRequestQueueView } from '@/components/admin-request-queue-view';
import { requirePermission } from '@/lib/auth';
import type { AdminRequestQueueSearch } from '@/lib/admin-request-queue-query';
export const dynamic = 'force-dynamic';

  async function Page({ searchParams }: { searchParams: Promise<AdminRequestQueueSearch> }) {
  await requirePermission('technical.read');
  return <AdminRequestQueueView searchParams={searchParams} integrations />;
}

export default withTechnicalPage("/technical-office/integrations", Page);
