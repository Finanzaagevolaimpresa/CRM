import Link from 'next/link';
import { Card, PageHeader } from '@/components/ui';
import { hasPermission, requireAnyPermission } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { responsibilityContext } from '@/lib/responsibility';

export const dynamic = 'force-dynamic';
export default async function Page({ searchParams }: { searchParams: Promise<{ kind?: string; after?: string }> }) {
  const session = await requireAnyPermission(['lead.read', 'technical.read']), query = await searchParams;
  const kind = query.kind === 'TechnicalPractice' || !hasPermission(session, 'lead.read') ? 'TechnicalPractice' : 'Lead';
  const canRead = hasPermission(session, kind === 'Lead' ? 'lead.read' : 'technical.read');
  const after = query.after && /^[a-zA-Z0-9_-]{1,128}$/.test(query.after) ? query.after : undefined;
  const cursor = after ? { id: { gt: after } } : {};
  const rows = !canRead ? [] : kind === 'Lead'
    ? await prisma.lead.findMany({ where: { ...cursor, deletedAt: null, assignedToId: session.userId,
      status: { notIn: ['archiviato', 'cliente_acquisito', 'vinto', 'perso', 'non_qualificato'] } }, orderBy: { id: 'asc' }, take: 26,
      select: { id: true, companyName: true, firstName: true, lastName: true } }).then(leads => leads.map(row => ({ id: row.id, title: row.companyName || `${row.firstName} ${row.lastName}` })))
    : await prisma.technicalPractice.findMany({ where: { ...cursor, deletedAt: null, OR: [{ commercialOwnerId: session.userId }, { technicalOwnerId: session.userId }],
      status: { notIn: ['archiviata', 'approvata', 'respinta'] } }, orderBy: { id: 'asc' }, take: 26, select: { id: true, title: true } });
  const visible = (await Promise.all(rows.slice(0, 25).map(async row => await responsibilityContext(prisma, kind, row.id) ? row : null))).filter(row => row !== null);
  return <div className="space-y-6"><PageHeader title="Le mie assegnazioni" description="Lavori assegnati personalmente dall’amministratore. Apri la scheda per verificare responsabilità, storico e presa in carico." />
    <div className="flex gap-4">{hasPermission(session, 'lead.read') && <Link href="/assignments?kind=Lead">Lead assegnati</Link>}{hasPermission(session, 'technical.read') && <Link href="/assignments?kind=TechnicalPractice">Pratiche assegnate</Link>}</div>
    <Card title={kind === 'Lead' ? 'Lead assegnati' : 'Pratiche assegnate'}><ul className="space-y-3">{visible.map(row => <li key={row.id}><Link className="underline" href={`/assignments/${kind}/${row.id}`}>{row.title}</Link></li>)}</ul>
      {!visible.length && <p>Nessuna assegnazione in questa pagina.</p>}
      {rows.length > 25 && <Link href={`/assignments?${new URLSearchParams({ kind, after: rows[24].id })}`}>Altre assegnazioni</Link>}
    </Card></div>;
}
