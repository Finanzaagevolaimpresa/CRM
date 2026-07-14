export const dynamic = 'force-dynamic';

import { Card, EmptyState, PageHeader, StatusBadge, Table, formatDateTime } from '@/components/ui';
import { requirePermission } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { listAccessibleAiRuns } from '@/lib/read-access';

export default async function Page() {
  const session = await requirePermission('ai.review');
  const runs = await listAccessibleAiRuns(session, 100);
  const agents = runs.length
    ? await prisma.aiAgent.findMany({ where: { id: { in: [...new Set(runs.map((run) => run.agentId))] } } })
    : [];
  const agentName = new Map(agents.map((agent) => [agent.id, agent.name]));

  return <div className="space-y-6">
    <PageHeader title="AI runs" description="Storico dei soli run coerenti con i fascicoli accessibili. Input e output completi non vengono esposti in questa lista." />
    <Card title="Run recenti">
      {runs.length === 0 ? <EmptyState title="Nessun run accessibile" /> : <Table
        headers={['Agente', 'Stato', 'Contesto', 'Creato il', 'Creato da']}
        rows={runs.map((run) => [
          agentName.get(run.agentId) ?? 'Agente non disponibile',
          <StatusBadge status={run.status} key="s" />,
          run.clientId ? `Cliente ${run.clientId}${run.clientServiceId ? ' · pratica collegata' : ''}${run.projectId ? ' · progetto collegato' : ''}` : 'Quick-run mock amministrativo',
          formatDateTime(run.createdAt),
          run.createdById ?? 'Sistema',
        ])}
      />}
    </Card>
  </div>;
}
