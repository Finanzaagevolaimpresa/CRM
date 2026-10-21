export const dynamic = 'force-dynamic';
import { SecondaryLink } from '@/components/actions';
import { Card, EmptyState, PageHeader } from '@/components/ui';
import { requirePermission } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { readClientSharing } from '@/lib/selective-client-access';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission('client.read'), { id } = await params;
  const projection = await readClientSharing(prisma, session, id).catch(() => null);
  return <div className="min-w-0 space-y-6"><PageHeader title="Cliente condiviso" description="Consultazione dei campi e delle versioni selezionati dall’utente personalmente autorizzato." />
    <SecondaryLink href="/shared-clients">Torna alle selezioni</SecondaryLink>
    {projection ? <Card title="Informazioni condivise"><dl className="grid min-w-0 gap-5 sm:grid-cols-2">
      {projection.fields.map(field => <div key={field.key} className="min-w-0"><dt className="font-semibold text-slate-600">{field.label}</dt>
        <dd className="break-words whitespace-pre-wrap text-lg">{field.value}</dd></div>)}
    </dl><p className="mt-5 text-sm text-slate-600">Solo lettura · revisione {projection.revision}{projection.expiresAt ? ` · scadenza ${new Date(projection.expiresAt).toLocaleString('it-IT')}` : ''}</p></Card>
      : <EmptyState title="Selezione non disponibile">L’accesso può essere scaduto, revocato o sospeso. Chiedi all’amministratore di verificare la selezione.</EmptyState>}
    {projection && !!projection.companies.length && <Card title="Informazioni aziendali condivise"><div className="space-y-4">{projection.companies.map((company, index) => <section key={company.companyId} className="min-w-0 space-y-3 rounded-xl border p-4">
      <h2 className="font-semibold">Azienda {index + 1}</h2><dl className="grid min-w-0 gap-5 sm:grid-cols-2">{company.fields.map(field => <div key={field.key} className="min-w-0"><dt className="font-semibold text-slate-600">{field.label}</dt><dd className="break-words whitespace-pre-wrap text-lg">{field.value}</dd></div>)}</dl>
    </section>)}</div></Card>}
    {projection && !!projection.documents.length && <Card title="Documenti condivisi"><div className="space-y-4">{projection.documents.map(document => <article key={document.versionId} className="min-w-0 rounded-xl border p-4">
      <h2 className="break-words font-semibold">{document.title} · versione {document.version}</h2><p className="break-words text-sm">{document.fileName}</p>
      <div className="mt-3 flex flex-wrap gap-3 font-semibold text-fai-blue">
        <a href={`/shared-clients/${id}/documents/${document.versionId}`} target="_blank" rel="noopener noreferrer" className="underline">Consulta versione</a>
        {document.download && <a href={`/shared-clients/${id}/documents/${document.versionId}?download=1`} className="underline">Scarica versione</a>}</div>
    </article>)}</div></Card>}
  </div>;
}
