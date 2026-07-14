export const dynamic = 'force-dynamic';

import { DisabledAction, Hint, SecondaryLink } from '@/components/actions';
import { Card, PageHeader, StatusBadge, TimestampMeta } from '@/components/ui';
import { requirePermission } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { getLegacyDossierReadAccess } from '@/lib/read-access';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission('dossier.read');
  const { id } = await params;
  const context = await getLegacyDossierReadAccess(session, id);
  if (!context) return <PageHeader title="Dossier non trovato" description="Il record richiesto non esiste o non è accessibile." />;
  const { dossier } = context;
  const [client, project, modifier, reviewer] = await Promise.all([
    prisma.client.findFirst({ where: { id: dossier.clientId, deletedAt: null } }),
    prisma.project.findFirst({ where: { id: dossier.projectId, deletedAt: null } }),
    dossier.modifiedById ? prisma.user.findUnique({ where: { id: dossier.modifiedById } }) : null,
    dossier.reviewedById ? prisma.user.findUnique({ where: { id: dossier.reviewedById } }) : null,
  ]);

  return <div className="space-y-6">
    <PageHeader title={`Dossier — ${dossier.title}`} description="Contenuto interno del dossier nel perimetro cliente/progetto autorizzato." />
    <div className="flex flex-wrap gap-3"><SecondaryLink href="/dossiers">← Torna alla lista</SecondaryLink><DisabledAction>Export PDF</DisabledAction><DisabledAction>Export DOCX</DisabledAction></div>
    <Hint>Funzione prevista, non ancora attiva nel MVP: gli export non vengono generati automaticamente.</Hint>
    <Card title="Dati"><p>Cliente: {client?.displayName ?? '—'}</p><p>Progetto: {project?.title ?? '—'}</p><p>Tipo: {dossier.type}</p><p>Versione: {dossier.version}</p><p>Stato: <StatusBadge status={dossier.status} /></p><TimestampMeta createdAt={dossier.createdAt} updatedAt={dossier.updatedAt} createdBy={modifier?.name ?? dossier.modifiedById} updatedBy={reviewer?.name ?? dossier.reviewedById} /></Card>
    <Card title="Contenuto"><div className="whitespace-pre-wrap text-sm text-fai-gray">{dossier.markdownContent ?? 'Nessun dato presente'}</div></Card>
  </div>;
}
