import test from 'node:test';
import assert from 'node:assert/strict';
import { formatRecordNoticeTime } from '../src/lib/record-notice-time';

test('notification instants are Rome time even when the server is UTC or elsewhere', () => {
  const previous = process.env.TZ;
  try {
    for (const zone of ['UTC', 'America/Los_Angeles', 'Asia/Tokyo']) {
      process.env.TZ = zone;
      assert.equal(formatRecordNoticeTime('2026-10-28T18:57:00.000Z'), '28/10/26, 19:57');
      assert.equal(formatRecordNoticeTime(new Date('2026-07-28T18:57:00.000Z')), '28/07/26, 20:57');
    }
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});

test('Rome daylight-saving boundaries preserve the actual instant', () => {
  assert.equal(formatRecordNoticeTime('2026-03-29T00:30:00.000Z'), '29/03/26, 01:30');
  assert.equal(formatRecordNoticeTime('2026-03-29T01:30:00.000Z'), '29/03/26, 03:30');
  assert.equal(formatRecordNoticeTime('2026-10-25T00:30:00.000Z'), '25/10/26, 02:30');
  assert.equal(formatRecordNoticeTime('2026-10-25T01:30:00.000Z'), '25/10/26, 02:30');
});

test('missing notification instants are not invented', () => {
  for (const value of [undefined, null, '']) assert.equal(formatRecordNoticeTime(value), '—');
});
