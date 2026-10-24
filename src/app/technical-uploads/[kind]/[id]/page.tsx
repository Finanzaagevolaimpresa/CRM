import { randomUUID } from 'node:crypto';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { PageHeader, Card } from '@/components/ui';
import { SecondaryLink } from '@/components/actions';
import { TechnicalUploadForm } from '@/components/technical-upload-form';
import { TechnicalUploadRecovery } from '@/components/technical-upload-recovery';
import { requireSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { readOwnTechnicalUploads } from '@/lib/technical-upload-service';
import { prepareTechnicalUpload, saveTechnicalUpload, checkTechnicalUpload } from '@/lib/technical-upload-actions';
import { parseTechnicalUploadTarget, technicalUploadPath, technicalUploadVerdictLabels } from '@/lib/technical-upload-display';
import { technicalWorkPath } from '@/lib/technical-assignment-display';
export const dynamic = 'force-dynamic';
export default async function Page({ params, searchParams }: { params: Promise<{ kind: string; id: string }>; searchParams: Promise<{ uploadDecision?: string }> }) {
  const session = await requireSession(), target = parseTechnicalUploadTarget(await params);
  if (!target.success) notFound();
  const recovery = (await searchParams).uploadDecision, path = technicalUploadPath(target.data);
  if (recovery) {
    if (!z.string().uuid().safeParse(recovery).success) notFound();
    return <div className="space-y-6"><PageHeader title="Verifica del deposito" description="Consulta la ricevuta senza ripetere il caricamento." />
      <TechnicalUploadRecovery target={target.data} commandId={recovery} action={checkTechnicalUpload} returnPath={path} /></div>;
  }
  const data = await readOwnTechnicalUploads(prisma, session, target.data).catch(() => null);
  if (!data) notFound();
  return <div className="min-w-0 space-y-6"><PageHeader title="Documenti da revisionare" description="Deposita un file nel tuo incarico per la revisione personale dell’Admin." />
    <SecondaryLink href={technicalWorkPath(target.data)}>Torna al mio incarico</SecondaryLink>
    <Card title="Caricamento autorizzato"><p className="break-words">Scopo: {data.profile.purpose}</p>
      <p>Formati: {data.profile.formats.join(', ')} · massimo {data.profile.maxFileBytes / 1048576} MiB per file.</p>
      <p>Spazio utilizzato: {data.consumedFiles} di {data.profile.maxFilesPerRevision} file · {data.consumedBytes} di {data.profile.maxBytesPerRevision} byte.</p>
      {data.retainedWithoutReceipt > 0 && <p role="status">Sono presenti file trattenuti dopo un’interruzione: consumano quota e richiedono riconciliazione. Non vengono cancellati automaticamente.</p>}
      <p>Contratti e pagamenti devono seguire il percorso amministrativo riservato. Nessuna pubblicazione o invio automatico.</p>
      <TechnicalUploadForm data={data} initialCommandId={randomUUID()} previewAction={prepareTechnicalUpload} confirmAction={saveTechnicalUpload} receiptAction={checkTechnicalUpload} /></Card>
    <Card title="I miei depositi in questo incarico">{!data.deposits.length ? <p>Nessun file depositato in questa versione dell’incarico.</p>
      : <ul className="space-y-4">{data.deposits.map(d => <li key={d.commandId} className="min-w-0 space-y-2 rounded-xl border p-4">
        <h2 className="break-words font-bold">{d.title}</h2><p className="break-words">{d.fileName} · {d.sizeBytes} byte</p>
        <p>{d.review ? technicalUploadVerdictLabels[d.review.verdict] : 'In attesa della revisione Admin'}</p>
        {d.review && <p className="whitespace-pre-wrap break-words">Motivo: {d.review.reason}</p>}
        <div className="flex flex-wrap gap-4">{d.previewMime && <a className="font-semibold underline" href={`${path}/files/${d.commandId}`} target="_blank" rel="noopener noreferrer">Visualizza file</a>}
          <a className="font-semibold underline" href={`${path}/files/${d.commandId}?download=1`}>Scarica il mio file</a></div>
      </li>)}</ul>}</Card></div>;
}
