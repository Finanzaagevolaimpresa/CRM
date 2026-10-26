import { notFound } from 'next/navigation';
import { z } from 'zod';
import { Card, EmptyState, PageHeader } from '@/components/ui';
import { PrimaryButton, SecondaryLink } from '@/components/actions';
import { requireSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { listTechnicalWork } from '@/lib/technical-assignment-access';
import { technicalResponsibilityLabels, technicalWorkPath } from '@/lib/technical-assignment-display';
export const dynamic = 'force-dynamic';
export default async function Page({ searchParams }: { searchParams: Promise<{ kind?: string | string[]; page?: string | string[]; q?: string | string[] }> }) {
  const session = await requireSession(), query = await searchParams;
  const kind = z.enum(['Project', 'TechnicalPractice']).safeParse(query.kind ?? 'TechnicalPractice');
  const page = z.coerce.number().int().min(1).max(200).safeParse(query.page ?? '1');
  const term = z.string().trim().max(200).safeParse(query.q ?? '');
  if (!kind.success || !page.success || !term.success) notFound();
  const data = await listTechnicalWork(prisma, session, kind.data, page.data, term.data).catch(() => null);
  const listPath = (nextKind: 'Project' | 'TechnicalPractice', nextPage = 1) => {
    const params = new URLSearchParams({ kind: nextKind });
    if (term.data) params.set('q', term.data);
    if (nextPage > 1) params.set('page', String(nextPage));
    return '/technical-work?' + params.toString();
  };
  return <div className="space-y-6"><PageHeader title="I miei incarichi tecnici"
    description="Responsabilità e lavoro nel solo perimetro assegnato personalmente dall’Admin. Ogni apertura ricontrolla sessione, scadenza e permessi." />
    <nav aria-label="Tipo di incarico" className="flex flex-wrap gap-3"><SecondaryLink href={listPath('TechnicalPractice')}>Pratiche assegnate</SecondaryLink>
      <SecondaryLink href={listPath('Project')}>Progetti assegnati</SecondaryLink></nav>
    <form action="/technical-work" method="get" role="search" aria-label="Cerca negli incarichi tecnici" className="space-y-3">
      <input type="hidden" name="kind" value={kind.data} />
      <label htmlFor="technical-work-query" className="block font-bold">Cerca per titolo</label>
      <input id="technical-work-query" name="q" type="search" maxLength={200} defaultValue={term.data} key={term.data}
        aria-describedby="technical-work-search-help" className="w-full min-w-0 rounded-xl border border-slate-300 bg-white px-4 py-3" />
      <p id="technical-work-search-help" className="text-sm text-slate-600">La ricerca usa solo i titoli che puoi leggere negli incarichi correnti.</p>
      <div className="flex flex-wrap gap-3"><PrimaryButton type="submit">Cerca incarichi</PrimaryButton>
        {term.data && <SecondaryLink href={'/technical-work?kind=' + kind.data}>Azzera ricerca</SecondaryLink>}</div>
    </form>
    <Card title={kind.data === 'Project' ? 'Progetti' : 'Pratiche'}>
      {!data ? <p role="status">Gli incarichi non sono disponibili con la sessione e l’abilitazione correnti.</p>
        : !data.records.length ? <EmptyState title={term.data ? 'Nessun incarico corrisponde alla ricerca in questa pagina' : 'Nessun incarico disponibile in questa pagina'} />
          : <div className="space-y-3">{data.records.map(row => <article className="min-w-0 space-y-2 rounded-xl border p-4" key={row.target.targetId}>
            <h2 className="break-words text-lg font-bold">{row.title}</h2><p>{technicalResponsibilityLabels[row.responsibility]} · scadenza {new Date(row.expiresAt).toLocaleString('it-IT')}</p>
            <SecondaryLink href={technicalWorkPath(row.target)}>Apri incarico tecnico</SecondaryLink></article>)}</div>}
    </Card><nav aria-label="Pagine incarichi" className="flex flex-wrap gap-3">
      {page.data > 1 && <SecondaryLink href={listPath(kind.data, page.data - 1)}>Precedenti</SecondaryLink>}
      {data?.hasNext && page.data < 200 && <SecondaryLink href={listPath(kind.data, page.data + 1)}>Successivi</SecondaryLink>}</nav>
  </div>;
}
