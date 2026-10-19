export const dynamic = 'force-dynamic';
import { SecondaryLink } from '@/components/actions';
import { Card, EmptyState, PageHeader } from '@/components/ui';
import { requirePermission } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { readPracticeSharing } from '@/lib/selective-practice-access';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission('technical.read'), { id } = await params;
  const projection = await readPracticeSharing(prisma, session, id).catch(() => null);
  return <div className="min-w-0 space-y-6"><PageHeader title="Pratica condivisa" description="Consultazione dei soli campi selezionati dall’utente personalmente autorizzato." />
    <SecondaryLink href="/shared-practices">Torna alle selezioni</SecondaryLink>
    {projection ? <Card title="Informazioni condivise"><dl className="grid min-w-0 gap-5 sm:grid-cols-2">
      {projection.fields.map(field => <div key={field.key} className="min-w-0"><dt className="font-semibold text-slate-600">{field.label}</dt>
        <dd className="break-words whitespace-pre-wrap text-lg">{field.value}</dd></div>)}
    </dl><p className="mt-5 text-sm text-slate-600">Solo lettura · revisione {projection.revision}{projection.expiresAt ? ` · scadenza ${new Date(projection.expiresAt).toLocaleString('it-IT')}` : ''}</p></Card>
      : <EmptyState title="Selezione non disponibile">L’accesso può essere scaduto, revocato o sospeso. Chiedi all’amministratore di verificare la selezione.</EmptyState>}
  </div>;
}
