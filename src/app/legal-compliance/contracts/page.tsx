import { withTechnicalPage } from '@/lib/technical-surface-guards';
import Contracts from '@/app/contracts/page';
import { requirePermission } from '@/lib/auth';
export const dynamic = 'force-dynamic';
  async function Page() { await requirePermission('legal.read'); return Contracts({}); }

export default withTechnicalPage("/legal-compliance/contracts", Page);
