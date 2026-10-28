import assert from 'node:assert/strict';
import { test } from 'node:test';
import { operationalRomeTime } from '../src/lib/operational-time';

test('operational deadlines show the same stored instant in Rome in winter and summer', () => {
  const winter = new Date('2026-11-26T17:00:00.000Z');
  assert.equal(operationalRomeTime(winter), '26/11/26, 18:00 · Europe/Rome');
  assert.equal(winter.toISOString(), '2026-11-26T17:00:00.000Z');
  assert.equal(operationalRomeTime('2026-07-26T17:00:00Z'), '26/07/26, 19:00 · Europe/Rome');
});
test('a UTC date boundary and offset-equivalent values retain their instant', () => {
  assert.equal(operationalRomeTime('2026-10-28T23:17:16Z'), '29/10/26, 00:17 · Europe/Rome');
  assert.equal(operationalRomeTime('2026-10-29T00:17:16+01:00'), '29/10/26, 00:17 · Europe/Rome');
});
test('Rome daylight saving transitions do not shift or mutate persisted timestamps', () => {
  assert.equal(operationalRomeTime('2026-03-29T00:30:00Z'), '29/03/26, 01:30 · Europe/Rome');
  assert.equal(operationalRomeTime('2026-03-29T01:30:00Z'), '29/03/26, 03:30 · Europe/Rome');
  assert.equal(operationalRomeTime('2026-10-25T00:30:00Z'), '25/10/26, 02:30 · Europe/Rome');
  assert.equal(operationalRomeTime('2026-10-25T02:30:00Z'), '25/10/26, 03:30 · Europe/Rome');
});
test('absent or invalid times cannot become a plausible deadline', () => {
  for (const value of [null, undefined, '', 'invalid', new Date(NaN)])
    assert.equal(operationalRomeTime(value), 'Non disponibile');
});
