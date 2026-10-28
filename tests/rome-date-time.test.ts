import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRomeDateTime, romeDateTimeInput } from '../src/lib/rome-date-time';

test('Rome input resolves winter and summer independently from the host timezone', () => {
  for (const zone of ['UTC', 'America/New_York', 'Asia/Tokyo', 'Europe/Rome']) {
    const original = process.env.TZ;
    try {
      process.env.TZ = zone;
      assert.deepEqual(resolveRomeDateTime('2026-11-26T18:00'), { kind: 'unique', instants: ['2026-11-26T17:00:00.000Z'] });
      assert.deepEqual(resolveRomeDateTime('2027-07-01T18:00'), { kind: 'unique', instants: ['2027-07-01T16:00:00.000Z'] });
      assert.equal(romeDateTimeInput('2026-11-26T17:00:00Z'), '2026-11-26T18:00:00');
    } finally { if (original === undefined) delete process.env.TZ; else process.env.TZ = original; }
  }
});
test('nonexistent spring hour is refused and both autumn instants require a choice', () => {
  assert.deepEqual(resolveRomeDateTime('2027-03-28T02:30'), { kind: 'invalid', instants: [] });
  assert.deepEqual(resolveRomeDateTime('2027-10-31T02:30'), { kind: 'ambiguous', instants: [
    '2027-10-31T00:30:00.000Z', '2027-10-31T01:30:00.000Z'] });
});
test('bad calendar values, offset strings and empty values are not silently normalized', () => {
  for (const value of ['2026-02-29T10:00', '2026-04-31T10:00', '2026-01-01T24:00', '2026-01-01T12:60',
    '2026-01-01T10:00Z', '2026-01-01T10:00+01:00', '2026-01-01', '1800-01-01T10:00'])
    assert.equal(resolveRomeDateTime(value).kind, 'invalid', value);
  assert.deepEqual(resolveRomeDateTime(''), { kind: 'empty', instants: [] });
});
test('formatting preserves a persisted instant, seconds and day boundary without mutation', () => {
  const instant = new Date('2026-11-26T23:30:41.123Z');
  assert.equal(romeDateTimeInput(instant), '2026-11-27T00:30:41');
  assert.equal(instant.toISOString(), '2026-11-26T23:30:41.123Z');
  assert.equal(romeDateTimeInput('2027-10-31T00:30:00Z'), romeDateTimeInput('2027-10-31T01:30:00Z'));
  assert.equal(romeDateTimeInput('invalid'), '');
});
