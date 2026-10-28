import { canPreviewSelectedDocument } from '@/lib/selected-document-formats';
import { randomUUID } from 'node:crypto';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { Card, PageHeader } from '@/components/ui';
import { SecondaryLink } from '@/components/actions';
import { TechnicalWorkForm, TechnicalWorkRecovery } from '@/components/technical-work-form';
import { requireSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { readTechnicalWork } from '@/lib/technical-assignment-access';
import { prepareTechnicalWork, saveTechnicalWork, checkTechnicalWork } from '@/lib/technical-work-actions';
import { technicalResponsibilityLabels, technicalTargetReference, technicalWorkPath } from '@/lib/technical-assignment-display';
import { technicalUploadPath } from '@/lib/technical-upload-display';
import { operationalRomeTime } from '@/lib/operational-time';
export const dynamic = 'force-dynamic';
const dateFields = new Set(['dueDate', 'submittedAt', 'nextClientUpdateAt']);
export default async function Page({ params, searchParams }: { params: Promise<{ kind: string; id: string }>;
  searchParams: Promise<{ workDecision?: string }> }) {
  const session = await requireSession(), p = await params;
  const target = technicalTargetReference.safeParse({ kind: p.kind === 'projects' ? 'Project' : p.kind === 'practices' ? 'TechnicalPractice' : null, targetId: p.id });
  if (!target.success) notFound();
  const recovery = (await searchParams).workDecision;
  if (recovery) {
    if (!z.string().uuid().safeParse(recovery).success) notFound();
    return <div className="space-y-6"><PageHeader title="Verifica del salvataggio tecnico" description="Questa verifica non ripete la modifica e non rinnova l’incarico." />
      <TechnicalWorkRecovery target={target.data} commandId={recovery} action={checkTechnicalWork} /></div>;
  }
  const data = await readTechnicalWork(prisma, session, target.data).catch(() => null);
  if (!data) notFound();
  const items = data.workItems;
  return <div className="min-w-0 space-y-6"><PageHeader title={data.fields.find(field => field.key === 'title')?.value ?? 'Incarico tecnico'}
    description={`${technicalResponsibilityLabels[data.responsibility]} · scadenza dell’accesso ${operationalRomeTime(data.expiresAt)}`} />
    <SecondaryLink href={`/technical-work?kind=${target.data.kind}`}>Torna ai miei incarichi</SecondaryLink>
    {data.actions.includes('upload_document') && <SecondaryLink href={technicalUploadPath(target.data)}>Deposita un documento per l’Admin</SecondaryLink>}
    {data.actions.includes('request_admin') && <SecondaryLink href={`/admin-requests/new?kind=${target.data.kind}&id=${encodeURIComponent(target.data.targetId)}`}>Richiedi documento o integrazione all’Admin</SecondaryLink>}
    <Card title="Informazioni disponibili"><dl className="grid min-w-0 gap-4 sm:grid-cols-2">{data.fields.map(field => <div key={field.key} className="min-w-0">
      <dt className="font-semibold">{field.label}</dt><dd className="whitespace-pre-wrap break-words">{field.value && dateFields.has(field.key) ? operationalRomeTime(field.value) : field.value ?? '—'}</dd></div>)}</dl></Card>
    <Card title="Documenti tecnici assegnati">{!data.documents.length ? <p>Nessuna versione documentale assegnata.</p>
      : <ul className="space-y-4">{data.documents.map(doc => <li className="min-w-0 space-y-2" key={doc.fileId}>
        <p className="break-words font-semibold">{doc.title} · versione {doc.version}</p><div className="flex flex-wrap gap-3">
          {canPreviewSelectedDocument(doc) ? <a className="font-semibold underline" href={`${technicalWorkPath(target.data)}/documents/${doc.fileId}`} target="_blank" rel="noopener noreferrer">Visualizza {doc.fileName}</a> : <p className="break-words">{doc.fileName} · Anteprima non disponibile per questo formato.</p>}
          {!doc.allowDownload && !canPreviewSelectedDocument(doc) && <span>Download non consentito.</span>}
          {doc.allowDownload && <a className="font-semibold underline" href={`${technicalWorkPath(target.data)}/documents/${doc.fileId}?download=1`}>Scarica versione</a>}</div></li>)}</ul>}</Card>
    {data.actions.some(action => action === 'manage_checklist' || action === 'manage_deadlines') && <Card title="Checklist, attività e scadenze assegnate">
      {!items.length ? <p>Nessun elemento attualmente disponibile nel tuo perimetro.</p> : <ul className="space-y-3">{items.map(item => <li key={`${item.kind}:${item.itemId}`}>
        <a className="break-words font-semibold underline" href={`${technicalWorkPath(target.data)}/items/${item.kind}/${item.itemId}`}>
          {item.fields.title ?? (item.kind === 'Task' ? 'Attività assegnata' : 'Elemento checklist assegnato')}</a>
        {Object.hasOwn(item.fields, 'dueAt') && <p>Scadenza: {item.fields.dueAt ? operationalRomeTime(item.fields.dueAt) : 'Non indicata'}</p>}</li>)}</ul>}</Card>}
    {data.actions.some(action => action === 'update_fields' || action === 'update_status') && <Card title="Operazioni assegnate"><TechnicalWorkForm data={data} commandId={randomUUID()}
      previewAction={prepareTechnicalWork} confirmAction={saveTechnicalWork} receiptAction={checkTechnicalWork} /></Card>}
  </div>;
}
