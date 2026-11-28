import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarWeek, calendarWeekHref, calendarDaySlices, calendarContact, calendarLegacyLabel, calendarAppointmentLabel } from '../src/lib/calendar-week';

test('week navigation is Monday to Sunday in Rome and keeps the selected referent', () => {
  const week = calendarWeek('2026-11-28');
  assert.equal(week.startDate, '2026-11-23');
  assert.equal(week.previous, '2026-11-16'); assert.equal(week.next, '2026-11-30');
  assert.deepEqual(week.dates, ['2026-11-23','2026-11-24','2026-11-25','2026-11-26','2026-11-27','2026-11-28','2026-11-29']);
  assert.equal(week.from.toISOString(), '2026-11-22T23:00:00.000Z');
  assert.equal(week.until.toISOString(), '2026-11-29T23:00:00.000Z');
  assert.equal(calendarWeekHref(week.next!, 'synthetic-setter'), '/calendars?date=2026-11-30&user=synthetic-setter');
});
test('current week uses Rome even when UTC is still Sunday; malformed dates do not crash', () => {
  const now = new Date('2026-11-29T23:30:00Z');
  for (const raw of [undefined, ['2026-11-28'], '2026-02-30', 'bad', '9999-12-31'])
    assert.equal(calendarWeek(raw, now).startDate, '2026-11-30');
  assert.equal(calendarWeek('2027-01-01').startDate, '2026-12-28');
});
test('DST weeks follow local midnights, never a fixed seven times 24 hours', () => {
  for (const [date, hours] of [['2026-03-29', 167], ['2026-10-25', 169]] as const) {
    const week = calendarWeek(date);
    assert.equal((week.until.getTime() - week.from.getTime()) / 3_600_000, hours);
    const slices = calendarDaySlices(week, week.from, week.until);
    assert.equal(slices.length, 7); assert(slices.every(slice => slice.time === 'Tutto il giorno'));
  }
});
test('cross-midnight intervals are clipped without duplicating at the exclusive end', () => {
  const week = calendarWeek('2026-11-28');
  assert.deepEqual(calendarDaySlices(week, new Date('2026-11-24T22:30:00Z'), new Date('2026-11-25T00:30:00Z')), [
    { date: '2026-11-24', time: '23:30 – 24:00', continuation: true },
    { date: '2026-11-25', time: '00:00 – 01:30', continuation: true },
  ]);
  assert.equal(calendarDaySlices(week, new Date('2026-11-24T22:30:00Z'), new Date('2026-11-24T23:00:00Z')).length, 1);
  assert.deepEqual(calendarDaySlices(week, week.until, null), []);
  assert.deepEqual(calendarDaySlices(week, week.from, week.from), []);
});
test('legacy actions are instants; autumn repeated hours show their offset', () => {
  assert.deepEqual(calendarDaySlices(calendarWeek('2026-11-28'), new Date('2026-11-24T09:15:00Z'), null),
    [{ date: '2026-11-24', time: '10:15', continuation: false }]);
  const slices = calendarDaySlices(calendarWeek('2026-10-25'), new Date('2026-10-25T00:45:00Z'), new Date('2026-10-25T01:15:00Z'));
  assert.match(slices[0].time, /02:45.*GMT\+02:00.*02:15.*GMT\+01:00/);
});
test('only an admitted Lead supplies contact and link; hidden records have no identifiers', () => {
  assert.deepEqual(calendarContact(undefined), { contact: null, company: null, href: null });
  assert.deepEqual(calendarContact({ id: 'synthetic-lead', firstName: ' Ada ', lastName: ' Esempio ', companyName: 'Impresa demo' }),
    { contact: 'Ada Esempio', company: 'Impresa demo', href: '/leads/synthetic-lead' });
  assert.equal(calendarContact({ id: 'synthetic/lead', firstName: '', lastName: '', companyName: 'Impresa demo' }).href, '/leads/synthetic%2Flead');
  assert.equal(calendarContact({ id: 'synthetic', firstName: '', lastName: '', companyName: null }).contact, 'Scheda Lead');
});
test('real appointment states stay distinguishable and generic next actions are not invented calls', () => {
  assert.equal(calendarAppointmentLabel('CANCELLED'), 'Annullato');
  assert.equal(calendarAppointmentLabel('COMPLETED'), 'Svolto');
  assert.equal(calendarAppointmentLabel('BOOKED'), 'Appuntamento');
  assert.equal(calendarLegacyLabel(null), 'Prossima azione');
  assert.equal(calendarLegacyLabel('VIDEO'), 'Videochiamata');
  assert.equal(calendarLegacyLabel('CALLBACK'), 'Richiamo');
});
