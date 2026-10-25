import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAdminRequestQueueSearch, adminRequestQueueHref } from '../src/lib/admin-request-queue-query';

test('request queue rejects ambiguous, oversized and invalid filters instead of widening the list', () => {
  for (const raw of [{ kind: ['DOCUMENT', 'INTEGRATION'] }, { page: ['1', '2'] }, { q: ['one', 'two'] },
    { kind: 'PRIVATE' }, { page: '0' }, { page: '201' }, { page: '1.5' }, { page: '1e2' }, { q: 'x'.repeat(161) },
    { recover: ['10000000-0000-4000-8000-000000000001'] }, { recover: 'invalid' }]) {
    assert.equal(parseAdminRequestQueueSearch(raw), null);
  }
});

test('the integration view cannot be changed into a document or unfiltered view through URL parameters', () => {
  assert.equal(parseAdminRequestQueueSearch({ kind: 'DOCUMENT' }, 'INTEGRATION'), null);
  for (const raw of [{}, { kind: '' }, { kind: 'INTEGRATION' }]) {
    assert.equal(parseAdminRequestQueueSearch(raw, 'INTEGRATION')?.kind, 'INTEGRATION');
  }
  assert.deepEqual(parseAdminRequestQueueSearch({ q: '  Progetto %_  ' }), { page: 1, q: 'Progetto %_', kind: undefined });
});

test('pagination keeps the chosen kind and literal search, with no navigation outside the queue', () => {
  const href = adminRequestQueueHref('/technical-office/integrations', { page: 2, kind: 'INTEGRATION', q: 'A & B? <x> %_' });
  const url = new URL(href, 'https://synthetic.invalid');
  assert.equal(url.pathname, '/technical-office/integrations');
  assert.equal(url.searchParams.get('q'), 'A & B? <x> %_');
  assert.equal(url.searchParams.get('kind'), 'INTEGRATION');
  assert.equal(url.searchParams.get('page'), '2');
  assert.equal([...url.searchParams.keys()].length, 3);
});
