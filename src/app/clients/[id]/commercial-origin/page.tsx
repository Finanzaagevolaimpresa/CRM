import Link from 'next/link';
import { SecondaryLink } from '@/components/actions';
import { Card, EmptyState, PageHeader, formatDateTime } from '@/components/ui';
import { CommercialOriginForm } from '@/components/commercial-origin-form';
import { hasPermission, requirePermission } from '@/lib/auth';
import { getClientReadAccess } from '@/lib/read-access';
import { readCommercialOrigin, readCommercialOriginHistory } from '@/lib/commercial-origin';
import { prisma } from '@/lib/prisma';
import { UserFacingActionError } from '@/lib/action-errors';

export const dynamic = 'force-dynamic';
export default async function Page({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ q?: string; after?: string; before?: string }>;
}) {
  const session = await requirePermission('client.read');
  const { id } = await params, query = await searchParams;
  const access = await getClientReadAccess(session, id);
  if (!access) return <PageHeader title="Provenienza non accessibile" description="Cliente non disponibile o non autorizzato." />;
  const client = await prisma.client.findFirst({ where: { id, deletedAt: null }, select: { displayName: true, salesOwnerId: true, consultantId: true } });
  if (!client) return <PageHeader title="Provenienza non accessibile" description="Cliente non disponibile." />;
  const canRecord = session.role === 'admin' && hasPermission(session, 'client.write');
  const q = (query.q ?? '').trim().slice(0, 120);
  const after = /^[a-zA-Z0-9_-]{1,128}$/.test(query.after ?? '') ? query.after : undefined;
  const before = /^[a-zA-Z0-9_-]{1,128}$/.test(query.before ?? '') ? query.before : undefined;
  let current: Awaited<ReturnType<typeof readCommercialOrigin>>;
  let history: Awaited<ReturnType<typeof readCommercialOriginHistory>>;
  try {
    [current, history] = await Promise.all([readCommercialOrigin(prisma, id), readCommercialOriginHistory(prisma, id, before)]);
  } catch (error) {
    if (!(error instanceof UserFacingActionError)) throw error;
    return <div className="space-y-4"><PageHeader title="Provenienza da verificare" description={error.message} /><SecondaryLink href={`/clients/${id}`}>Fascicolo cliente</SecondaryLink></div>;
  }
  const referencedIds = [...new Set([
    client.salesOwnerId, client.consultantId, current?.snapshot.acquiredById, current?.snapshot.contractedById,
    ...history.entries.flatMap(entry => [entry.actorId, entry.snapshot.acquiredById, entry.snapshot.contractedById]),
  ].filter((value): value is string => Boolean(value)))];
  const userSelect = { id: true, name: true, active: true, deletedAt: true } as const;
  const [referencedUsers, candidates] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: referencedIds } }, select: userSelect }),
    canRecord ? prisma.user.findMany({ where: { ...(q ? { name: { contains: q, mode: 'insensitive' as const } } : {}), ...(after ? { id: { gt: after } } : {}) }, orderBy: { id: 'asc' }, take: 26, select: userSelect }) : Promise.resolve([]),
  ]);
  const userById = new Map(referencedUsers.map(user => [user.id, user]));
  const nameOf = (userId: string | null | undefined) => {
    if (!userId) return 'Non documentato';
    const user = userById.get(userId);
    return user ? `${user.name}${user.deletedAt ? ' (rimosso)' : !user.active ? ' (sospeso)' : ''}` : 'Identità storica non più presente';
  };
  const selectedIds = new Set([current?.snapshot.acquiredById, current?.snapshot.contractedById]);
  const choices = [...new Map([...referencedUsers.filter(user => selectedIds.has(user.id)), ...candidates.slice(0, 25)].map(user => [user.id, user])).values()];
  const path = `/clients/${id}/commercial-origin`;
  return <div className="space-y-6">
    <PageHeader title={`Provenienza commerciale — ${client.displayName}`} description="Identità documentate per acquisizione e contratto, distinte dai responsabili operativi attuali." />
    <SecondaryLink href={`/clients/${id}`}>Fascicolo cliente</SecondaryLink>
    <Card title="Origine documentata">
      {current ? <div className="space-y-2 text-sm"><p>Acquisizione: {nameOf(current.snapshot.acquiredById)}</p><p>Contrattualizzazione: {nameOf(current.snapshot.contractedById)}</p><p>Riferimento: {current.snapshot.sourceReference}</p><p>Revisione {current.snapshot.revision}</p></div>
        : <EmptyState title="Provenienza non ancora documentata">Il responsabile attuale non viene considerato automaticamente il commerciale originario.</EmptyState>}
      <p className="mt-4 text-sm">Responsabile commerciale attuale: {nameOf(client.salesOwnerId)}. Responsabile tecnico attuale: {nameOf(client.consultantId)}.</p>
      <p className="mt-2 text-sm text-slate-600">La provenienza non assegna attività e non concede accesso al fascicolo.</p>
    </Card>
    {canRecord && <Card title={current ? 'Rettifica motivata' : 'Registra origine documentata'}>
      <p className="mb-3 text-sm">Indica le identità risultanti dalle prove disponibili e un riferimento alla fonte. La registrazione resta distinta dalla verifica dei documenti. Una rettifica aggiunge una nuova versione e conserva le precedenti.</p>
      <form method="get" className="mb-3 flex gap-2"><label>Cerca identità<input name="q" defaultValue={q} className="ml-2 rounded-xl border p-2" /></label><button className="rounded-xl border p-2">Cerca</button></form>
      <CommercialOriginForm key={`${current?.id ?? 'initial'}:${q}:${after ?? ''}`} clientId={id} entryId={current?.id ?? null} current={current?.snapshot ?? null} users={choices.map(user => ({ ...user, deletedAt: user.deletedAt?.toISOString() ?? null }))} />
      {candidates.length > 25 && <Link className="mt-3 inline-block underline" href={`${path}?${new URLSearchParams({ q, after: candidates[24].id })}`}>Altre identità</Link>}
    </Card>}
    <Card title="Storico della provenienza">
      {history.entries.length ? <ol className="space-y-4">{history.entries.map(entry => <li key={entry.id} className="rounded-xl border p-3">
        <h3 className="font-bold">Revisione {entry.snapshot.revision}</h3>
        <p>Registrata da {nameOf(entry.actorId)} il {formatDateTime(entry.createdAt)}</p>
        <p>Acquisizione: {nameOf(entry.snapshot.acquiredById)} · Contrattualizzazione: {nameOf(entry.snapshot.contractedById)}</p>
        <p>Riferimento: {entry.snapshot.sourceReference}</p><p>Motivazione: {entry.snapshot.reason}</p>
      </li>)}</ol> : <p>Nessuna registrazione.</p>}
      {history.next && <Link className="mt-3 inline-block underline" href={`${path}?${new URLSearchParams({ before: history.next })}`}>Versioni precedenti</Link>}
    </Card>
  </div>;
}
