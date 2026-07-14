export const dynamic = 'force-dynamic';

import { OpenLink, SecondaryLink } from '@/components/actions';
import { Card, EmptyState, MetaCell, PageHeader, StatusBadge, Table } from '@/components/ui';
import { requirePermission } from '@/lib/auth';
import { listAccessibleAiOutputs } from '@/lib/read-access';

export default async function Page() {
  const session = await requirePermission('ai.review');
  const contexts = await listAccessibleAiOutputs(session, { orderBy: { createdAt: 'desc' }, take: 100 });
  const outputs = contexts.map((context) => context.output);
  return <div className="space-y-6"><PageHeader title="Output AI" description="Archivio interno degli output AI. Ogni contenuto richiede revisione umana e non viene inviato automaticamente al cliente."/><div className="flex flex-wrap gap-3"><SecondaryLink href="/ai/outputs-to-review">Output da revisionare</SecondaryLink><SecondaryLink href="/ai/runs">Storico run</SecondaryLink></div><Card title="Ultimi output">{outputs.length === 0 ? <EmptyState title="Nessun output AI presente">Gli output appariranno dopo l'esecuzione controllata degli agenti AI interni.</EmptyState> : <Table headers={['Titolo', 'Stato', 'Revisione umana', 'Tracciabilità', 'Azione']} rows={outputs.map((output) => [<span className="font-semibold text-fai-navy" key="t">{output.title}</span>, <StatusBadge status={output.status} key="s" />, output.requiresHumanReview ? 'Obbligatoria' : 'Non richiesta', <MetaCell key="m" createdAt={output.createdAt} updatedAt={output.updatedAt} />, <OpenLink href={`/ai/outputs/${output.id}`} key="a">Apri</OpenLink>])} />}</Card></div>;
}
