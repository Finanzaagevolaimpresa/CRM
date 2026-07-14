export const dynamic = 'force-dynamic';

import { OpenLink, SecondaryLink } from '@/components/actions';
import { Card, EmptyState, MetaCell, PageHeader, StatusBadge, Table } from '@/components/ui';
import { requirePermission } from '@/lib/auth';
import { canViewAiRecord } from '@/lib/access-control';
import { prisma } from '@/lib/prisma';

export default async function Page() {
  const session = await requirePermission('ai.review');
  const outputs = await prisma.aiOutput.findMany({ orderBy: { createdAt: 'desc' }, take: 100 });
  const runs = outputs.length ? await prisma.aiRun.findMany({ where: { id: { in: outputs.map((output) => output.aiRunId) } } }) : [];
  const clients = await prisma.client.findMany({ where: { id: { in: outputs.map((output) => output.clientId).filter((id): id is string => Boolean(id)) } } });
  const projects = await prisma.project.findMany({ where: { id: { in: outputs.map((output) => output.projectId).filter((id): id is string => Boolean(id)) } } });
  const clientsById = new Map(clients.map((client) => [client.id, client]));
  const projectsById = new Map(projects.map((project) => [project.id, { ...project, client: clientsById.get(project.clientId) ?? null }]));
  const runsById = new Map(runs.map((run) => [run.id, run]));
  const visibleOutputs = outputs.filter((output) => canViewAiRecord(session, { createdById: runsById.get(output.aiRunId)?.createdById, client: output.clientId ? clientsById.get(output.clientId) : null, project: output.projectId ? projectsById.get(output.projectId) : null }));
  return <div className="space-y-6"><PageHeader title="Output AI" description="Archivio interno degli output AI. Ogni contenuto richiede revisione umana e non viene inviato automaticamente al cliente."/><div className="flex flex-wrap gap-3"><SecondaryLink href="/ai/outputs-to-review">Output da revisionare</SecondaryLink><SecondaryLink href="/ai/runs">Storico run</SecondaryLink></div><Card title="Ultimi output">{visibleOutputs.length === 0 ? <EmptyState title="Nessun output AI presente">Gli output appariranno dopo l'esecuzione controllata degli agenti AI interni.</EmptyState> : <Table headers={['Titolo', 'Stato', 'Revisione umana', 'Tracciabilità', 'Azione']} rows={visibleOutputs.map((output) => [<span className="font-semibold text-fai-navy" key="t">{output.title}</span>, <StatusBadge status={output.status} key="s" />, output.requiresHumanReview ? 'Obbligatoria' : 'Non richiesta', <MetaCell key="m" createdAt={output.createdAt} updatedAt={output.updatedAt} />, <OpenLink href={`/ai/outputs/${output.id}`} key="a">Apri</OpenLink>])} />}</Card></div>;
}
