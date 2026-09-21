export const dynamic = 'force-dynamic';

import { Card, EmptyState, PageHeader, StatusBadge, TimestampMeta, formatDateTime } from '@/components/ui';
import { DisabledAction, PrimaryButton, SecondaryLink } from '@/components/actions';
import { DeliveryTimeInput } from '@/components/delivery-time-input';
import { approveClientDossierAndRefresh, archiveClientDossierAndRefresh, updateClientDossierAndRefresh } from '@/lib/form-actions';
import { hasPermission, requirePermission } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { buildClientServiceLabel } from '@/lib/client-service-label';
import { getClientDossierReadAccess } from '@/lib/read-access';
import { authorizeEngagementDossierDeliveryAction, recordEngagementDossierDeliveryAction, reviewEngagementDossierVersionAction, reviseEngagementDossierAction } from '@/lib/engagement-dossier-actions';

export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ dossierError?: string }> }) {
  const { id } = await params;
  const { dossierError } = await searchParams;
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
  const { versions, reviews, authorizations, receipts } = context.engagementHistory ?? { versions: [], reviews: [], authorizations: [], receipts: [] };
  const currentVersion = versions.find((row) => row.id === dossier.currentVersionId);
  const approvedVersion = versions.find((row) => row.id === dossier.approvedVersionId);
  const serviceCatalog = service ? await prisma.serviceCatalog.findUnique({ where: { id: service.serviceCatalogId } }) : null;
  const serviceLabel = service ? buildClientServiceLabel(service, serviceCatalog) : 'Fascicolo generale';
  if (!client) return <h1 className="text-3xl font-bold text-fai-navy">Dossier non accessibile</h1>;
  const canWrite = hasPermission(session, 'dossier.write');
  const canApprove = hasPermission(session, 'dossier.approve');

  return <div className="space-y-6">
    <PageHeader title={`Dossier / Pre-analisi — ${dossier.title}`} description="Bozza interna salvata nel CRM. Il contenuto è modificabile manualmente e non espone percorsi di storage privati." />
    {dossierError ? <p className="rounded-xl bg-red-50 p-3 font-semibold text-red-700">Operazione non completata ({dossierError}). Verifica stato, versione e autorizzazioni.</p> : null}
    <div className="flex flex-wrap gap-3"><SecondaryLink href={`/clients/${dossier.clientId}#dossier`}>← Torna al fascicolo cliente</SecondaryLink>{!dossier.practiceReadinessId ? <><SecondaryLink href={`/client-dossiers/${dossier.id}/export`}>Esporta .md</SecondaryLink><SecondaryLink href={`/client-dossiers/${dossier.id}/export/docx`}>Esporta Word (.docx)</SecondaryLink></> : null}</div>
    <Card title="Dati bozza">
      <p>Cliente: {client.displayName}</p>
      <p>Servizio/pratica: {serviceLabel}</p>
      <p>Progetto: {project?.title ?? '—'}</p>
      <p>Tipo: {dossier.type.replaceAll('_', ' ')}</p>
      <p>Stato: <StatusBadge status={dossier.status} /></p>
      <p>Revisione: {dossier.reviewedAt ? `${reviewer?.name ?? dossier.reviewedById ?? 'Revisore'} · ${formatDateTime(dossier.reviewedAt)}` : 'Da revisionare'}</p>
      <TimestampMeta createdAt={dossier.createdAt} updatedAt={dossier.updatedAt} createdBy={creator?.name ?? dossier.createdById} updatedBy={updater?.name ?? dossier.updatedById} />
    </Card>
    {dossier.practiceReadinessId && currentVersion ? <>
      <Card title="Versione corrente e storico">
        <p className="font-semibold">Versione {currentVersion.version} · hash {currentVersion.contentHash}</p>
        <div className="mt-3 space-y-2">{versions.map((version) => <div className="rounded-xl border p-3 text-sm" key={version.id}><strong>v{version.version}</strong> · {version.contentHash}<br/>{version.id === dossier.approvedVersionId ? 'Approvata' : 'Non approvata'} · {version.createdAt.toLocaleString('it-IT')}</div>)}</div>
      </Card>
      {canWrite ? <Card title="Nuova versione"><form action={reviseEngagementDossierAction} className="grid gap-3"><input type="hidden" name="dossierId" value={dossier.id}/><input type="hidden" name="expectedVersionId" value={currentVersion.id}/><input className="rounded-xl border p-3" name="title" defaultValue={currentVersion.title} required/><textarea className="min-h-80 rounded-xl border p-3 font-mono" name="content" defaultValue={currentVersion.content} required/><PrimaryButton type="submit">Salva come nuova versione</PrimaryButton></form></Card> : null}
      {canApprove ? <Card title="Revisione umana della versione esatta"><form action={reviewEngagementDossierVersionAction} className="grid gap-3"><input type="hidden" name="dossierId" value={dossier.id}/><input type="hidden" name="versionId" value={currentVersion.id}/><input type="hidden" name="versionHash" value={currentVersion.contentHash}/><textarea name="note" required placeholder="Motivazione della decisione" className="rounded-xl border p-3"/><div className="flex flex-wrap gap-3"><button className="rounded-xl border px-4 py-2 font-bold" name="decision" value="REQUEST_CHANGES">Richiedi modifiche</button><PrimaryButton name="decision" value="APPROVED" type="submit">Approva questa versione</PrimaryButton></div></form></Card> : null}
      <Card title="Revisioni"><div className="space-y-2">{reviews.map((review) => <p key={review.id}>v{versions.find((v) => v.id === review.versionId)?.version ?? '?'} · {review.decision} · {review.note}</p>)}</div></Card>
      {approvedVersion ? <Card title="Export approvato e autorizzazione alla consegna"><p>Solo v{approvedVersion.version}, hash {approvedVersion.contentHash}, è esportabile e autorizzabile.</p><div className="my-3 flex gap-3"><SecondaryLink href={`/client-dossiers/${dossier.id}/export?versionId=${approvedVersion.id}`}>Esporta approvato .md</SecondaryLink><SecondaryLink href={`/client-dossiers/${dossier.id}/export/docx?versionId=${approvedVersion.id}`}>Esporta approvato .docx</SecondaryLink></div>{canApprove ? <form action={authorizeEngagementDossierDeliveryAction} className="grid gap-3 md:grid-cols-2"><input type="hidden" name="dossierId" value={dossier.id}/><input type="hidden" name="versionId" value={approvedVersion.id}/><input type="hidden" name="versionHash" value={approvedVersion.contentHash}/><select name="recipientKind" className="rounded-xl border p-3"><option value="CLIENT">Cliente</option><option value="ADVISOR">Consulente</option><option value="INSTITUTION">Ente</option></select><input name="recipientName" required placeholder="Destinatario esplicito" className="rounded-xl border p-3"/><input name="recipientAddress" required placeholder="Recapito" className="rounded-xl border p-3"/><label className="flex items-center gap-2"><input type="checkbox" name="recipientSynthetic"/> Destinatario sintetico</label><PrimaryButton type="submit">Autorizza consegna manuale</PrimaryButton></form> : null}</Card> : null}
      <Card title="Consegne manuali tracciate"><div className="space-y-4">{authorizations.map((authorization) => { const receipt = receipts.find((row) => row.authorizationId === authorization.id); return <div className="rounded-xl border p-3" key={authorization.id}><p>Autorizzazione {authorization.id} · versione {authorization.versionId}{authorization.revokedAt ? " · Revocata" : ""}</p><ul className="my-2 list-disc pl-5">{authorization.recipients.map((recipient, index) => <li key={index}>{recipient.name} · {recipient.address} · {recipient.kind}{recipient.synthetic ? " · sintetico" : ""}</li>)}</ul>{receipt ? <p>{receipt.outcome} · ricevuta {receipt.evidenceHash}</p> : canWrite && !authorization.revokedAt && authorization.versionId === dossier.approvedVersionId ? <form action={recordEngagementDossierDeliveryAction} className="mt-2 grid gap-2 md:grid-cols-2"><input type="hidden" name="dossierId" value={dossier.id}/><input type="hidden" name="authorizationId" value={authorization.id}/><select name="outcome" className="rounded-xl border p-2"><option value="DELIVERED">Consegnato</option><option value="FAILED">Non consegnato</option></select><input name="reference" required placeholder="Riferimento ricevuta/evidenza" className="rounded-xl border p-2"/><DeliveryTimeInput/><input name="note" placeholder="Nota" className="rounded-xl border p-2"/><label><input type="checkbox" name="evidenceSynthetic"/> Evidenza sintetica</label><PrimaryButton type="submit">Registra esito manuale</PrimaryButton></form> : <p>Esito non registrato</p>}</div>; })}</div></Card>
    </> : null}
    {!dossier.practiceReadinessId && canApprove && dossier.status !== 'archiviata' && (!dossier.reviewedById || !dossier.reviewedAt || dossier.status !== 'revisionata') ? <Card title="Revisione indipendente">
      <p className="mb-3 text-sm text-slate-600">Conferma possibile solo da un operatore diverso da chi ha creato o modificato il dossier per ultimo.</p>
      <form action={approveClientDossierAndRefresh}><input type="hidden" name="id" value={dossier.id}/><PrimaryButton type="submit">Conferma revisione dossier</PrimaryButton></form>
    </Card> : null}
    {!dossier.practiceReadinessId && canWrite && dossier.status !== 'archiviata' ? <Card title="Modifica manuale contenuto">
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
    {(!canWrite || dossier.status === 'archiviata') && !dossier.practiceReadinessId ? <EmptyState title="Modifica non disponibile">Il dossier è in sola lettura per ruolo o stato corrente.</EmptyState> : null}
    {!hasPermission(session, 'dossier.read') ? <DisabledAction>Export .md / Word</DisabledAction> : null}
  </div>;
}
