export const dynamic = 'force-dynamic';

import { SecondaryLink } from '@/components/actions';
import { Card, PageHeader, StatusBadge, TimestampMeta } from '@/components/ui';
import { requirePermission } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { getPreAnalysisReadAccess } from '@/lib/read-access';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission('dossier.read');
  const { id } = await params;
  const context = await getPreAnalysisReadAccess(session, id);
  if (!context) return <PageHeader title="Pre-analisi non trovata" description="Il record richiesto non esiste o non è accessibile." />;
  const { preAnalysis: pre } = context;
  const [client, project, reviewer, approver] = await Promise.all([
    prisma.client.findFirst({ where: { id: pre.clientId, deletedAt: null } }),
    prisma.project.findFirst({ where: { id: pre.projectId, deletedAt: null } }),
    pre.reviewedById ? prisma.user.findUnique({ where: { id: pre.reviewedById } }) : null,
    pre.approvedById ? prisma.user.findUnique({ where: { id: pre.approvedById } }) : null,
  ]);

  return <div className="space-y-6">
    <PageHeader title="Dettaglio pre-analisi" description="Bozza interna accessibile nel fascicolo autorizzato, con revisione umana obbligatoria." />
    <SecondaryLink href="/preanalyses">← Torna alla lista</SecondaryLink>
    <Card title="Dati"><p>Cliente: {client?.displayName ?? '—'}</p><p>Progetto: {project?.title ?? '—'}</p><p>Stato: <StatusBadge status={pre.status} /></p><TimestampMeta createdAt={pre.createdAt} updatedAt={pre.updatedAt} createdBy={reviewer?.name ?? pre.reviewedById} updatedBy={approver?.name ?? pre.approvedById} /></Card>
    <Card title="Contenuto"><p className="whitespace-pre-wrap text-sm text-fai-gray">{pre.internalSummary ?? 'Nessun dato presente'}</p><h3 className="mt-4 font-bold">Scenario A</h3><p>{pre.scenarioA ?? 'Nessun dato presente'}</p><h3 className="mt-4 font-bold">Scenario B</h3><p>{pre.scenarioB ?? 'Nessun dato presente'}</p><h3 className="mt-4 font-bold">Documenti richiesti</h3><p>{pre.requiredDocuments ?? 'Nessun documento collegato'}</p></Card>
  </div>;
}
