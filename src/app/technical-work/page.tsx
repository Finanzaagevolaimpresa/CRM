import { notFound } from 'next/navigation';
import { z } from 'zod';
import { Card, EmptyState, PageHeader } from '@/components/ui';
import { SecondaryLink } from '@/components/actions';
import { requireSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { listTechnicalWork } from '@/lib/technical-assignment-access';
import { technicalResponsibilityLabels, technicalWorkPath } from '@/lib/technical-assignment-display';
export const dynamic = 'force-dynamic';
export default async function Page({ searchParams }: { searchParams: Promise<{ kind?: string; page?: string }> }) {
  const session = await requireSession(), query = await searchParams;
  const kind = z.enum(['Project', 'TechnicalPractice']).safeParse(query.kind ?? 'TechnicalPractice');
  const page = z.coerce.number().int().min(1).max(200).safeParse(query.page ?? '1');
  if (!kind.success || !page.success) notFound();
  const data = await listTechnicalWork(prisma, session, kind.data, page.data).catch(() => null);
  return <div className="space-y-6"><PageHeader title="I miei incarichi tecnici"
    description="Responsabilità e lavoro nel solo perimetro assegnato personalmente dall’Admin. Ogni apertura ricontrolla sessione, scadenza e permessi." />
    <nav aria-label="Tipo di incarico" className="flex flex-wrap gap-3"><SecondaryLink href="/technical-work?kind=TechnicalPractice">Pratiche assegnate</SecondaryLink>
      <SecondaryLink href="/technical-work?kind=Project">Progetti assegnati</SecondaryLink></nav>
    <Card title={kind.data === 'Project' ? 'Progetti' : 'Pratiche'}>
      {!data ? <p role="status">Gli incarichi non sono disponibili con la sessione e l’abilitazione correnti.</p>
        : !data.records.length ? <EmptyState title="Nessun incarico disponibile in questa pagina" />
          : <div className="space-y-3">{data.records.map(row => <article className="min-w-0 space-y-2 rounded-xl border p-4" key={row.target.targetId}>
            <h2 className="break-words text-lg font-bold">{row.title}</h2><p>{technicalResponsibilityLabels[row.responsibility]} · scadenza {new Date(row.expiresAt).toLocaleString('it-IT')}</p>
            <SecondaryLink href={technicalWorkPath(row.target)}>Apri incarico tecnico</SecondaryLink></article>)}</div>}
    </Card><nav aria-label="Pagine incarichi" className="flex flex-wrap gap-3">
      {page.data > 1 && <SecondaryLink href={`/technical-work?kind=${kind.data}&page=${page.data - 1}`}>Precedenti</SecondaryLink>}
      {data?.hasNext && page.data < 200 && <SecondaryLink href={`/technical-work?kind=${kind.data}&page=${page.data + 1}`}>Successivi</SecondaryLink>}</nav>
  </div>;
}
