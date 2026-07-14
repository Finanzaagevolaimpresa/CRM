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
    <PageHeader title="AI runs" description="Storico dei soli run coerenti con i fascicoli accessibili. Mostra stato runtime ed eventuale avvio dell’egress, senza esporre input o output completi." />
    <Card title="Run recenti">
      {runs.length === 0 ? <EmptyState title="Nessun run accessibile" /> : <Table
        headers={['Agente', 'Stato', 'Runtime', 'Contesto', 'Creato / terminato', 'Creato da']}
        rows={runs.map((run) => [
          agentName.get(run.agentId) ?? 'Agente non disponibile',
          <span className="grid gap-1" key="s"><StatusBadge status={run.status} /><span className="text-xs text-slate-500">{run.failureCode ?? 'nessun codice errore'}</span></span>,
          <span className="text-xs leading-5" key="runtime">{run.provider} · {run.model ?? 'modello n/d'}<br/>{run.reliabilityVersion === 1 ? `Reliability v1 · config ${run.agentConfigVersion ?? 'n/d'}` : 'run legacy'}<br/><span className={run.egressStartedAt ? 'font-bold text-fai-orange' : 'text-slate-500'}>{run.egressStartedAt ? `Egress avviato ${formatDateTime(run.egressStartedAt)}` : 'Nessun egress registrato'}</span></span>,
          run.clientId ? `Cliente ${run.clientId}${run.clientServiceId ? ' · pratica collegata' : ''}${run.projectId ? ' · progetto collegato' : ''}` : 'Run tecnico/amministrativo',
          <span key="dates">{formatDateTime(run.createdAt)}<br/><span className="text-xs text-slate-500">Fine: {formatDateTime(run.finishedAt)}</span></span>,
          run.createdById ?? 'Sistema',
        ])}
      />}
    </Card>
  </div>;
}
