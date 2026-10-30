export const dynamic = 'force-dynamic';
import Link from 'next/link';
import { Card, EmptyState, PageHeader } from '@/components/ui';
import { requirePermission } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { listAccessibleTasks } from '@/lib/read-access';
import { listAdminRecords } from '@/lib/admin-records';
import { operationalRomeTime } from '@/lib/operational-time';

export default async function Page() {
  const session = await requirePermission('service.read');
  const tasks = await listAccessibleTasks(session, { where: { deletedAt: null, dueAt: { not: null }, status: { not: 'completata' } }, orderBy: { dueAt: 'asc' }, take: 101 });
  const manual = session.role === 'admin' ? await listAdminRecords(prisma, session, 'Deadline') : null;
  return <div className="crm-space-y-6"><PageHeader title="Scadenze" description="Date delle attività aperte e scadenze amministrative collegate alle schede operative. Gli orari sono espressi nel fuso di Roma." />
    <nav className="flex flex-wrap gap-4"><Link className="underline" href="/tasks">Attività e assegnazioni</Link><Link className="underline" href="/technical-office/practices">Date e avanzamento delle pratiche</Link>
      {session.role === 'admin' && <><Link className="underline" href="/admin/records/Deadline/new">Aggiungi scadenza</Link><Link className="underline" href="/admin/records/Deadline">Modifica scadenze e ripristino</Link></>}</nav>
    <Card title="Attività aperte con scadenza">{tasks.length === 0 ? <EmptyState title="Nessuna attività aperta con una scadenza disponibile" /> :
      <ul className="space-y-3">{tasks.slice(0, 100).map(task => <li key={task.id} className="rounded-xl border p-4">
        <Link className="font-bold underline" href={session.role === 'admin' ? `/admin/records/Task/${task.id}` : '/tasks'}>{task.title}</Link>
        <p>{operationalRomeTime(task.dueAt?.toISOString())} · {task.status.replaceAll('_', ' ')}</p>
      </li>)}</ul>}{tasks.length > 100 && <p>Sono mostrate le prime 100 scadenze. Apri l’elenco attività per continuare.</p>}</Card>
    {manual && <Card title="Scadenze amministrative">{manual.rows.length === 0 ? <EmptyState title="Nessuna scadenza amministrativa registrata" /> :
      <ul className="space-y-3">{manual.rows.map(row => <li key={row.id} className="rounded-xl border p-4"><Link className="font-bold underline" href={`/admin/records/Deadline/${row.id}`}>{row.label}</Link>
        <p>{operationalRomeTime(row.dueAt)} · {row.status.replaceAll('_', ' ')}</p></li>)}</ul>}
      {manual.hasNext && <Link className="underline" href="/admin/records/Deadline?page=2">Altre scadenze</Link>}</Card>}
  </div>;
}
