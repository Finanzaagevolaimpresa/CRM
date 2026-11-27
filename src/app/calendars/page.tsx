import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card, PageHeader, EmptyState, formatDateTime } from '@/components/ui';
import { PersonalCalendarAvailability } from '@/components/personal-calendar-availability';
import { withTechnicalPage } from '@/lib/technical-surface-guards';
import { requirePermission } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { leadVisibilityWhere } from '@/lib/core-query-policy';
import { availabilitySchema, defaultCalendarAvailability, calendarSyncLabels } from '@/lib/personal-calendar-contract';
import { canConnectGoogleCalendar, connectedCalendarAdapter } from '@/lib/google-calendar-oauth';
import { calendarUserId, canViewAllCalendars } from '@/lib/personal-calendar-policy';
import { recordUpdatePermission } from '@/lib/record-update-context';
import { connectGoogleCalendarAction } from '@/lib/personal-calendar-actions';
import { isTechnicalAccount } from '@/lib/technical-confidentiality';
import { resolveRomeDateTime, romeDateTimeInput } from '@/lib/rome-date-time';

export const dynamic = 'force-dynamic';
async function CalendarsPage({ searchParams }: { searchParams: Promise<{ user?: string; connection?: string; date?: string }> }) {
  const actor = await requirePermission('lead.read'), query = await searchParams;
  if (!recordUpdatePermission(actor, 'lead.read')) notFound();
  const technical = isTechnicalAccount(actor);
  const canSelectUser = canViewAllCalendars(actor);
  if (query.user !== undefined && !calendarUserId(query.user)) notFound();
  if (query.user && query.user !== actor.userId && !canSelectUser) notFound();
  const userId = canSelectUser && query.user ? query.user : actor.userId;
  const selectedUser = await prisma.user.findFirst({ where: { id: userId, active: true, deletedAt: null }, select: { name: true } });
  if (!selectedUser) notFound();
  const selectedDay = query.date && resolveRomeDateTime(query.date + 'T00:00').kind === 'unique' ? query.date : romeDateTimeInput(new Date()).slice(0, 10);
  const nextWeek = new Date(Date.parse(selectedDay + 'T12:00:00Z') + 7 * 86400_000).toISOString().slice(0, 10);
  const from = resolveRomeDateTime(selectedDay + 'T00:00'), until = resolveRomeDateTime(nextWeek + 'T00:00');
  if (from.kind !== 'unique' || until.kind !== 'unique') throw new Error('CALENDAR_WEEK_INVALID');
  const period = { gte: new Date(from.instants[0]), lt: new Date(until.instants[0]) };
  const [people, calendar, ownCalendar, legacy] = await Promise.all([
    canSelectUser ? prisma.user.findMany({ where: { active: true, deletedAt: null }, select: { id: true, name: true }, orderBy: { name: 'asc' } }) : [],
    prisma.personalCalendar.findUnique({ where: { userId }, include: { appointments: { where: { startsAt: { lt: period.lt }, endsAt: { gt: period.gte } }, orderBy: { startsAt: 'asc' } } } }),
    prisma.personalCalendar.findUnique({ where: { userId: actor.userId } }),
    technical ? [] : prisma.lead.findMany({ where: { assignedToId: userId, deletedAt: null, nextActionDate: period },
      select: { id: true, setterNextKind: true, nextActionDate: true }, orderBy: { nextActionDate: 'asc' } }),
  ]);
  const visible = new Map((technical ? [] : await prisma.lead.findMany({ where: { id: { in: [...(calendar?.appointments.map(row => row.leadId) ?? []), ...legacy.map(row => row.id)] }, deletedAt: null, AND: [leadVisibilityWhere(actor)] },
    select: { id: true, firstName: true, lastName: true, companyName: true } })).map(row => [row.id, row.companyName ?? row.firstName + ' ' + row.lastName]));
  const managed = new Set(calendar?.appointments.filter(row => row.status === 'BOOKED').map(row => row.leadId) ?? []);
  const availability = availabilitySchema.safeParse(ownCalendar?.availability);
  const selectedAvailability = availabilitySchema.safeParse(calendar?.availability);
  let googleBusy: { startsAt: Date; endsAt: Date }[] | null = null;
  if (calendar?.mode === 'GOOGLE') {
    try { googleBusy = await (await connectedCalendarAdapter(prisma, userId)).freeBusy(period.gte, period.lt); }
    catch { /* Unavailable is distinct from a free calendar; no provider details reach the page. */ }
  }
  const weekdays = ['Domenica', 'Lunedì', 'Martedì', 'Mercoledì', 'Giovedì', 'Venerdì', 'Sabato'];
  const bandTime = (minute: number) => String(Math.floor(minute / 60)).padStart(2, '0') + ':' + String(minute % 60).padStart(2, '0');
  return <div className="crm-space-y-6"><PageHeader title="Calendari" description="Appuntamenti e richiami per persona. Date e fasce Europe/Rome." />
    <form className="flex flex-wrap items-center gap-3">
      {canSelectUser && <div className="flex items-center gap-1"><label htmlFor="calendar-user-filter" className="font-bold">Utente</label><select id="calendar-user-filter" name="user" defaultValue={userId} className="rounded border p-2">{people.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}</select></div>}
      <label className="font-bold">Settimana dal <input type="date" name="date" defaultValue={selectedDay} className="rounded border p-2" /></label>
      <button className="font-bold underline">Mostra calendario</button>
    </form>
    <Card title="Fasce del referente">
      <p className="mb-3 font-bold">{selectedUser.name} · Europe/Rome</p>
      {selectedAvailability.success ? selectedAvailability.data.length ? <ul className="space-y-1">{selectedAvailability.data.map((band, index) => <li key={index}>
        {weekdays[band.weekday]} {bandTime(band.startMinute)} – {bandTime(band.endMinute)}
      </li>)}</ul> : <p>Nessuna fascia disponibile.</p> : <p>Fasce non ancora configurate dal referente.</p>}
      <p className="mt-3 text-sm">Le fasce del referente sono in sola lettura. Gli appuntamenti si fissano dalla scheda Lead autorizzata, con verifica degli orari e delle sovrapposizioni.</p>
    </Card>
    <Card title="Disponibilità">
      <p>Le occupazioni CRM sono riportate in Appuntamenti e richiami.</p>
      {calendar?.mode === 'GOOGLE' ? googleBusy === null ? <p role="status">Disponibilità Google non verificabile. Non considerare libere le fasce finché il collegamento non è verificato.</p>
        : googleBusy.length ? <><p className="mt-3 font-bold">Occupazioni Google · senza dettagli degli eventi</p><ul>{googleBusy.map((busy, index) => <li key={index}>
          {formatDateTime(busy.startsAt, 'Europe/Rome')} – {formatDateTime(busy.endsAt, 'Europe/Rome')}
        </li>)}</ul></> : <p>Nessuna occupazione Google nella settimana selezionata.</p>
        : <p>Calendario locale: la disponibilità si verifica sulle fasce e sugli impegni CRM. Google Calendar non è collegato.</p>}
    </Card>
    <Card title="Appuntamenti e richiami">
      {!calendar?.appointments.length && !legacy.length && <EmptyState title="Nessun appuntamento">Fissa l’appuntamento dalla scheda Lead.</EmptyState>}
      <div className="crm-space-y-3">{calendar?.appointments.map(row => <article key={row.id} className="rounded-xl border p-3">
        <p className="font-bold">{formatDateTime(row.startsAt, 'Europe/Rome')} – {formatDateTime(row.endsAt, 'Europe/Rome')}</p>
        <p>{row.status === 'BOOKED' ? 'Appuntamento' : row.status === 'COMPLETED' ? 'Svolto' : 'Annullato'} · {calendarSyncLabels[row.syncState] ?? 'Da verificare'}</p>
        {visible.has(row.leadId) ? <Link href={'/leads/' + row.leadId} className="font-bold underline">Apri scheda</Link> : <p className="text-sm">Dettagli riservati al referente della scheda.</p>}
      </article>)}{legacy.filter(row => !managed.has(row.id)).map(row => <article key={row.id} className="rounded-xl border p-3">
        <p className="font-bold">{formatDateTime(row.nextActionDate, 'Europe/Rome')} · {row.setterNextKind === 'VIDEO' ? 'Videochiamata' : 'Richiamo'}</p>
        {visible.has(row.id) ? <Link href={'/leads/' + row.id} className="underline">{visible.get(row.id)}</Link> : <p>Dettagli riservati al referente della scheda.</p>}
      </article>)}</div>
    </Card>
    <Card title="Le mie fasce"><PersonalCalendarAvailability initial={availability.success ? availability.data : defaultCalendarAvailability} /></Card>
    <Card title="Il mio Google Calendar"><p className="mb-3">{ownCalendar?.mode === 'GOOGLE' ? 'Collegamento personale registrato. ' : 'Calendario Google non collegato. '}
      {ownCalendar?.lastTestAt && <>Ultima prova: {formatDateTime(ownCalendar.lastTestAt, 'Europe/Rome')} · {ownCalendar.lastTestStatus}.</>}</p>
      {query.connection && query.connection !== 'connected' && <p role="status">Connessione non completata. Verifica la configurazione e riparti dal consenso.</p>}
      {canConnectGoogleCalendar(actor) ? <form action={connectGoogleCalendarAction}><button className="rounded-xl bg-fai-blue px-4 py-2 font-bold text-white">Collega il mio Google Calendar</button></form>
        : <p>Il collegamento Google non è abilitato per questo profilo. Gli appuntamenti salvati restano nel CRM.</p>}
    </Card>
  </div>;
}
export default withTechnicalPage('/calendars', CalendarsPage);
