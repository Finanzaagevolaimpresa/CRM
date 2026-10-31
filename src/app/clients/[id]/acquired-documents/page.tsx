import { AdminOperationalShortcut } from '@/components/admin-operational-shortcut';
import { canPreviewSelectedDocument } from '@/lib/selected-document-formats';
import { notFound } from 'next/navigation';
import { requireSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { listPersonalAcquiredDocuments } from '@/lib/technical-document-acquired-access';
import { PageHeader, Card } from '@/components/ui';
import { SecondaryLink } from '@/components/actions';
export const dynamic = 'force-dynamic';
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession(), { id } = await params;
  const documents = await listPersonalAcquiredDocuments(prisma, session, id).catch(() => null);
  if (!documents) notFound();
  return <div className="min-w-0 space-y-6"><PageHeader title="Documenti acquisiti nel fascicolo" description="File approvati e acquisiti privatamente dal profilo personale Admin." />
    <SecondaryLink href={`/clients/${encodeURIComponent(id)}#documenti`}>Torna al fascicolo</SecondaryLink>
    <p>L’acquisizione non concede accesso ad altre persone. Nella condivisione scegli la persona, le singole versioni, l’eventuale download e la scadenza; controlla il riepilogo prima della conferma personale.</p>
    <p>Contratti e pagamenti possono essere ammessi soltanto per Admin e Amministrazione. Per un tecnico puoi scegliere la versione nel suo incarico, mantenendo separati lettura e lavoro operativo.</p>
    <SecondaryLink href={`/clients/${encodeURIComponent(id)}/sharing`}>Scegli persone e versioni da mostrare</SecondaryLink>
    {!documents.length && <p>Nessun documento acquisito disponibile con i permessi correnti.</p>}
    {documents.map(d => <Card key={d.id} title={d.title}><div className="min-w-0 space-y-3">
      <p className="break-words">{d.fileName} · versione 1</p><p>Acquisito il {new Date(d.acquiredAt).toLocaleString('it-IT')} · visibilità amministrata personalmente</p>
      <AdminOperationalShortcut session={session} model="Document" id={d.id} state={d.lifecycleState}/>
      {session.role==='admin'&&<SecondaryLink href={'/admin/private-documents/'+encodeURIComponent(d.id)}>Correggi metadati e consulta le revisioni</SecondaryLink>}
      {session.role==='admin'&&<SecondaryLink href={'/admin/private-documents/'+encodeURIComponent(d.id)+'/versions'}>Carica o ripristina una versione privata</SecondaryLink>}
      {d.available?<div className="space-y-3">{[...d.versions].reverse().map(v=><div key={v.id} className="flex flex-wrap gap-4"><span>{v.fileName} · versione {v.version}</span>
        {canPreviewSelectedDocument(v) ? <a className="font-semibold underline" href={'/acquired-documents/'+encodeURIComponent(d.id)+'?version='+encodeURIComponent(v.id)} target="_blank" rel="noopener noreferrer">Apri versione {v.version}</a> : <span>Anteprima non disponibile per questo formato.</span>}
        <a className="font-semibold underline" href={'/acquired-documents/'+encodeURIComponent(d.id)+'?version='+encodeURIComponent(v.id)+'&download=1'}>Scarica versione {v.version}</a></div>)}</div>:<p>Contenuto sospeso o scaduto. Le informazioni e le prove di acquisizione restano conservate.</p>}
    </div></Card>)}
  </div>;
}
