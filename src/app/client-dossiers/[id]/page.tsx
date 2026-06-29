export const dynamic = 'force-dynamic';

import { Card, EmptyState, PageHeader, StatusBadge, TimestampMeta } from '@/components/ui';
import { DisabledAction, PrimaryButton, SecondaryLink } from '@/components/actions';
import { archiveClientDossierAndRefresh, updateClientDossierAndRefresh } from '@/lib/form-actions';
import { hasPermission, requirePermission } from '@/lib/auth';
import { canViewClient } from '@/lib/access-control';
import { prisma } from '@/lib/prisma';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requirePermission('dossier.read');
  const dossier = await prisma.clientDossier.findUnique({ where: { id } });
  if (!dossier) return <PageHeader title="Bozza dossier non trovata" description="Il record richiesto non esiste o non è più disponibile." />;
  const [client, service, project, creator, updater] = await Promise.all([
    prisma.client.findUnique({ where: { id: dossier.clientId } }),
    dossier.clientServiceId ? prisma.clientService.findUnique({ where: { id: dossier.clientServiceId } }) : null,
    dossier.projectId ? prisma.project.findUnique({ where: { id: dossier.projectId } }) : null,
    prisma.user.findUnique({ where: { id: dossier.createdById } }),
    dossier.updatedById ? prisma.user.findUnique({ where: { id: dossier.updatedById } }) : null,
  ]);
  if (!client || !canViewClient(session, client)) return <h1 className="text-3xl font-bold text-fai-navy">Dossier non accessibile</h1>;
  const canWrite = hasPermission(session, 'dossier.write');

  return <div className="space-y-6">
    <PageHeader title={`Dossier / Pre-analisi — ${dossier.title}`} description="Bozza interna salvata nel CRM. Il contenuto è modificabile manualmente e non espone percorsi di storage privati." />
    <div className="flex flex-wrap gap-3"><SecondaryLink href={`/clients/${dossier.clientId}#dossier`}>← Torna al fascicolo cliente</SecondaryLink><SecondaryLink href={`/client-dossiers/${dossier.id}/export`}>Esporta .md</SecondaryLink></div>
    <Card title="Dati bozza">
      <p>Cliente: {client.displayName}</p>
      <p>Servizio/pratica: {service?.practiceType ?? service?.id ?? 'Fascicolo generale'}</p>
      <p>Progetto: {project?.title ?? '—'}</p>
      <p>Tipo: {dossier.type.replaceAll('_', ' ')}</p>
      <p>Stato: <StatusBadge status={dossier.status} /></p>
      <TimestampMeta createdAt={dossier.createdAt} updatedAt={dossier.updatedAt} createdBy={creator?.name ?? dossier.createdById} updatedBy={updater?.name ?? dossier.updatedById} />
    </Card>
    {canWrite ? <Card title="Modifica manuale contenuto">
      <form action={updateClientDossierAndRefresh} className="grid gap-3">
        <input type="hidden" name="id" value={dossier.id} />
        <input className="rounded-xl border p-3" name="title" defaultValue={dossier.title} required />
        <div className="grid gap-3 md:grid-cols-2">
          <select className="rounded-xl border p-3" name="type" defaultValue={dossier.type}><option value="pre_analisi">Pre-analisi</option><option value="dossier_cliente">Dossier cliente</option><option value="nota_interna">Nota interna</option></select>
          <select className="rounded-xl border p-3" name="status" defaultValue={dossier.status}><option value="bozza">Bozza</option><option value="revisionata">Revisionata</option><option value="archiviata">Archiviata</option></select>
        </div>
        <textarea className="min-h-[560px] rounded-xl border p-3 font-mono text-sm" name="content" defaultValue={dossier.content} required />
        <div className="flex flex-wrap gap-3"><PrimaryButton type="submit">Salva modifiche</PrimaryButton></div>
      </form>
      {dossier.status !== 'archiviata' ? <form action={archiveClientDossierAndRefresh} className="mt-3"><input type="hidden" name="id" value={dossier.id}/><button className="rounded-xl border border-red-200 px-4 py-2 text-sm font-bold text-red-600 hover:bg-red-50" type="submit">Archivia bozza</button></form> : null}
    </Card> : <Card title="Contenuto"><div className="whitespace-pre-wrap text-sm leading-6 text-fai-gray">{dossier.content}</div></Card>}
    {!canWrite ? <EmptyState title="Modifica non disponibile">Il tuo ruolo può leggere il dossier ma non modificarlo.</EmptyState> : null}
    {!hasPermission(session, 'dossier.read') ? <DisabledAction>Export .md</DisabledAction> : null}
  </div>;
}
