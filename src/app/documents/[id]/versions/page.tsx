export const dynamic = 'force-dynamic';
import { notFound } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { documentVersionPage } from '@/lib/document-version-service';
import { DocumentVersionError } from '@/lib/document-version-contract';
import { ProjectUnavailableError } from '@/lib/project-lifecycle-lock';
import { DocumentVersionUpload } from '@/components/document-version-upload';
import { Card, PageHeader } from '@/components/ui';
import { operationalRomeTime } from '@/lib/operational-time';

export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ before?: string | string[] }> }) {
  const actor = await getSession(); if (!actor) notFound();
  const { id } = await params;
  const query = await searchParams;
  if (query.before !== undefined && (typeof query.before !== 'string' || !/^[1-9][0-9]{0,9}$/.test(query.before))) notFound();
  const before = query.before === undefined ? undefined : Number(query.before);
  let state;
  try { state = await documentVersionPage(prisma, actor, id, before); }
  catch (error) { if (error instanceof DocumentVersionError || error instanceof ProjectUnavailableError) notFound(); throw error; }
  return <div className="crm-space-y-6"><PageHeader title="Versioni del documento" description={state.title} />
    {actor.role === 'admin' && <a className="inline-block font-bold underline" href={`/admin/records/Document/${id}`}>Correggi metadati e gestisci il cestino</a>}
    <Card title="Storico conservato"><p className="mb-3 break-all">{state.fileName}</p>
      <p>Versione corrente: {state.currentVersion ?? 'non disponibile'}.</p>
      {before !== undefined && <a href={`/documents/${encodeURIComponent(id)}/versions`} className="font-bold underline">Torna alle versioni recenti</a>}
      <ul className="grid gap-3">{state.versions.map(v => <li key={v.id} className="flex flex-wrap items-center gap-3 rounded-xl border p-3">
        <strong>Versione {v.version}</strong><time dateTime={v.createdAt}>{operationalRomeTime(v.createdAt)}</time>
        <a href={`/documents/${encodeURIComponent(id)}/view?versionId=${encodeURIComponent(v.id)}`} target="_blank" rel="noopener noreferrer" className="font-bold underline">Visualizza versione {v.version}</a>
        <a href={`/documents/${encodeURIComponent(id)}/download?versionId=${encodeURIComponent(v.id)}`} className="font-bold underline">Scarica versione {v.version}</a>
      </li>)}</ul>
      {state.nextBefore !== null && <a href={`/documents/${encodeURIComponent(id)}/versions?before=${state.nextBefore}`} className="mt-3 inline-block font-bold underline">Versioni precedenti</a>}
    </Card>
    {state.canAppend ? <Card title="Carica nuova versione"><DocumentVersionUpload documentId={id} expectedHash={state.expectedHash} fileName={state.fileName} mimeType={state.mimeType} /></Card>
      : <Card title="Caricamento non disponibile"><p>I permessi, lo stato corrente o un collegamento a un flusso verificato non consentono qui una nuova versione. La consultazione resta limitata ai documenti autorizzati.</p></Card>}
  </div>;
}
