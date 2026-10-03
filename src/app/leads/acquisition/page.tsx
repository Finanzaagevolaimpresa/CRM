import { notFound } from 'next/navigation';
import { SecondaryLink } from '@/components/actions';
import { LeadAcquisitionList } from '@/components/lead-acquisition-list';
import { PaginationNav } from '@/components/pagination-nav';
import { Card, EmptyState, PageHeader, Table } from '@/components/ui';
import { requireAuth } from '@/lib/auth';
import { LeadAcquisitionDenied, readLeadAcquisitions, readLeadAcquisitionSummary } from '@/lib/lead-acquisition';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

export default async function Page({ searchParams }: { searchParams?: Promise<Record<string, string | undefined>> }) {
  const actor = await requireAuth(['admin']);
  const params = (await searchParams) ?? {};
  const data = await Promise.all([
    readLeadAcquisitions(prisma, actor, { page: params.page, queue: params.queue }),
    readLeadAcquisitionSummary(prisma, actor),
  ])
    .catch((error: unknown) => { if (error instanceof LeadAcquisitionDenied) notFound(); throw error; });
  const [page, summary] = data;
  return <div className="space-y-6">
    <PageHeader title="Acquisizione lead" description="Ricevute persistite nel CRM, richieste da elaborare, ambiguità e tentativi. Il successo mostrato dal form non sostituisce una ricevuta CRM." />
    <div className="flex flex-wrap gap-3"><SecondaryLink href="/leads">Pipeline e prossime azioni</SecondaryLink><SecondaryLink href="/leads/inbox">Coda e assegnazioni</SecondaryLink><SecondaryLink href="/leads/duplicates">Risolvi identità ambigue</SecondaryLink><SecondaryLink href="/practice-readiness">Servizi acquistati e percorso tecnico</SecondaryLink></div>
    <Card title="Fonti e risultati registrati">
      <p className="mb-3 text-sm text-slate-600">Tutte le ricevute conservate. Le richieste possono superare il numero di persone: ogni nuovo invio resta distinto. I lead sono contati una sola volta per fonte e modulo.</p>
      {!summary.length ? <EmptyState title="Nessuna ricevuta acquisita" /> : <Table headers={['Fonte / modulo', 'Richieste', 'Da elaborare', 'Errori', 'Ambigue', 'Non assegnati', 'Assegnati', 'Lead con incasso / lead collegati']} rows={summary.map((row) => [
        `${row.source} / ${row.form}`, String(row.requests), String(row.waiting), String(row.errors), String(row.ambiguous), String(row.unassigned), String(row.assigned), `${row.paidLeads} / ${row.leads}`,
      ])} />}
      <p className="mt-3 text-sm text-slate-600">Incasso: pagamento positivo registrato come incassato, con data di incasso, per un cliente collegato. È un dato di attribuzione, non una prova che la campagna abbia causato la vendita. Costi e ROI richiedono dati di spesa e non sono stimati.</p>
    </Card>
    <div className="flex flex-wrap gap-3">{[['', 'Tutte'], ['waiting', 'Da elaborare'], ['errors', 'Errori e retry'], ['ambiguous', 'Ambigue']].map(([queue, title]) => <SecondaryLink key={queue} href={queue ? `/leads/acquisition?queue=${queue}` : '/leads/acquisition'}>{title}</SecondaryLink>)}</div>
    <LeadAcquisitionList items={page.items} />
    <PaginationNav pathname="/leads/acquisition" params={{ queue: params.queue }} {...page} />
  </div>;
}
