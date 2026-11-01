import { listOrdinaryTechnicalDocuments } from '@/lib/technical-ordinary-documents';
import Link from 'next/link';
import { readSelectiveProject } from '@/lib/selective-project-access';
import { readPracticeSharing } from '@/lib/selective-practice-access';
import { readTechnicalWork } from '@/lib/technical-assignment-access';
import { redirect, notFound } from 'next/navigation';
import { Card, PageHeader } from './ui';
import type { AuthSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { canViewTechnicalPractice } from '@/lib/access-control';
import { getProjectReadAccess } from '@/lib/read-access';
import { loadTechnicalPracticeAccessContext } from '@/lib/technical-practice-access';
import { loadOperationalWorkCatalogue } from '@/lib/operational-work';
import { selectOperationalWork } from '@/lib/operational-work-projection';
import { operationalWorkQuery } from '@/lib/operational-work-query';
import { OperationalWorkList, OperationalWorkRows, OperationalTechnicalHome } from './operational-work-list';
import { OperationalTechnicalDashboard } from './operational-technical-dashboard';
import { technicalFieldsFor } from '@/lib/technical-confidentiality';
import { technicalWorkPath } from '@/lib/technical-assignment-display';
import { operationalRomeTime } from '@/lib/operational-time';
import { hasPermission } from '@/lib/permission-evaluator';

type Props = { params?: Promise<Record<string, string>>; searchParams?: Promise<Record<string, string>> };
const labels: Record<string, string> = { title: 'Titolo', status: 'Stato', priority: 'Priorità',
  technicalOwnerName: 'Responsabile tecnico', commercialOwnerName: 'Referente commerciale',
  totalInvestment: 'Investimento previsto del progetto', requestedAmount: 'Agevolazione o finanziamento richiesto dal progetto',
  practiceType: 'Tipo pratica', dueDate: 'Scadenza', targetEntity: 'Ente', targetPortal: 'Portale',
  protocolNumber: 'Protocollo', submittedAt: 'Presentata il', nextClientUpdateAt: 'Prossimo aggiornamento cliente' };
async function names(technical: string | null, commercial: string | null) {
  const people = await prisma.user.findMany({ where: { id: { in: [technical, commercial].filter((v): v is string => !!v) } },
    select: { id: true, name: true } });
  return { technicalOwnerName: people.find(p => p.id === technical)?.name ?? null,
    commercialOwnerName: people.find(p => p.id === commercial)?.name ?? null };
}
function projectedFields(kind: string, row: Record<string, unknown>) {
  return technicalFieldsFor(kind, Object.keys(labels)).map(key => ({ key, label: labels[key],
    value: row[key] instanceof Date ? operationalRomeTime(row[key] as Date) : row[key] == null ? '—' : String(row[key]) }));
}
async function selectedRecord(session: AuthSession, kind: 'Project' | 'TechnicalPractice', id: string): Promise<never> {
  // A canonical URL does not bypass a permanent selective ceiling. Redirect
  // only after the SAME current grant admits the dedicated projection.
  const personal = await readTechnicalWork(prisma, session, { kind, targetId: id }).catch(() => null);
  if (personal) redirect(technicalWorkPath({ kind, targetId: id }));
  const selected = await (kind === 'Project' ? readSelectiveProject(prisma, session, id)
    : readPracticeSharing(prisma, session, id)).catch(() => null);
  if (selected) redirect((kind === 'Project' ? '/shared-projects/' : '/shared-practices/') + encodeURIComponent(id));
  notFound();
}
async function record(session: AuthSession, route: string, props: Props) {
  const p = await props.params; if (!p?.id) notFound();
  const project = route === '/projects/[id]';
  if (!hasPermission(session, project ? 'project.read' : 'technical.read')) notFound();
  let fields: ReturnType<typeof projectedFields>;
  if (project) {
    const row = await getProjectReadAccess(session, p.id); if (!row) return selectedRecord(session, 'Project', p.id);
    fields = projectedFields('Project', { ...row, ...await names(row.consultantId, row.client?.salesOwnerId ?? null) });
  } else {
    const row = await prisma.technicalPractice.findFirst({ where: { id: p.id, deletedAt: null } });
    if (!row) notFound();
    const context = await loadTechnicalPracticeAccessContext(prisma, row);
    if (!canViewTechnicalPractice(session, { ...row, ...context })) return selectedRecord(session, 'TechnicalPractice', p.id);
    fields = projectedFields('TechnicalPractice', { ...row, ...await names(row.technicalOwnerId, row.commercialOwnerId) });
  }
  const documents = await listOrdinaryTechnicalDocuments(prisma, session, { kind: project ? 'Project' : 'TechnicalPractice', targetId: p.id }).catch(() => null);
  return <div className="space-y-5"><PageHeader title={project ? 'Progetto · dati tecnici' : 'Pratica · dati tecnici'}
    description="Dati tecnici del perimetro corrente. Note, documenti non classificati e informazioni commerciali riservate non sono inclusi." />
    <Link className="underline" href="/technical-work">Apri i miei incarichi e le operazioni autorizzate</Link>
    {!project && <Link className="block underline" href={'/assignments/TechnicalPractice/' + encodeURIComponent(p.id)}>Responsabilità e presa in carico personale</Link>}
    <Card title="Informazioni disponibili"><dl className="grid gap-3 sm:grid-cols-2">{fields.map(f => <div key={f.key}>
      <dt className="font-semibold">{f.label}</dt><dd className="break-words">{f.value}</dd></div>)}</dl></Card>
    <Card title="Documenti tecnici disponibili">{!documents || documents.limited
      ? <p>Consultazione documentale temporaneamente non disponibile. Non viene mostrato un elenco parziale.</p>
      : documents.items.length === 0 ? <p>Nessuna versione classificata e disponibile nel perimetro corrente.</p>
        : documents.items.map(d => <article key={d.versionId} className="my-3 rounded-lg border p-3">
          <p className="font-semibold">{d.title}</p><p>{d.fileName} · Versione {d.version}</p>
          <span className="flex gap-4">
            <a className="underline" href={'/documents/' + encodeURIComponent(d.id) + '/view?versionId=' + encodeURIComponent(d.versionId)} target="_blank" rel="noopener noreferrer">Visualizza</a>
            <a className="underline" href={'/documents/' + encodeURIComponent(d.id) + '/download?versionId=' + encodeURIComponent(d.versionId)}>Scarica</a>
          </span>
        </article>)}</Card>
    <p>Gli eventuali importi mostrati provengono dai campi di investimento e finanziamento del progetto. Importi generici, compensi, pagamenti e relative note restano esclusi.</p>
  </div>;
}
export async function TechnicalSafeNavigation({ route, session, props }: { route: string; session: AuthSession; props: Props }) {
  if (route === '/projects/[id]' || route === '/technical-office/practices/[id]') return record(session, route, props);
  const raw = await props.searchParams ?? {};
  // A revoked area permission denies the whole ordinary entry point. A valid
  // selective assignment is still rechecked on its own dedicated route.
  if ((route === '/technical-office' || route === '/technical-office/practices') && !hasPermission(session, 'technical.read')) notFound();
  if (route === '/projects' && !hasPermission(session, 'project.read')) notFound();
  if (route === '/dashboard') return <OperationalTechnicalDashboard session={session} view={raw.view} />;
  if (route === '/technical-office') return <OperationalTechnicalHome session={session} />;
  if (route === '/projects' || route === '/technical-office/practices') return <OperationalWorkList session={session}
    kind={route === '/projects' ? 'Project' : 'TechnicalPractice'} path={route}
    title={route === '/projects' ? 'Progetti' : 'Pratiche tecniche'} query={raw} />;
  const query = operationalWorkQuery(raw); if (!query) notFound();
  const groups = await Promise.all((['Project', 'TechnicalPractice'] as const).map(async kind => {
    try {
      const catalogue = await loadOperationalWorkCatalogue(prisma, session, kind);
      return { kind, available: true, ...selectOperationalWork(catalogue.records, query) };
    } catch { return { kind, available: false, records: [], page: query.page ?? 1, hasNext: false }; }
  }));
  const title = route === '/documents' ? 'Documenti tecnici consentiti' : route === '/search' ? 'Ricerca nel perimetro tecnico'
    : route.startsWith('/notifications') ? 'Notifiche · perimetro tecnico' : route.startsWith('/communications') ? 'Comunicazioni · perimetro tecnico'
      : route === '/tasks' || route === '/deadlines' || route === '/document-checklists' ? 'Incarichi · attività e scadenze' : 'Ufficio Tecnico';
  return <div className="space-y-5"><PageHeader title={title}
    description="Ogni incarico mantiene destinatario, responsabilità, scadenza, campi, operazioni e singole versioni autorizzate." />
    {(route.startsWith('/notifications') || route.startsWith('/communications')) && <Link className="block underline" href="/notifications/updates">Apri aggiornamenti e promemoria selezionati</Link>}
    <form className="flex gap-3"><label>Cerca incarico<input className="block rounded-lg border p-2" name="q" defaultValue={query.q ?? ''} /></label><button className="underline">Cerca</button></form>
    {route.startsWith('/communications') || route.startsWith('/notifications') ? <p>I messaggi e le note non classificati restano riservati. Apri l’incarico per stato, scadenze e operazioni effettivamente disponibili.</p> : null}
    {query.q && groups.every(group => group.available && group.records.length === 0) && <p>Nessun risultato trovato nel perimetro tecnico.</p>}
    {groups.map(group => <Card key={group.kind} title={group.kind === 'Project' ? 'Progetti disponibili' : 'Pratiche disponibili'}>
      {!group.available ? <p>Consultazione degli incarichi temporaneamente non disponibile. Nessun contenuto sostitutivo viene mostrato.</p>
        : group.records.length === 0 ? <p>Nessun incarico disponibile con questi criteri.</p> : <OperationalWorkRows records={group.records} />}
      <Link className="block underline" href={'/technical-work?kind=' + group.kind + (query.q ? '&q=' + encodeURIComponent(query.q) : '')}>
        {group.hasNext ? 'Tutti gli incarichi · altre pagine disponibili' : 'Apri elenco e filtri degli incarichi'}</Link>
    </Card>)}
    <p>I documenti e le attività si aprono dall’incarico. Sono disponibili solo le versioni ammesse e classificate dall’Admin; un collegamento al cliente non concede altri file.</p>
  </div>;
}
