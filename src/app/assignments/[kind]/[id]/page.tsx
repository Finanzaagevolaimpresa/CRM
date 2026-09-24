import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card, PageHeader, formatDateTime } from '@/components/ui';
import { ResponsibilityAcceptanceForm, ResponsibilityAssignmentForm } from '@/components/responsibility-forms';
import { requirePermission, hasPermission } from '@/lib/auth';
import { canViewLead, canViewTechnicalPractice } from '@/lib/access-control';
import { prisma } from '@/lib/prisma';
import { readResponsibility, responsibilityContext } from '@/lib/responsibility';
import { responsibilityAcceptance, responsibilityDecision, responsibilityKind } from '@/lib/responsibility-contract';
import { UserFacingActionError } from '@/lib/action-errors';

export const dynamic = 'force-dynamic';
export default async function Page({ params, searchParams }: {
  params: Promise<{ kind: string; id: string }>; searchParams: Promise<{ before?: string; q?: string; after?: string }>;
}) {
  const { kind: rawKind, id } = await params, query = await searchParams;
  const parsed = responsibilityKind.safeParse(rawKind); if (!parsed.success) notFound();
  const kind = parsed.data, session = await requirePermission(kind === 'Lead' ? 'lead.read' : 'technical.read');
  if (kind === 'Lead') {
    const lead = await prisma.lead.findFirst({ where: { id, deletedAt: null } });
    if (!lead || !canViewLead(session, lead)) notFound();
  } else {
    const practice = await prisma.technicalPractice.findFirst({ where: { id, deletedAt: null } });
    const client = practice && await prisma.client.findFirst({ where: { id: practice.clientId, deletedAt: null } });
    if (!practice || !client || !canViewTechnicalPractice(session, { ...practice, client }) || !await responsibilityContext(prisma, kind, id)) notFound();
  }
  const path = `/assignments/${kind}/${id}`, source = kind === 'Lead' ? `/leads/${id}` : `/technical-office/practices/${id}`;
  let data: Awaited<ReturnType<typeof readResponsibility>>;
  try { data = await readResponsibility(prisma, kind, id, query.before); }
  catch (error) { if (!(error instanceof UserFacingActionError)) throw error;
    return <Card title="Responsabilità da verificare"><p>{error.message}</p><Link href={source}>Torna alla scheda</Link></Card>; }
  const snapshots = data.history.map(row => ({ row, decision: responsibilityDecision.safeParse(row.after), acceptance: responsibilityAcceptance.safeParse(row.after) }));
  const currentState = data.context?.state ?? data.current?.decision.state;
  const ids = [...new Set([currentState?.commercialOwnerId, currentState?.technicalOwnerId, data.current?.actorId,
    ...snapshots.flatMap(entry => [entry.row.actorId, ...(entry.decision.success ? [entry.decision.data.state.commercialOwnerId, entry.decision.data.state.technicalOwnerId] : [])])].filter((value): value is string => Boolean(value)))];
  const named = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, active: true, deletedAt: true, role: true } });
  const userMap = new Map(named.map(user => [user.id, user]));
  const nameOf = (userId: string | null | undefined) => { const user = userId ? userMap.get(userId) : null;
    return user ? user.name + (user.deletedAt ? ' (rimosso)' : !user.active ? ' (sospeso)' : '') : userId ? 'Identità storica non presente' : 'Non assegnato'; };
  const q = (query.q ?? '').trim().slice(0, 120), after = query.after && /^[a-zA-Z0-9_-]{1,128}$/.test(query.after) ? query.after : undefined;
  const candidates = session.role === 'admin' ? await prisma.user.findMany({ where: { active: true, deletedAt: null, role: { in: ['admin', 'direzione', 'commerciale', 'consulente', 'backoffice'] },
    ...(q ? { name: { contains: q, mode: 'insensitive' } } : {}), ...(after ? { id: { gt: after } } : {}) }, orderBy: { id: 'asc' }, take: 26, select: { id: true, name: true, role: true } }) : [];
  const choices = [...new Map([...named.filter(user => [currentState?.commercialOwnerId, currentState?.technicalOwnerId].includes(user.id)).map(user => ({ ...user, name: nameOf(user.id) })), ...candidates.slice(0, 25)].map(user => [user.id, user])).values()];
  return <div className="space-y-6"><PageHeader title="Responsabilità e presa in carico" description="La decisione dell’amministratore e la conferma personale del referente sono registrazioni distinte." />
    <div className="flex gap-4"><Link href={source}>Torna alla scheda</Link><Link href="/assignments">Le mie assegnazioni</Link></div>
    <Card title="Decisione corrente">
      <p>Commerciale: {nameOf(currentState?.commercialOwnerId)}</p>
      {kind === 'TechnicalPractice' && <><p>Reparto tecnico: {data.current?.decision.departmentCode ?? 'Non indicato'}</p><p>Referente tecnico: {nameOf(currentState?.technicalOwnerId)}</p>
        {!currentState?.technicalOwnerId && <p>Referente individuale mancante: presa in carico tecnica non avvenuta.</p>}</>}
      {data.current ? <p>Decisione di {nameOf(data.current.actorId)} · {formatDateTime(data.current.createdAt)} · revisione {data.current.decision.version}</p> : <p>Assegnazione preesistente: l’amministratore deve confermarla prima della presa in carico.</p>}
      {!data.valid && <p>La decisione non è utilizzabile per una nuova presa in carico. È necessaria la verifica dell’amministratore.</p>}
      {(['commerciale', ...(kind === 'TechnicalPractice' ? ['tecnico'] : [])] as Array<'commerciale' | 'tecnico'>).map(role => {
        const ownerId = role === 'commerciale' ? currentState?.commercialOwnerId : currentState?.technicalOwnerId;
        const owner = ownerId ? userMap.get(ownerId) : null, accepted = data.accepted.find(row => row.acceptance.role === role && row.acceptance.userId === ownerId);
        const available = owner?.active && !owner.deletedAt;
        return <div key={role} className="mt-3 rounded-xl border p-3"><p>Presa in carico {role}: {accepted ? `registrata il ${formatDateTime(accepted.createdAt)}` : 'da confermare'}{owner && !available ? ' · account non operativo, attività nella coda amministrativa' : ''}</p>
          {data.valid && data.current && !accepted && available && ownerId === session.userId && hasPermission(session, 'assignment.accept') && (role !== 'tecnico' || data.current.decision.departmentCode) && <ResponsibilityAcceptanceForm kind={kind} id={id} decisionId={data.current.id} role={role} />}</div>;
      })}
    </Card>
    {session.role === 'admin' && data.context?.workable && <Card title="Decisione amministrativa">
      <p>Il reparto non concede accessi ai suoi membri. Solo il referente individuale riceve la responsabilità. Una nuova decisione richiede una nuova presa in carico.</p>
      {kind === 'TechnicalPractice' && <><form method="get"><label>Cerca referente<input name="q" defaultValue={q} className="m-2 rounded-lg border p-2" /></label><button>Cerca</button></form>
        {candidates.length > 25 && <Link href={`${path}?${new URLSearchParams({ q, after: candidates[24].id })}`}>Altri referenti</Link>}</>}
      <ResponsibilityAssignmentForm key={`${data.current?.id ?? 'initial'}:${q}:${after ?? ''}`} kind={kind} id={id} entryId={data.current?.id ?? ''}
        updatedAt={data.context.updatedAt.toISOString()} state={data.context.state} department={data.current?.decision.departmentCode ?? null} users={choices} />
    </Card>}
    <Card title="Storico delle decisioni e conferme"><ol className="space-y-3">{snapshots.map(({ row, decision, acceptance }) => <li key={row.id} className="rounded-xl border p-3">
      <p>{decision.success ? (decision.data.allowed ? 'Decisione amministrativa' : 'Variazione da riconfermare') : acceptance.success ? `Presa in carico ${acceptance.data.role}` : 'Registrazione da verificare'} · {nameOf(row.actorId)} · {formatDateTime(row.createdAt)}</p>
      {decision.success && <><p>Commerciale: {nameOf(decision.data.state.commercialOwnerId)} · tecnico: {nameOf(decision.data.state.technicalOwnerId)} · reparto: {decision.data.departmentCode ?? 'Non indicato'}</p><p>{decision.data.reason}</p></>}
      {acceptance.success && <p>Conferma riferita alla decisione {acceptance.data.decisionId}</p>}
    </li>)}</ol>{data.next && <Link href={`${path}?${new URLSearchParams({ before: data.next })}`}>Eventi precedenti</Link>}</Card>
  </div>;
}
