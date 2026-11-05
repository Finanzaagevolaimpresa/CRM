import test from 'node:test';
import assert from 'node:assert/strict';
import { compareVideoOrder } from '../src/lib/video-order';

const video = (id: string, title: string, position = 0) => ({ id, title, position });
test('numbered lessons sort 01 through 13 independently of opaque IDs and creation order', () => {
  const input = [2, 10, 9, 12, 6, 13, 4, 3, 1, 11, 5, 8, 7]
    .map((n, i) => video(String(i).padStart(2, '0'), String(n).padStart(2, '0') + ' - Synthetic lesson'));
  assert.deepEqual(input.sort(compareVideoOrder).map(row => Number(row.title.slice(0, 2))),
    Array.from({ length: 13 }, (_, i) => i + 1));
});
test('2 and 02 are equal numeric prefixes; stable ID resolves ties before lesson 10', () => {
  const input = [video('c', '10 - Later'), video('b', '2 - Second'), video('a', '02: Second')];
  assert.deepEqual(input.sort(compareVideoOrder).map(row => row.id), ['a', 'b', 'c']);
  assert.deepEqual(input.reverse().sort(compareVideoOrder).map(row => row.id), ['a', 'b', 'c']);
});
test('unnumbered titles follow numbered titles at equal position with stable ID fallback', () => {
  const input = [video('z', 'Appendix'), video('b', '2FA introduction'), video('a', 'Introduction'),
    video('n', ' 03 — Synthetic lesson'), video('c', 'Introduction')];
  assert.deepEqual(input.sort(compareVideoOrder).map(row => row.id), ['n', 'a', 'b', 'c', 'z']);
  assert.deepEqual(input.reverse().sort(compareVideoOrder).map(row => row.id), ['n', 'a', 'b', 'c', 'z']);
});
test('explicit manual position keeps its existing priority', () => {
  assert.deepEqual([video('a', '01 - First', 2), video('b', '10 - Tenth', 1), video('c', 'Appendix', 0)]
    .sort(compareVideoOrder).map(row => row.id), ['c', 'b', 'a']);
});
test('large numeric prefixes compare exactly without floating-point loss', () => {
  assert.deepEqual([video('a', '9007199254740993 - Later'), video('z', '09007199254740992 - Earlier'),
    video('zero', '000 - Start')].sort(compareVideoOrder).map(row => row.id), ['zero', 'z', 'a']);
});
test('a filtered mixed-source subset keeps the common order without changing record metadata', () => {
  const rows = [2, 10, 1, 13, 3].map(n => Object.freeze({ ...video('id-' + n, n + ' - Synthetic lesson'),
    source: n % 2 ? 'drive' : 'local', version: 4, link: 'synthetic-' + n, audience: Object.freeze(['synthetic-user']) }));
  const before = JSON.stringify(rows);
  const ordered = rows.slice().sort(compareVideoOrder), allowed = new Set(['id-13', 'id-1', 'id-3']);
  assert.deepEqual(rows.filter(row => allowed.has(row.id)).sort(compareVideoOrder),
    ordered.filter(row => allowed.has(row.id)));
  assert.equal(JSON.stringify(rows), before);
  assert.deepEqual(new Set(ordered), new Set(rows));
});
