export const dynamic = 'force-dynamic';

import { PrimaryButton } from '@/components/actions';
import { Card, EmptyState, PageHeader, StatusBadge, Table, formatDateTime } from '@/components/ui';
import { canViewAiRecord } from '@/lib/access-control';
import { requirePermission, hasPermission } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { approveAiOutputAndRefresh } from '@/lib/form-actions';

export default async function Page() {
  const session = await requirePermission('ai.review');
  const canApprove = hasPermission(session, 'ai.approve');
  const outputs = await prisma.aiOutput.findMany({
    where: { status: { in: ['needs_review', 'flagged'] } },
    orderBy: { createdAt: 'desc' },
  });
  const runs = outputs.length ? await prisma.aiRun.findMany({ where: { id: { in: outputs.map((output) => output.aiRunId) } } }) : [];
  const clients = await prisma.client.findMany({ where: { id: { in: outputs.map((output) => output.clientId).filter((id): id is string => Boolean(id)) } } });
  const projects = await prisma.project.findMany({ where: { id: { in: outputs.map((output) => output.projectId).filter((id): id is string => Boolean(id)) } } });
  const clientsById = new Map(clients.map((client) => [client.id, client]));
  const projectsById = new Map(projects.map((project) => [project.id, { ...project, client: clientsById.get(project.clientId) ?? null }]));
  const runsById = new Map(runs.map((run) => [run.id, run]));
  const visibleOutputs = outputs.filter((output) => canViewAiRecord(session, {
    createdById: runsById.get(output.aiRunId)?.createdById,
    client: output.clientId ? clientsById.get(output.clientId) : null,
    project: output.projectId ? projectsById.get(output.projectId) : null,
  }));

  return (
    <div className="space-y-6">
      <PageHeader title="Output AI da revisionare" description="Coda di controllo umano: nessun output AI è approvato o inviabile finché non risulta approvato internamente." />
      <Card title="Coda revisione">
        {visibleOutputs.length === 0 ? (
          <EmptyState title="Nessun output in attesa">Tutti gli output AI risultano già gestiti o archiviati.</EmptyState>
        ) : (
          <Table headers={['Titolo', 'Stato', 'Warning', 'Revisione umana', 'Creato il', 'Azione']} rows={visibleOutputs.map((o) => [
            o.title,
            <StatusBadge status={o.status} key="s" />,
            o.status === 'flagged' ? '⚠️ Contiene frasi vietate o elementi da verificare' : '—',
            o.requiresHumanReview ? 'Obbligatoria' : 'Non richiesta',
            formatDateTime(o.createdAt),
            canApprove ? <form action={approveAiOutputAndRefresh} key="a"><input type="hidden" name="id" value={o.id} /><PrimaryButton type="submit" disabled={o.status === 'flagged'}>Approva</PrimaryButton></form> : <span key="n" className="text-xs text-fai-gray">Permesso ai.approve richiesto</span>,
          ])} />
        )}
      </Card>
    </div>
  );
}
