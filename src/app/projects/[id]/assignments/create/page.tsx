import { withTechnicalPage } from '@/lib/technical-surface-guards';
import { TechnicalPrivateItemPage } from '@/components/technical-private-item-page';
export const dynamic = 'force-dynamic';
  async function Page({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<{ privateItemDecision?: string }> }) {
  return <TechnicalPrivateItemPage target={{ kind: 'Project', targetId: (await params).id }} query={await searchParams} />;
}

export default withTechnicalPage("/projects/[id]/assignments/create", Page);
