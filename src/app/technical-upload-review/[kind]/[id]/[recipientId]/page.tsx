import { randomUUID } from 'node:crypto';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { PageHeader, Card } from '@/components/ui';
import { SecondaryLink } from '@/components/actions';
import { TechnicalUploadReviewForm } from '@/components/technical-upload-review-form';
import { TechnicalDocumentAcquisitionForm } from '@/components/technical-document-acquisition-form';
import { prepareTechnicalAcquisition, saveTechnicalAcquisition, checkTechnicalAcquisition } from '@/lib/technical-document-acquisition-actions';
import { TechnicalUploadRecovery } from '@/components/technical-upload-recovery';
import { requireSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { readTechnicalUploadReviewQueue } from '@/lib/technical-upload-review-service';
import { prepareTechnicalUploadReview, saveTechnicalUploadReview, checkTechnicalUploadReview } from '@/lib/technical-upload-actions';
import { parseTechnicalUploadTarget, technicalUploadReviewPath, technicalUploadVerdictLabels } from '@/lib/technical-upload-display';
import { technicalAssignmentReference } from '@/lib/technical-assignment-decision';
import { technicalManagementPath } from '@/lib/technical-assignment-display';
export const dynamic = 'force-dynamic';
export default async function Page({ params, searchParams }: { params: Promise<{ kind: string; id: string; recipientId: string }>;
  searchParams: Promise<{ reviewDecision?: string; acquisitionDecision?: string }> }) {
  const session = await requireSession(), p = await params, target = parseTechnicalUploadTarget(p);
  if (!target.success) notFound();
  const ref = technicalAssignmentReference.safeParse({ ...target.data, recipientId: p.recipientId });
  if (!ref.success) notFound();
  const query = await searchParams, recovery = query.acquisitionDecision ?? query.reviewDecision, path = technicalUploadReviewPath(ref.data);
  if (recovery) {
    if (!z.string().uuid().safeParse(recovery).success) notFound();
    return <div className="space-y-6"><PageHeader title="Verifica della revisione" description="Consulta la ricevuta della decisione personale." />
      <TechnicalUploadRecovery reference={ref.data} commandId={recovery} action={query.acquisitionDecision ? checkTechnicalAcquisition : checkTechnicalUploadReview} returnPath={path} /></div>;
  }
  const data = await readTechnicalUploadReviewQueue(prisma, session, ref.data).catch(() => null);
  if (!data) notFound();
  return <div className="min-w-0 space-y-6"><PageHeader title="Revisione dei documenti tecnici" description={`Depositi di ${data.recipient.name} · ${data.recipient.email}`} />
    <SecondaryLink href={technicalManagementPath(ref.data)}>Torna agli incarichi</SecondaryLink>
    <p>Esamina il file, poi scegli personalmente approvazione o rifiuto. La decisione conserva il deposito privato e lo storico; non pubblica il file nel fascicolo e non lo condivide con altre persone.</p>
    {!data.deposits.length && <p>Nessun documento da revisionare in questa versione dell’incarico.</p>}
    {data.deposits.map(d => <Card key={d.commandId} title={d.title}><div className="min-w-0 space-y-3">
      <p className="break-words">{d.fileName} · {d.sizeBytes} byte</p><p className="break-all text-sm">Impronta: {d.contentSha256}</p>
      <div className="flex flex-wrap gap-4">{d.previewMime && <a className="font-semibold underline" href={`${path}/files/${d.commandId}`} target="_blank" rel="noopener noreferrer">Visualizza file da revisionare</a>}
        <a className="font-semibold underline" href={`${path}/files/${d.commandId}?download=1`}>Scarica file da revisionare</a></div>
      {d.review ? <div><p role="status">Revisione registrata. Il file resta nel deposito privato; nessun documento è stato pubblicato o inviato.</p>
        <p className="font-bold">{technicalUploadVerdictLabels[d.review.verdict]}</p><p className="whitespace-pre-wrap break-words">{d.review.reason}</p>
        <p>{new Date(d.review.recordedAt).toLocaleString('it-IT')}</p></div>
        : <TechnicalUploadReviewForm reference={ref.data} submissionCommandId={d.commandId} sourceSha256={d.sourceSha256} initialCommandId={randomUUID()}
          previewAction={prepareTechnicalUploadReview} confirmAction={saveTechnicalUploadReview} receiptAction={checkTechnicalUploadReview} />}
      {d.acquiredDocumentId ? <p>Documento acquisito nel fascicolo privato. <a className="font-semibold underline" href={`/clients/${encodeURIComponent(d.clientId)}/acquired-documents`}>Apri il fascicolo e scegli chi può vederlo</a></p>
        : d.review?.verdict === 'APPROVE_PRIVATE' && <TechnicalDocumentAcquisitionForm reference={ref.data} submissionCommandId={d.commandId}
          sourceSha256={d.sourceSha256} reviewCommandId={d.review.commandId} reviewSha256={d.review.sha256} title={d.title} initialCommandId={randomUUID()}
          previewAction={prepareTechnicalAcquisition} confirmAction={saveTechnicalAcquisition} receiptAction={checkTechnicalAcquisition} />}
    </div></Card>)}
  </div>;
}
