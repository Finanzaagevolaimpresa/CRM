import { withTechnicalPage } from '@/lib/technical-surface-guards';
import { TechnicalAssignmentManagementPage } from '@/components/technical-assignment-management-page';
export const dynamic = 'force-dynamic';
  async function Page({ params, searchParams }: { params: Promise<{ id: string }>;
  searchParams: Promise<{ recipient?: string; assignmentDecision?: string }> }) {
  return <TechnicalAssignmentManagementPage target={{ kind: 'TechnicalPractice', targetId: (await params).id }} query={await searchParams} />;
}

export default withTechnicalPage("/technical-office/practices/[id]/assignments", Page);
