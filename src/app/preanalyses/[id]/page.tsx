export const dynamic = 'force-dynamic';

import { SecondaryLink } from '@/components/actions';
import { PreAnalysisForm } from '@/components/preanalysis-form';
import { Card, PageHeader, StatusBadge, TimestampMeta } from '@/components/ui';
import { hasPermission, requirePermission } from '@/lib/auth';
import { updateManualPreAnalysis } from '@/lib/form-actions';
import { prisma } from '@/lib/prisma';
import { getPreAnalysisReadAccess } from '@/lib/read-access';
import { isEditableManualPreAnalysis } from '@/lib/preanalysis-policy';
import { canEditProject } from '@/lib/access-control';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission('dossier.read');
  const { id } = await params;
  const context = await getPreAnalysisReadAccess(session, id);
  if (!context) return <PageHeader title="Pre-analisi non trovata" description="Il record richiesto non esiste o non è accessibile." />;
  const { preAnalysis: pre } = context;
  const editable = hasPermission(session, 'project.write') && Boolean(context.project) && canEditProject(session, { ...context.project!, client: context.client }) && isEditableManualPreAnalysis(pre);
  const [client, project, reviewer, approver] = await Promise.all([
    prisma.client.findFirst({ where: { id: pre.clientId, deletedAt: null } }),
    prisma.project.findFirst({ where: { id: pre.projectId, deletedAt: null } }),
    pre.reviewedById ? prisma.user.findUnique({ where: { id: pre.reviewedById } }) : null,
    pre.approvedById ? prisma.user.findUnique({ where: { id: pre.approvedById } }) : null,
  ]);

  return <div className="space-y-6">
    <PageHeader title="Dettaglio pre-analisi" description="Bozza interna accessibile nel fascicolo autorizzato, con revisione umana obbligatoria." />
    <div className="flex flex-wrap gap-3"><SecondaryLink href={`/clients/${pre.clientId}#pre-analisi`}>← Torna al fascicolo cliente</SecondaryLink><SecondaryLink href={`/projects/${pre.projectId}`}>Torna al progetto</SecondaryLink></div>
    <Card title="Dati"><p>Cliente: {client?.displayName ?? '—'}</p><p>Progetto: {project?.title ?? '—'}</p><p>Stato: <StatusBadge status={pre.status} /></p><TimestampMeta createdAt={pre.createdAt} updatedAt={pre.updatedAt} createdBy={reviewer?.name ?? pre.reviewedById} updatedBy={approver?.name ?? pre.approvedById} /></Card>
    {editable ? <Card title="Bozza interna modificabile"><PreAnalysisForm action={updateManualPreAnalysis} hidden={{ id: pre.id, version: pre.updatedAt.toISOString() }} values={pre} /></Card> : <Card title="Contenuto in sola lettura"><p className="mb-4 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">Questa pre-analisi non è una bozza manuale non revisionata e non può essere modificata in questo percorso.</p><p className="whitespace-pre-wrap text-sm text-fai-gray"><strong>Sintesi interna</strong><br/>{pre.internalSummary ?? 'Nessun dato presente'}</p><h3 className="mt-4 font-bold">Scenario A</h3><p className="whitespace-pre-wrap">{pre.scenarioA ?? 'Nessun dato presente'}</p><h3 className="mt-4 font-bold">Scenario B</h3><p className="whitespace-pre-wrap">{pre.scenarioB ?? 'Nessun dato presente'}</p><h3 className="mt-4 font-bold">Condizioni bloccanti</h3><p className="whitespace-pre-wrap">{pre.blockingConditions ?? 'Nessun dato presente'}</p><h3 className="mt-4 font-bold">Documenti richiesti</h3><p className="whitespace-pre-wrap">{pre.requiredDocuments ?? 'Nessun dato presente'}</p></Card>}
  </div>;
}
