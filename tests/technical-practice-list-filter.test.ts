import assert from 'node:assert/strict';
import test from 'node:test';
import { technicalPracticeListFilter, technicalPracticeStatuses } from '../src/lib/technical-practice-list-filter';
import { dashboardPracticeFilter } from '../src/lib/dashboard-selection';

test('a status destination narrows the exact state and preserves the existing trash convention', () => {
  for (const status of technicalPracticeStatuses) {
    assert.deepEqual(technicalPracticeListFilter({ status }), {
      deletedAt: status === 'archiviata' ? { not: null } : null, status,
    });
  }
});

test('active-list filters remain an intersection with the dashboard predicate', () => {
  assert.deepEqual(technicalPracticeListFilter({ dashboard: 'attive', status: 'approvata', clientId: 'synthetic-client',
    technicalOwnerId: 'synthetic-technician', commercialOwnerId: 'synthetic-sales', priority: 'alta' }), {
    deletedAt: null, AND: [dashboardPracticeFilter], status: 'approvata', clientId: 'synthetic-client',
    technicalOwnerId: 'synthetic-technician', commercialOwnerId: 'synthetic-sales', priority: 'alta',
  });
});

test('malformed and repeated filters cannot silently become a broader list', () => {
  for (const query of [{ status: 'unknown' }, { status: ['approvata','presentata'] }, { dashboard: ['attive'] },
    { dashboard: 'all' }, { priority: 'superurgent' }, { clientId: '../client' }, { technicalOwnerId: ['one','two'] },
    { commercialOwnerId: 'x'.repeat(129) }]) assert.equal(technicalPracticeListFilter(query), null);
  assert.deepEqual(technicalPracticeListFilter({ status: '', clientId: '' }), { deletedAt: null });
});
