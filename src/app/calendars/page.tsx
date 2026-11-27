import Link from 'next/link';
import { Card, PageHeader, EmptyState, formatDateTime } from '@/components/ui';
import { PersonalCalendarAvailability } from '@/components/personal-calendar-availability';
import { withTechnicalPage } from '@/lib/technical-surface-guards';
import { requirePermission } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { leadVisibilityWhere } from '@/lib/core-query-policy';
import { availabilitySchema, defaultCalendarAvailability, calendarSyncLabels } from '@/lib/personal-calendar-contract';
import { calendarOAuthConfig } from '@/lib/google-calendar-oauth';
import { connectGoogleCalendarAction } from '@/lib/personal-calendar-actions';
import { isTechnicalAccount } from '@/lib/technical-confidentiality';
import { resolveRomeDateTime, romeDateTimeInput } from '@/lib/rome-date-time';

export const dynamic = 'force-dynamic';
async function CalendarsPage({ searchParams }: { searchParams: Promise<{ user?: string; connection?: string; date?: string }> }) {
  const actor = await requirePermission('lead.read'), query = await searchParams;
  const technical = isTechnicalAccount(actor);
  const userId = actor.role === 'admin' && query.user ? query.user : actor.userId;
  const selectedDay = query.date && resolveRomeDateTime(query.date + 'T00:00').kind === 'unique' ? query.date : romeDateTimeInput(new Date()).slice(0, 10);
  const nextWeek = new Date(Date.parse(selectedDay + 'T12:00:00Z') + 7 * 86400_000).toISOString().slice(0, 10);
  const from = resolveRomeDateTime(selectedDay + 'T00:00'), until = resolveRomeDateTime(nextWeek + 'T00:00');
  if (from.kind !== 'unique' || until.kind !== 'unique') throw new Error('CALENDAR_WEEK_INVALID');
  const period = { gte: new Date(from.instants[0]), lt: new Date(until.instants[0]) };
  const [people, calendar, ownCalendar, legacy] = await Promise.all([
    actor.role === 'admin' ? prisma.user.findMany({ where: { active: true, deletedAt: null }, select: { id: true, name: true }, orderBy: { name: 'asc' } }) : [],
    prisma.personalCalendar.findUnique({ where: { userId }, include: { appointments: { where: { startsAt: { lt: period.lt }, endsAt: { gt: period.gte } }, orderBy: { startsAt: 'asc' } } } }),
    prisma.personalCalendar.findUnique({ where: { userId: actor.userId } }),
    technical ? [] : prisma.lead.findMany({ where: { assignedToId: userId, deletedAt: null, nextActionDate: period, AND: [leadVisibilityWhere(actor)] },
      select: { id: true, firstName: true, lastName: true, companyName: true, setterNextKind: true, nextActionDate: true }, orderBy: { nextActionDate: 'asc' } }),
  ]);
  const visible = new Set((technical ? [] : await prisma.lead.findMany({ where: { id: { in: calendar?.appointments.map(row => row.leadId) ?? [] }, deletedAt: null, AND: [leadVisibilityWhere(actor)] }, select: { id: true } })).map(row => row.id));
  const managed = new Set(calendar?.appointments.filter(row => row.status === 'BOOKED').map(row => row.leadId) ?? []);
  const availability = availabilitySchema.safeParse(ownCalendar?.availability);
  return <div className="crm-space-y-6"><PageHeader title="Calendari" description="Appuntamenti e richiami per persona. Date e fasce Europe/Rome." />
    <form className="flex flex-wrap items-center gap-3">
      {actor.role === 'admin' && <div className="flex items-center gap-1"><label htmlFor="calendar-user-filter" className="font-bold">Utente</label><select id="calendar-user-filter" name="user" defaultValue={userId} className="rounded border p-2">{people.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}</select></div>}
      <label className="font-bold">Settimana dal <input type="date" name="date" defaultValue={selectedDay} className="rounded border p-2" /></label>
      <button className="font-bold underline">Mostra calendario</button>
    </form>
    <Card title="Appuntamenti e richiami">
      {!calendar?.appointments.length && !legacy.length && <EmptyState title="Nessun appuntamento">Fissa l’appuntamento dalla scheda Lead.</EmptyState>}
      <div className="crm-space-y-3">{calendar?.appointments.map(row => <article key={row.id} className="rounded-xl border p-3">
        <p className="font-bold">{formatDateTime(row.startsAt, 'Europe/Rome')} – {formatDateTime(row.endsAt, 'Europe/Rome')}</p>
        <p>{row.status === 'BOOKED' ? 'Appuntamento' : row.status === 'COMPLETED' ? 'Svolto' : 'Annullato'} · {calendarSyncLabels[row.syncState] ?? 'Da verificare'}</p>
        {visible.has(row.leadId) ? <Link href={'/leads/' + row.leadId} className="font-bold underline">Apri scheda</Link> : <p className="text-sm">Dettagli riservati al referente della scheda.</p>}
      </article>)}{legacy.filter(row => !managed.has(row.id)).map(row => <article key={row.id} className="rounded-xl border p-3">
        <p className="font-bold">{formatDateTime(row.nextActionDate, 'Europe/Rome')} · {row.setterNextKind === 'VIDEO' ? 'Videochiamata' : 'Richiamo'}</p>
        <Link href={'/leads/' + row.id} className="underline">{row.companyName ?? row.firstName + ' ' + row.lastName}</Link>
      </article>)}</div>
    </Card>
    <Card title="Le mie fasce"><PersonalCalendarAvailability initial={availability.success ? availability.data : defaultCalendarAvailability} /></Card>
    <Card title="Il mio Google Calendar"><p className="mb-3">{ownCalendar?.mode === 'GOOGLE' ? 'Collegamento personale registrato. ' : 'Calendario Google non collegato. '}
      {ownCalendar?.lastTestAt && <>Ultima prova: {formatDateTime(ownCalendar.lastTestAt, 'Europe/Rome')} · {ownCalendar.lastTestStatus}.</>}</p>
      {query.connection && query.connection !== 'connected' && <p role="status">Connessione non completata. Verifica la configurazione e riparti dal consenso.</p>}
      {calendarOAuthConfig() ? <form action={connectGoogleCalendarAction}><button className="rounded-xl bg-fai-blue px-4 py-2 font-bold text-white">Collega il mio Google Calendar</button></form>
        : <p>Il collegamento Google richiede la configurazione autorizzata dell’integrazione da parte dell’Admin. Gli appuntamenti salvati restano nel CRM.</p>}
    </Card>
  </div>;
}
export default withTechnicalPage('/calendars', CalendarsPage);
