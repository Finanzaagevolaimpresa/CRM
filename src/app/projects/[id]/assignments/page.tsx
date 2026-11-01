import { withTechnicalPage } from '@/lib/technical-surface-guards';
import { TechnicalAssignmentManagementPage } from '@/components/technical-assignment-management-page';
export const dynamic = 'force-dynamic';
  async function Page({ params, searchParams }: { params: Promise<{ id: string }>;
  searchParams: Promise<{ recipient?: string; assignmentDecision?: string }> }) {
  return <TechnicalAssignmentManagementPage target={{ kind: 'Project', targetId: (await params).id }} query={await searchParams} />;
}

export default withTechnicalPage("/projects/[id]/assignments", Page);
