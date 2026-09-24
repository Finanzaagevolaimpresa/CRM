import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card, Table } from '@/components/ui';
import { requirePermission } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { exceptionKinds, loadAssignmentExceptions, type ExceptionKind } from '@/lib/assignment-exceptions';
import { withSerializableTransaction } from '@/lib/serializable';
import { internalSessionMode } from '@/lib/session';

export const dynamic = 'force-dynamic';
const labels = { leads: 'Lead', clients: 'Clienti', projects: 'Progetti', tasks: 'Attività', services: 'Servizi', practices: 'Pratiche' };
export default async function AssignmentExceptionsPage({ searchParams }: { searchParams: Promise<{ kind?: string; after?: string }> }) {
  const session = await requirePermission('user.write');
  if (session.role !== 'admin') notFound();
  if (internalSessionMode() !== 'registry') return <Card title="Coda eccezioni">Gestione non disponibile.</Card>;
  const query = await searchParams;
  const kind = exceptionKinds.includes(query.kind as ExceptionKind) ? query.kind as ExceptionKind : 'leads';
  if (query.after && !/^[A-Za-z0-9_-]{1,128}$/u.test(query.after)) notFound();
  const result = await withSerializableTransaction(prisma, tx => loadAssignmentExceptions(tx, session, kind, query.after));
  const users = new Map(result.users.map(user => [user.id, user]));
  return <div className="space-y-6"><Card title="Coda eccezioni delle assegnazioni">
    <p>Riferimenti conservati di utenti sospesi o rimossi. L’amministratore può aprire la scheda e riassegnare; una sospensione non trasferisce automaticamente le attività. Sono inclusi anche i riferimenti storici a lavori completati.</p>
    <nav aria-label="Tipo di assegnazione" className="mt-4 flex flex-wrap gap-4">{exceptionKinds.map(key => <Link key={key} aria-current={kind === key ? 'page' : undefined} href={`/settings/assignment-exceptions?kind=${key}`}>{labels[key]} ({result.counts[key]})</Link>)}</nav>
  </Card><Card title={labels[kind]}>
    {result.rows.length ? <Table headers={['Riferimento', 'Stato', 'Responsabile non disponibile', 'Azione']} rows={result.rows.map(row => [
      row.title, `${row.status} — ${row.historical ? 'Riferimento storico: lavoro concluso' : 'Stato corrente'}`, row.ownerIds.map(id => `${users.get(id)?.name ?? id} (${users.get(id)?.deletedAt ? 'rimosso' : 'sospeso'})`).join(', '),
      <Link key={row.id} href={row.href}>Apri scheda</Link>,
    ])} /> : <p>Nessun riferimento in questa coda.</p>}
    {result.next ? <Link className="mt-4 inline-block" href={`/settings/assignment-exceptions?kind=${kind}&after=${encodeURIComponent(result.next)}`}>Pagina successiva</Link> : null}
  </Card><Link href="/settings/users">Torna agli utenti</Link></div>;
}
