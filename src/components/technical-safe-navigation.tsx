import Link from 'next/link';
import { readSelectiveProject } from '@/lib/selective-project-access';
import { readPracticeSharing } from '@/lib/selective-practice-access';
import { readTechnicalWork } from '@/lib/technical-assignment-access';
import { redirect, notFound } from 'next/navigation';
import { Card, PageHeader, StatusBadge } from './ui';
import type { AuthSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { canViewProject, canViewTechnicalPractice } from '@/lib/access-control';
import { getProjectReadAccess } from '@/lib/read-access';
import { loadTechnicalPracticeAccessContext } from '@/lib/technical-practice-access';
import { listTechnicalWork } from '@/lib/technical-assignment-access';
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
  return <div className="space-y-5"><PageHeader title={project ? 'Progetto · dati tecnici' : 'Pratica · dati tecnici'}
    description="Dati tecnici del perimetro corrente. Note, documenti non classificati e informazioni commerciali riservate non sono inclusi." />
    <Link className="underline" href="/technical-work">Apri i miei incarichi e le operazioni autorizzate</Link>
    {!project && <Link className="block underline" href={'/assignments/TechnicalPractice/' + encodeURIComponent(p.id)}>Responsabilità e presa in carico personale</Link>}
    <Card title="Informazioni disponibili"><dl className="grid gap-3 sm:grid-cols-2">{fields.map(f => <div key={f.key}>
      <dt className="font-semibold">{f.label}</dt><dd className="break-words">{f.value}</dd></div>)}</dl></Card>
    <p>Gli eventuali importi mostrati provengono dai campi di investimento e finanziamento del progetto. Importi generici, compensi, pagamenti e relative note restano esclusi.</p>
  </div>;
}
export async function TechnicalSafeNavigation({ route, session, props }: { route: string; session: AuthSession; props: Props }) {
  if (route === '/projects/[id]' || route === '/technical-office/practices/[id]') return record(session, route, props);
  const query = await props.searchParams, term = (query?.q ?? '').trim().slice(0, 200).toLocaleLowerCase('it-IT');
  const personal = await Promise.all((['Project', 'TechnicalPractice'] as const).map(async kind => {
    try { return { kind, available: true, ...await listTechnicalWork(prisma, session, kind, 1, term) }; }
    catch { return { kind, available: false, records: [], hasNext: false }; }
  }));
  const projects = hasPermission(session, 'project.read') ? await prisma.project.findMany({
    where: { consultantId: session.userId, deletedAt: null, status: { not: 'archiviato' } }, orderBy: { id: 'asc' }, take: 201 }) : [];
  const practices = hasPermission(session, 'technical.read') ? await prisma.technicalPractice.findMany({
    where: { technicalOwnerId: session.userId, deletedAt: null, status: { not: 'archiviata' } }, orderBy: { id: 'asc' }, take: 201 }) : [];
  const legacy: Array<{ id: string; title: string; status: string; priority: string; href: string }> = [];
  for (const row of projects.slice(0, 200)) {
    const client = await prisma.client.findFirst({ where: { id: row.clientId, deletedAt: null },
      select: { id: true, salesOwnerId: true, consultantId: true } });
    if (client && canViewProject(session, { ...row, client }) && (!term || row.title.toLocaleLowerCase('it-IT').includes(term))) {
      legacy.push({ id: row.id, title: row.title, status: row.status, priority: row.priority, href: '/projects/' + row.id });
    }
  }
  for (const row of practices.slice(0, 200)) {
    const context = await loadTechnicalPracticeAccessContext(prisma, row);
    if (canViewTechnicalPractice(session, { ...row, ...context }) && (!term || row.title.toLocaleLowerCase('it-IT').includes(term))) {
      legacy.push({ id: row.id, title: row.title, status: row.status, priority: row.priority, href: '/technical-office/practices/' + row.id });
    }
  }
  const title = route === '/documents' ? 'Documenti tecnici consentiti' : route === '/search' ? 'Ricerca nel perimetro tecnico'
    : route.startsWith('/notifications') ? 'Notifiche · perimetro tecnico' : route.startsWith('/communications') ? 'Comunicazioni · perimetro tecnico' : 'Ufficio Tecnico';
  return <div className="space-y-5"><PageHeader title={title}
    description="Ogni incarico mantiene destinatario, responsabilità, scadenza, campi, operazioni e singole versioni autorizzate." />
    <form className="flex gap-3"><label>Cerca incarico<input className="block rounded-lg border p-2" name="q" defaultValue={query?.q ?? ''} /></label><button className="underline">Cerca</button></form>
    {route.startsWith('/communications') || route.startsWith('/notifications') ? <p>I messaggi e le note non classificati restano riservati. Apri l’incarico per stato, scadenze e operazioni effettivamente disponibili.</p> : null}
    {term && personal.every(group => group.available && group.records.length === 0) && legacy.length === 0 && <p>Nessun risultato trovato nel perimetro tecnico.</p>}
    {personal.map(group => <Card key={group.kind} title={group.kind === 'Project' ? 'Progetti assegnati personalmente' : 'Pratiche assegnate personalmente'}>
      {!group.available ? <p>Consultazione degli incarichi temporaneamente non disponibile. Nessun contenuto sostitutivo viene mostrato.</p>
        : group.records.length === 0 ? <p>Nessun incarico personale disponibile con questi criteri.</p>
          : <ul className="space-y-3">{group.records.map(row => <li key={row.target.targetId}>
            <Link className="font-semibold underline" href={technicalWorkPath(row.target)}>{row.title}</Link>
            <p>{row.responsibility.replaceAll('_', ' ')} · accesso fino al {operationalRomeTime(row.expiresAt)}</p>
          </li>)}</ul>}
      {group.hasNext && <Link className="underline" href={'/technical-work?kind=' + group.kind}>Tutti gli incarichi</Link>}
    </Card>)}
    {legacy.length > 0 && <Card title="Responsabilità tecniche esistenti"><ul className="space-y-3">{legacy.map(row => <li key={row.id}>
      <Link className="font-semibold underline" href={row.href}>{row.title}</Link> · <StatusBadge status={row.status} /> · {row.priority}
    </li>)}</ul></Card>}
    <p>I documenti si aprono dall’incarico: sono disponibili solo le versioni scelte e classificate dall’Admin. Un ruolo o un collegamento al cliente non concede altri file.</p>
  </div>;
}
