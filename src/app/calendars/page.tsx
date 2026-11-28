import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card, PageHeader, EmptyState, formatDateTime } from '@/components/ui';
import { PersonalCalendarAvailability } from '@/components/personal-calendar-availability';
import { CalendarWeekGrid } from '@/components/calendar-week-grid';
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
import { romeDateTimeInput } from '@/lib/rome-date-time';
import { calendarWeek, calendarWeekHref, calendarContact, calendarAppointmentLabel, calendarLegacyLabel, type CalendarAgendaEntry } from '@/lib/calendar-week';

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
  const now = new Date(), week = calendarWeek(query.date, now), currentWeek = calendarWeek(undefined, now);
  const period = { gte: week.from, lt: week.until };
  const [people, calendar, ownCalendar, legacy] = await Promise.all([
    canSelectUser ? prisma.user.findMany({ where: { active: true, deletedAt: null }, select: { id: true, name: true }, orderBy: { name: 'asc' } }) : [],
    prisma.personalCalendar.findUnique({ where: { userId }, include: { appointments: { where: { startsAt: { lt: period.lt }, endsAt: { gt: period.gte } },
      select: { leadId: true, startsAt: true, endsAt: true, status: true, syncState: true }, orderBy: { startsAt: 'asc' } } } }),
    prisma.personalCalendar.findUnique({ where: { userId: actor.userId } }),
    technical ? [] : prisma.lead.findMany({ where: { assignedToId: userId, deletedAt: null, nextActionDate: period },
      select: { id: true, setterNextKind: true, nextActionDate: true }, orderBy: { nextActionDate: 'asc' } }),
  ]);
  const visible = new Map((technical ? [] : await prisma.lead.findMany({ where: { id: { in: [...(calendar?.appointments.map(row => row.leadId) ?? []), ...legacy.map(row => row.id)] }, deletedAt: null, AND: [leadVisibilityWhere(actor)] },
    select: { id: true, firstName: true, lastName: true, companyName: true } })).map(row => [row.id, row]));
  const managed = new Set(calendar?.appointments.filter(row => row.status === 'BOOKED').map(row => row.leadId) ?? []);
  const entries: CalendarAgendaEntry[] = [
    ...(calendar?.appointments ?? []).map(row => ({ startsAt: row.startsAt, endsAt: row.endsAt, status: row.status,
      kind: calendarAppointmentLabel(row.status), syncLabel: calendarSyncLabels[row.syncState] ?? 'Da verificare', ...calendarContact(visible.get(row.leadId)) })),
    ...legacy.filter(row => row.nextActionDate && !managed.has(row.id)).map(row => ({ startsAt: row.nextActionDate!, endsAt: null,
      status: 'NEXT_ACTION', kind: calendarLegacyLabel(row.setterNextKind), syncLabel: null, ...calendarContact(visible.get(row.id)) })),
  ];
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
      <label className="font-bold">Settimana dal <input type="date" name="date" defaultValue={week.startDate} className="rounded border p-2" /></label>
      <button className="font-bold underline">Mostra calendario</button>
    </form>
    <nav aria-label="Navigazione settimane" className="flex flex-wrap items-center gap-3">
      {week.previous && <Link prefetch={false} href={calendarWeekHref(week.previous, canSelectUser ? userId : undefined)} className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-bold text-fai-navy">← Settimana precedente</Link>}
      <Link prefetch={false} href={calendarWeekHref(currentWeek.startDate, canSelectUser ? userId : undefined)} className="rounded-xl bg-fai-blue px-4 py-2 text-sm font-bold text-white">Questa settimana</Link>
      {week.next && <Link prefetch={false} href={calendarWeekHref(week.next, canSelectUser ? userId : undefined)} className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-bold text-fai-navy">Settimana successiva →</Link>}
    </nav>
    <Card title="Appuntamenti e richiami">
      <p className="mb-2 font-bold text-fai-navy">{selectedUser.name} · {new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', dateStyle: 'long' }).format(week.from)} – {new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', dateStyle: 'long' }).format(new Date(week.until.getTime() - 1))}</p>
      <p className="mb-4 text-sm text-slate-600">Europe/Rome · Seleziona il nome per aprire la scheda. Gli impegni riservati e le occupazioni Google non mostrano dettagli.</p>
      {!entries.length && <EmptyState title="Nessun appuntamento">Nessun appuntamento o richiamo CRM in questa settimana. Per fissarne uno, apri la scheda Lead autorizzata.</EmptyState>}
      <CalendarWeekGrid week={week} entries={entries} googleBusy={googleBusy} today={romeDateTimeInput(now).slice(0, 10)} />
    </Card>
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
        : googleBusy.length ? <p className="mt-3 font-bold">Occupazioni Google · senza dettagli degli eventi. Le trovi nella griglia come «Occupato».</p> : <p>Nessuna occupazione Google nella settimana selezionata.</p>
        : <p>Calendario locale: la disponibilità si verifica sulle fasce e sugli impegni CRM. Google Calendar non è collegato.</p>}
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
