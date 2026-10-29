import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { selectOperationalWork, type OperationalWorkRow } from '../src/lib/operational-work-projection';

const row = (id: string, patch: Partial<OperationalWorkRow> = {}): OperationalWorkRow => ({
  id, kind: 'TechnicalPractice', admission: 'SELECTIVE', href: '/technical-work/practices/' + id,
  title: 'Titolo sintetico ' + id, status: 'da_progettare', priority: null, dueDate: null, client: null,
  technicalOwner: null, commercialOwner: null, responsibility: 'supporto', expiresAt: '2099-01-01T00:00:00Z', ...patch,
});
test('ordinary and selected admissions form one stable set and choose an independently admitted ordinary route', () => {
  const selected = row('a'), ordinary = row('a', { admission: 'ORDINARY', href: '/technical-office/practices/a' });
  for (const rows of [[selected, ordinary], [ordinary, selected]]) {
    const result = selectOperationalWork(rows);
    assert.equal(result.total, 1); assert.equal(result.stateCounts.da_progettare, 1);
    assert.equal(result.records[0].href, ordinary.href);
  }
});
test('excluded title and state cannot affect search, state buckets, active filters or labels', () => {
  const hidden = row('a', { title: null, status: null });
  const visible = row('b');
  assert.equal(selectOperationalWork([hidden, visible]).total, 2);
  assert.equal(selectOperationalWork([hidden, visible]).hiddenStatus, 1);
  assert.deepEqual(selectOperationalWork([hidden, visible]).stateCounts, { da_progettare: 1 });
  assert.equal(selectOperationalWork([hidden, visible], { q: 'Titolo' }).total, 1);
  assert.equal(selectOperationalWork([hidden, visible], { status: 'da_progettare' }).total, 1);
  assert.equal(selectOperationalWork([hidden, visible], { active: true }).total, 1);
  assert.equal(selectOperationalWork([hidden], { clientId: 'private-client' }).total, 0);
});
test('pagination is applied after admitted deduplication and filtering without phantom continuation', () => {
  const rows = Array.from({ length: 42 }, (_, i) => row(String(i).padStart(3, '0'), { status: i === 41 ? null : 'in_progettazione' }));
  const result = selectOperationalWork([...rows, ...rows], { status: 'in_progettazione', page: 2 });
  assert.equal(result.total, 41); assert.equal(result.records.length, 20); assert.equal(result.hasNext, true);
  assert.deepEqual(selectOperationalWork(rows, { status: 'in_progettazione', page: 3 }).records.map(r => r.id), ['040']);
  assert.equal(selectOperationalWork(rows, { status: 'in_progettazione', page: 3 }).hasNext, false);
});
test('project and practice identifiers remain distinct and closed status is not counted as active', () => {
  const rows = [row('a'), row('a', { kind: 'Project', status: 'idea' }), row('b', { status: 'approvata' }), row('c', { status: 'archiviata' })];
  assert.equal(selectOperationalWork(rows).total, 4);
  assert.equal(selectOperationalWork(rows, { active: true }).total, 2);
  assert.throws(() => selectOperationalWork(rows, { page: 0 }));
});
