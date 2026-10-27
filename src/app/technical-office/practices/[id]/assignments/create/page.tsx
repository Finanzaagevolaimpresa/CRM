import { TechnicalPrivateItemPage } from '@/components/technical-private-item-page';
export const dynamic = 'force-dynamic';
export default async function Page({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<{ privateItemDecision?: string }> }) {
  return <TechnicalPrivateItemPage target={{ kind: 'TechnicalPractice', targetId: (await params).id }} query={await searchParams} />;
}
