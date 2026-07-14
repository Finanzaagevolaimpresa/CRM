export const dynamic = 'force-dynamic';

import { Card, EmptyState, PageHeader, StatusBadge, TimestampMeta, formatDateTime } from '@/components/ui';
import { DisabledAction, PrimaryButton, SecondaryLink } from '@/components/actions';
import { approveClientDossierAndRefresh, archiveClientDossierAndRefresh, updateClientDossierAndRefresh } from '@/lib/form-actions';
import { hasPermission, requirePermission } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { buildClientServiceLabel } from '@/lib/client-service-label';
import { getClientDossierReadAccess } from '@/lib/read-access';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requirePermission('dossier.read');
  const context = await getClientDossierReadAccess(session, id);
  if (!context) return <PageHeader title="Bozza dossier non trovata" description="Il record richiesto non esiste o non è accessibile." />;
  const { dossier, clientService: service, project } = context;
  const [client, creator, updater, reviewer] = await Promise.all([
    prisma.client.findFirst({ where: { id: dossier.clientId, deletedAt: null } }),
    prisma.user.findUnique({ where: { id: dossier.createdById } }),
    dossier.updatedById ? prisma.user.findUnique({ where: { id: dossier.updatedById } }) : null,
    dossier.reviewedById ? prisma.user.findUnique({ where: { id: dossier.reviewedById } }) : null,
  ]);
  const serviceCatalog = service ? await prisma.serviceCatalog.findUnique({ where: { id: service.serviceCatalogId } }) : null;
  const serviceLabel = service ? buildClientServiceLabel(service, serviceCatalog) : 'Fascicolo generale';
  if (!client) return <h1 className="text-3xl font-bold text-fai-navy">Dossier non accessibile</h1>;
  const canWrite = hasPermission(session, 'dossier.write');
  const canApprove = hasPermission(session, 'dossier.approve');

  return <div className="space-y-6">
    <PageHeader title={`Dossier / Pre-analisi — ${dossier.title}`} description="Bozza interna salvata nel CRM. Il contenuto è modificabile manualmente e non espone percorsi di storage privati." />
    <div className="flex flex-wrap gap-3"><SecondaryLink href={`/clients/${dossier.clientId}#dossier`}>← Torna al fascicolo cliente</SecondaryLink><SecondaryLink href={`/client-dossiers/${dossier.id}/export`}>Esporta .md</SecondaryLink><SecondaryLink href={`/client-dossiers/${dossier.id}/export/docx`}>Esporta Word (.docx)</SecondaryLink></div>
    <Card title="Dati bozza">
      <p>Cliente: {client.displayName}</p>
      <p>Servizio/pratica: {serviceLabel}</p>
      <p>Progetto: {project?.title ?? '—'}</p>
      <p>Tipo: {dossier.type.replaceAll('_', ' ')}</p>
      <p>Stato: <StatusBadge status={dossier.status} /></p>
      <p>Revisione: {dossier.reviewedAt ? `${reviewer?.name ?? dossier.reviewedById ?? 'Revisore'} · ${formatDateTime(dossier.reviewedAt)}` : 'Da revisionare'}</p>
      <TimestampMeta createdAt={dossier.createdAt} updatedAt={dossier.updatedAt} createdBy={creator?.name ?? dossier.createdById} updatedBy={updater?.name ?? dossier.updatedById} />
    </Card>
    {canApprove && dossier.status !== 'archiviata' && (!dossier.reviewedById || !dossier.reviewedAt || dossier.status !== 'revisionata') ? <Card title="Revisione indipendente">
      <p className="mb-3 text-sm text-slate-600">Conferma possibile solo da un operatore diverso da chi ha creato o modificato il dossier per ultimo.</p>
      <form action={approveClientDossierAndRefresh}><input type="hidden" name="id" value={dossier.id}/><PrimaryButton type="submit">Conferma revisione dossier</PrimaryButton></form>
    </Card> : null}
    {canWrite && dossier.status !== 'archiviata' ? <Card title="Modifica manuale contenuto">
      {dossier.status === 'revisionata' ? <p className="rounded-xl bg-amber-50 p-3 text-sm font-semibold text-amber-800">Ogni modifica riporta il dossier in bozza e richiede una nuova revisione indipendente.</p> : null}
      <form action={updateClientDossierAndRefresh} className="grid gap-3">
        <input type="hidden" name="id" value={dossier.id} />
        <input className="rounded-xl border p-3" name="title" defaultValue={dossier.title} required />
        <div className="grid gap-3 md:grid-cols-2">
          <select className="rounded-xl border p-3" name="type" defaultValue={dossier.type}><option value="pre_analisi">Pre-analisi</option><option value="dossier_cliente">Dossier cliente</option><option value="nota_interna">Nota interna</option></select>
          <select className="rounded-xl border p-3" name="status" defaultValue={dossier.status === 'revisionata' ? 'bozza' : dossier.status}><option value="bozza">Bozza</option><option value="archiviata">Archiviata</option></select>
        </div>
        <textarea className="min-h-[560px] rounded-xl border p-3 font-mono text-sm" name="content" defaultValue={dossier.content} required />
        <div className="flex flex-wrap gap-3"><PrimaryButton type="submit">Salva modifiche</PrimaryButton></div>
      </form>
      <form action={archiveClientDossierAndRefresh} className="mt-3"><input type="hidden" name="id" value={dossier.id}/><button className="rounded-xl border border-red-200 px-4 py-2 text-sm font-bold text-red-600 hover:bg-red-50" type="submit">Archivia bozza</button></form>
    </Card> : <Card title="Contenuto"><div className="whitespace-pre-wrap text-sm leading-6 text-fai-gray">{dossier.content}</div></Card>}
    {!canWrite || dossier.status === 'archiviata' ? <EmptyState title="Modifica non disponibile">Il dossier è in sola lettura per ruolo o stato corrente.</EmptyState> : null}
    {!hasPermission(session, 'dossier.read') ? <DisabledAction>Export .md / Word</DisabledAction> : null}
  </div>;
}
