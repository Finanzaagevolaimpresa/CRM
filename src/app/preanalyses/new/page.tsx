export const dynamic = 'force-dynamic';

import { SecondaryLink } from '@/components/actions';
import { PreAnalysisForm } from '@/components/preanalysis-form';
import { Card, PageHeader } from '@/components/ui';
import { requirePermission } from '@/lib/auth';
import { hasPermission } from '@/lib/auth';
import { canEditProject } from '@/lib/access-control';
import { createManualPreAnalysis } from '@/lib/form-actions';
import { prisma } from '@/lib/prisma';
import { getClientContextReadAccess } from '@/lib/read-access';

export default async function Page({ searchParams }: { searchParams: Promise<{ clientId?: string; projectId?: string }> }) {
  const session = await requirePermission('dossier.read');
  const { clientId, projectId } = await searchParams;
  if (!clientId || !projectId) return <PageHeader title="Contesto mancante" description="Apri la creazione dal fascicolo cliente o dalla scheda di un progetto." />;
  const context = await getClientContextReadAccess(session, { clientId, projectId });
  if (!context?.project) return <PageHeader title="Contesto non accessibile" description="Cliente e progetto non corrispondono oppure non appartengono al tuo perimetro." />;
  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { displayName: true } });
  const editable = hasPermission(session, 'project.write') && canEditProject(session, { ...context.project, client: context.client });
  return <div className="space-y-6">
    <PageHeader title="Nuova pre-analisi interna" description="Bozza manuale: nessuna valutazione o decisione finanziaria viene generata automaticamente." />
    <SecondaryLink href={`/projects/${projectId}`}>← Torna al progetto</SecondaryLink>
    <Card title="Contesto vincolato"><p><strong>Cliente:</strong> {client?.displayName ?? 'Cliente'}</p><p><strong>Progetto:</strong> {context.project.title}</p></Card>
    {editable ? <Card title="Contenuto della bozza"><PreAnalysisForm action={createManualPreAnalysis} creating hidden={{ clientId, projectId }} /></Card> : <Card title="Creazione non disponibile"><p className="text-sm text-slate-600">Puoi consultare questo contesto, ma il tuo profilo non è autorizzato a creare o modificare pre-analisi per il progetto.</p></Card>}
  </div>;
}
