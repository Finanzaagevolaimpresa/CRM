import Link from 'next/link';
import { calendarDaySlices, type CalendarAgendaEntry, type CalendarWeek } from '@/lib/calendar-week';
import styles from './calendar-week-grid.module.css';

const dayFormat = new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', weekday: 'long' });
const dateFormat = new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', day: 'numeric', month: 'short' });
type BusyInterval = { startsAt: Date; endsAt: Date };

export function CalendarWeekGrid({ week, entries, googleBusy, today }: {
  week: CalendarWeek; entries: CalendarAgendaEntry[]; googleBusy: BusyInterval[] | null; today: string;
}) {
  const crm = entries.flatMap((entry, index) => calendarDaySlices(week, entry.startsAt, entry.endsAt)
    .map(slice => ({ ...slice, entry, index }))).sort((a, b) => a.entry.startsAt.getTime() - b.entry.startsAt.getTime());
  const busy = [...(googleBusy ?? [])].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
    .flatMap((entry, index) => calendarDaySlices(week, entry.startsAt, entry.endsAt).map(slice => ({ ...slice, index })));
  return <div className={styles.grid} aria-label="Agenda settimanale Europe/Rome">
    {week.dates.map(date => {
      const instant = new Date(date + 'T12:00:00Z'), dayEntries = crm.filter(item => item.date === date), dayBusy = busy.filter(item => item.date === date);
      return <section key={date} className={styles.day} aria-label={dayFormat.format(instant) + ' ' + dateFormat.format(instant)} data-today={date === today || undefined}>
        <header className={styles.header}><h3><span className={styles.weekday}>{dayFormat.format(instant)}</span><time dateTime={date}>{dateFormat.format(instant)}</time></h3>
          {date === today && <span className={styles.today}>Oggi</span>}
        </header>
        <div className={styles.appointments}>
          {dayEntries.length ? dayEntries.map(({ entry, time, continuation, index }) => <article key={index}
            className={styles.appointment} data-state={entry.status} data-calendar-entry="crm">
            <p className={styles.time}>{time}</p>
            <p className={styles.kind}>{entry.kind}{continuation ? ' · continua' : ''}</p>
            {entry.href ? <Link prefetch={false} href={entry.href} className={styles.contact}>{entry.contact}</Link>
              : <><p className={styles.private}>Impegno riservato</p><p className={styles.detail}>Dettagli riservati al referente della scheda.</p></>}
            {entry.company && <p className={styles.company}>{entry.company}</p>}
            {entry.syncLabel && <p className={styles.detail}>{entry.syncLabel}</p>}
          </article>) : <p className={styles.empty}>Nessun impegno CRM</p>}
        </div>
        {googleBusy !== null && <div className={styles.availability} aria-label="Disponibilità Google">
          <p className={styles.layerLabel}>Google · disponibilità</p>
          {dayBusy.length ? dayBusy.map(({ time, continuation, index }) => <div key={index} className={styles.busy} data-calendar-entry="google">
            <p className={styles.time}>{time}</p><p>Occupato{continuation ? ' · continua' : ''}</p>
          </div>) : <p className={styles.empty}>Nessuna occupazione Google</p>}
        </div>}
      </section>;
    })}
  </div>;
}
