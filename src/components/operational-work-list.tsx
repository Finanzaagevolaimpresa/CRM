import Link from 'next/link';
import { PrimaryButton, SecondaryLink } from './actions';
import { Card, EmptyState, PageHeader, Stat } from './ui';
import type { AuthSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { loadOperationalWorkCatalogue } from '@/lib/operational-work';
import { selectOperationalWork, type OperationalWorkRow } from '@/lib/operational-work-projection';
import { operationalWorkQuery, operationalWorkListPath } from '@/lib/operational-work-query';
import { technicalResponsibilityLabels } from '@/lib/technical-assignment-display';
import type { TechnicalTargetReference } from '@/lib/technical-assignment-display';
import { notFound } from 'next/navigation';
import { hasPermission } from '@/lib/permission-evaluator';
import { operationalRomeTime } from '@/lib/operational-time';
export function OperationalWorkRows({ records }: { records: OperationalWorkRow[] }) {
  return <div className="grid gap-3">{records.map(row => <article key={row.kind + row.id}
    data-operational-record={row.id} className="min-w-0 space-y-2 rounded-xl border p-4">
    <h2 className="break-words text-lg font-bold">{row.title ?? 'Incarico tecnico · titolo non condiviso'}</h2>
    <p>{row.kind === 'Project' ? 'Progetto' : 'Pratica'} · {row.admission === 'ORDINARY' ? 'Responsabilità ordinaria' : 'Perimetro personale'}</p>
    <p>Stato: {row.status?.replaceAll('_', ' ') ?? 'Non condiviso'}</p>
    {row.priority !== null && <p>Priorità: {row.priority}</p>}
    {row.client && <p>Cliente: {row.client.name}</p>}
    {(row.technicalOwner || row.commercialOwner) && <p>Responsabile tecnico: {row.technicalOwner?.name ?? 'Non indicato'} · Referente commerciale: {row.commercialOwner?.name ?? 'Non indicato'}</p>}
    {row.responsibility && <p>{technicalResponsibilityLabels[row.responsibility as keyof typeof technicalResponsibilityLabels]}</p>}
    {row.dueDate && <p>Scadenza operativa: {operationalRomeTime(row.dueDate)}</p>}
    {row.expiresAt && <p>Scadenza dell’accesso: {operationalRomeTime(row.expiresAt)}</p>}
    <SecondaryLink href={row.href}>{row.admission === 'SELECTIVE' ? 'Apri incarico tecnico' : 'Apri scheda'}</SecondaryLink>
  </article>)}</div>;
}
export async function OperationalWorkList({ session, kind, path, title, query: raw }: {
  session: AuthSession; kind: TechnicalTargetReference['kind']; path: string; title: string;
  query: Record<string, string | string[] | undefined>;
}) {
  const query = operationalWorkQuery(raw);
  if (!query) notFound();
  const catalogue = await loadOperationalWorkCatalogue(prisma, session, kind).catch(() => null);
  const data = catalogue ? selectOperationalWork(catalogue.records, query) : null;
  const inAssignments = path === '/technical-work';
  const route = (page: number) => operationalWorkListPath(path, query, page, inAssignments ? kind : undefined);
  const states = catalogue ? Object.keys(selectOperationalWork(catalogue.records).stateCounts).sort() : [];
  const records = catalogue?.records ?? [];
  const options = (key: 'client' | 'technicalOwner' | 'commercialOwner') => [...new Map(records.flatMap(row =>
    row[key]?.id ? [[row[key]!.id, { id: row[key]!.id!, name: row[key]!.name }] as const] : [])).values()].sort((a, b) => a.name.localeCompare(b.name));
  const priorities = [...new Set(records.flatMap(row => row.priority ? [row.priority] : []))].sort();
  return <div className="crm-space-y-6"><PageHeader title={title}
    description="Responsabilità ordinarie e incarichi personali validi, senza duplicati. L’apertura non registra presa in carico o avvio del servizio." />
    <nav aria-label="Viste del lavoro tecnico" className="flex flex-wrap gap-3">
      <SecondaryLink href="/projects">Progetti</SecondaryLink><SecondaryLink href="/technical-office/practices">Pratiche tecniche</SecondaryLink>
      <SecondaryLink href={operationalWorkListPath('/technical-work', { q: query.q }, 1, 'TechnicalPractice')}>Pratiche assegnate</SecondaryLink>
      <SecondaryLink href={operationalWorkListPath('/technical-work', { q: query.q }, 1, 'Project')}>Progetti assegnati</SecondaryLink>
      {kind === 'Project' && hasPermission(session, 'project.write') && <>
        <SecondaryLink href="/projects?new=1">Crea progetto base</SecondaryLink>
        <SecondaryLink href="/projects?view=archive">Archivio progetti</SecondaryLink>
        <SecondaryLink href="/projects?view=trash">Cestino progetti</SecondaryLink>
      </>}
      {kind === 'TechnicalPractice' && hasPermission(session, 'technical.write') && <SecondaryLink href="/technical-office/practices?new=1">Nuova pratica</SecondaryLink>}
    </nav>
    <form action={path} method="get" role="search" aria-label="Cerca negli incarichi tecnici" className="grid gap-3 md:grid-cols-3">
      {inAssignments && <input type="hidden" name="kind" value={kind} />}
      {query.active && <input type="hidden" name="dashboard" value="attive" />}
      <label>Cerca per titolo<input id="technical-work-query" type="search" name="q" maxLength={200}
        defaultValue={query.q ?? ''} key={query.q ?? ''} className="block w-full rounded-xl border p-3" /></label>
      <label>Stato<select name="status" aria-label="Stato" defaultValue={query.status ?? ''} className="block w-full rounded-xl border p-3">
        <option value="">Tutti gli stati condivisi</option>{[...new Set([...states, ...(query.status ? [query.status] : [])])].map(s => <option key={s} value={s}>{s.replaceAll('_', ' ')}</option>)}
      </select></label>
      <label>Priorità<select name="priority" defaultValue={query.priority ?? ''} className="block w-full rounded-xl border p-3">
        <option value="">Tutte le priorità condivise</option>{priorities.map(value => <option key={value} value={value}>{value}</option>)}
      </select></label>
      {([['client', 'clientId', 'Cliente'], ['technicalOwner', 'technicalOwnerId', 'Responsabile tecnico'],
        ['commercialOwner', 'commercialOwnerId', 'Referente commerciale']] as const).map(([field, param, label]) =>
        <label key={field}>{label}<select name={param} defaultValue={query[param] ?? ''} className="block w-full rounded-xl border p-3">
          <option value="">Tutti i valori leggibili</option>{options(field).map(person => <option key={person.id} value={person.id}>{person.name}</option>)}
        </select></label>)}
      <PrimaryButton type="submit">{inAssignments ? 'Cerca incarichi' : 'Cerca'}</PrimaryButton>
    </form>
    <p>La ricerca e i conteggi usano solo i campi autorizzati. I documenti disponibili e le operazioni consentite sono indicati nella scheda.</p>
    {query.active && <p role="status">Filtro: pratiche attive con stato leggibile.</p>}
    {catalogue && !catalogue.selectiveAvailable && <p role="status">Gli incarichi personali non sono disponibili. Sono mostrate soltanto le responsabilità ordinarie attualmente autorizzate.</p>}
    <Card title={kind === 'Project' ? 'Progetti' : 'Pratiche'}>
      {!data ? <p role="status">Il lavoro non è disponibile con la sessione e i permessi correnti.</p> : <>
        <p role="status" className="mb-3">{data.total} {kind === 'Project' ? 'progetti' : 'pratiche'} nel filtro autorizzato.</p>
        {!data.records.length ? <EmptyState title={query.q ? 'Nessun incarico corrisponde alla ricerca in questa pagina' : 'Nessun incarico disponibile in questa pagina'} />
          : <OperationalWorkRows records={data.records} />}
      </>}
    </Card><nav aria-label="Pagine incarichi" className="flex flex-wrap gap-3">
      {data && data.page > 1 && <SecondaryLink href={route(data.page - 1)}>Precedenti</SecondaryLink>}
      {data?.hasNext && <SecondaryLink href={route(data.page + 1)}>Successivi</SecondaryLink>}
      <Link className="underline" href={path + (inAssignments ? '?kind=' + kind : '')}>Azzera ricerca</Link>
    </nav>
  </div>;
}
const buckets = [['da_progettare', 'Pratiche da progettare'], ['in_progettazione', 'In progettazione'],
  ['documenti_richiesti', 'Documenti richiesti'], ['documenti_completi', 'Documenti completi'],
  ['pronta_presentazione', 'Pronte per presentazione'], ['presentata', 'Presentate'],
  ['integrazione_richiesta', 'Integrazioni richieste'], ['in_istruttoria', 'In istruttoria'],
  ['approvata', 'Approvate'], ['respinta', 'Respinte']] as const;
export async function OperationalTechnicalHome({ session }: { session: AuthSession }) {
  const catalogue = await loadOperationalWorkCatalogue(prisma, session, 'TechnicalPractice').catch(() => null);
  const data = catalogue ? selectOperationalWork(catalogue.records) : null;
  const due = catalogue ? catalogue.records.filter(row => row.priority === 'urgente' || (row.dueDate &&
    new Date(row.dueDate).getTime() <= new Date(catalogue.observedAt).getTime() + 7 * 86400_000))
    .sort((a, b) => (a.dueDate ?? 'z').localeCompare(b.dueDate ?? 'z')).slice(0, 10) : [];
  return <div className="crm-space-y-6"><PageHeader title="Ufficio Tecnico" description="Il tuo lavoro autorizzato. Responsabilità ordinaria e perimetri personali restano distinti nell’apertura della scheda." />
    <div className="flex flex-wrap gap-3"><SecondaryLink href="/technical-office/practices">Lista pratiche</SecondaryLink>
      <SecondaryLink href="/technical-work">I miei incarichi tecnici</SecondaryLink><SecondaryLink href="/technical-office/integrations">Integrazioni tecniche</SecondaryLink></div>
    {!data ? <p role="status">Le pratiche non sono disponibili con la sessione corrente.</p> : <>
      {!catalogue?.selectiveAvailable && <p role="status">Incarichi personali temporaneamente non disponibili: elenco ordinario parziale.</p>}
      <section aria-label="Pratiche per stato" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{buckets.map(([status, label]) =>
        <Stat key={status} label={label} value={data.stateCounts[status] ?? 0} description="Stato leggibile nel tuo perimetro"
          href={'/technical-office/practices?status=' + status} />)}</section>
      {data.hiddenStatus > 0 && <Card title="Altri incarichi autorizzati"><p>{data.hiddenStatus} pratiche con stato non condiviso.</p><SecondaryLink href="/technical-office/practices">Apri tutte le pratiche autorizzate</SecondaryLink></Card>}
      <Card title="Scadenze urgenti e prossime azioni"><OperationalWorkRows records={due} />
        {!due.length && <EmptyState title="Nessuna scadenza autorizzata nei prossimi sette giorni" />}
      </Card></>}
  </div>;
}
