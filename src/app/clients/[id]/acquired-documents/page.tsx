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
      <div className="flex flex-wrap gap-4"><a className="font-semibold underline" href={`/acquired-documents/${encodeURIComponent(d.id)}`} target="_blank" rel="noopener noreferrer">Visualizza documento acquisito</a>
        <a className="font-semibold underline" href={`/acquired-documents/${encodeURIComponent(d.id)}?download=1`}>Scarica documento acquisito</a></div>
    </div></Card>)}
  </div>;
}
