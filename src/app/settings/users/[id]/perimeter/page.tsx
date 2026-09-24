import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Card, PageHeader } from '@/components/ui';
import { ClientReadPerimeterForm } from '@/components/client-read-perimeter-form';
import { requirePermission } from '@/lib/auth';
import { perimeterRoles } from '@/lib/client-read-perimeter-policy';
import { prisma } from '@/lib/prisma';

export default async function Page({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<{ q?: string; after?: string; grantsAfter?: string }>;
}) {
  const session = await requirePermission('user.read');
  if (session.role !== 'admin') notFound();
  const { id } = await params, query = await searchParams;
  const user = await prisma.user.findUnique({ where: { id }, select: { id: true, name: true, role: true, active: true, deletedAt: true } });
  if (!user) notFound();
  const available = user.active && !user.deletedAt && perimeterRoles.includes(user.role);
  const cursor = (value?: string) => value && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : undefined;
  const q = (query.q ?? '').trim().slice(0, 120), after = cursor(query.after), grantsAfter = cursor(query.grantsAfter);
  const [grants, candidates] = await Promise.all([
    prisma.clientReadGrant.findMany({ where: { userId: id, ...(grantsAfter ? { id: { gt: grantsAfter } } : {}) }, orderBy: { id: 'asc' }, take: 51,
      include: { client: { select: { displayName: true, deletedAt: true } }, updatedBy: { select: { name: true } } } }),
    available && q ? prisma.client.findMany({ where: { deletedAt: null, displayName: { contains: q, mode: 'insensitive' }, ...(after ? { id: { gt: after } } : {}) },
      orderBy: { id: 'asc' }, take: 26, select: { id: true, displayName: true, readGrants: { where: { userId: id }, select: { active: true, version: true } } } }) : [],
  ]);
  const href = (values: Record<string, string>) => `/settings/users/${id}/perimeter?${new URLSearchParams(values)}`;
  return <div className="space-y-6">
    <PageHeader title={`Perimetro di consultazione: ${user.name}`} description="L’admin consente la lettura di clienti specifici. Le assegnazioni operative e i permessi sulle funzioni e sui dati sensibili restano necessari e separati." />
    <Link href={`/settings/users/${id}`}>Torna al profilo</Link>
    <p>La revoca di una consultazione aggiuntiva non revoca una responsabilità operativa già assegnata. I cambi sono applicati alla richiesta successiva anche nelle sessioni aperte.</p>
    {!available ? <p>Non è possibile aggiungere consultazioni a questo account. Le autorizzazioni precedenti restano consultabili e revocabili.</p> : <Card title="Aggiungi un cliente">
      <form method="get" className="flex gap-3"><label>Nome del cliente<input name="q" defaultValue={q} maxLength={120} className="ml-2 rounded-lg border p-2" required /></label><button className="rounded-lg border px-3">Cerca</button></form>
      {q && candidates.length === 0 ? <p>Nessun cliente trovato.</p> : null}
      <ul className="space-y-3">{candidates.slice(0, 25).map(client => <li key={client.id} className="rounded-xl border p-3"><p className="font-bold">{client.displayName}</p>{client.readGrants[0]?.active ? <p>Consultazione già consentita.</p> : <ClientReadPerimeterForm userId={id} clientId={client.id} version={client.readGrants[0]?.version ?? 0} active label={client.displayName} />}</li>)}</ul>
      {candidates.length > 25 ? <Link href={href({ q, after: candidates[24].id })}>Altri clienti</Link> : null}
    </Card>}
    <Card title="Consultazioni e revoche">
      {grants.length === 0 ? <p>Nessuna consultazione aggiuntiva in questa pagina.</p> : <ul className="space-y-3">{grants.slice(0, 50).map(grant => <li key={grant.id} className="rounded-xl border p-3">
        <p className="font-bold">{grant.client.displayName}</p><p>{grant.active ? 'Consentita' : 'Revocata'}{grant.client.deletedAt ? ' · cliente archiviato, consultazione non disponibile' : ''}</p>
        <p>Decisione di {grant.updatedBy.name} · {grant.updatedAt.toISOString()} · revisione {grant.version}</p>
        {grant.active || (available && !grant.client.deletedAt) ? <ClientReadPerimeterForm userId={id} clientId={grant.clientId} version={grant.version} active={!grant.active} label={grant.client.displayName} /> : null}
      </li>)}</ul>}
      {grants.length > 50 ? <Link href={href({ grantsAfter: grants[49].id })}>Altre consultazioni</Link> : null}
    </Card>
  </div>;
}
