import assert from 'node:assert/strict';
import test from 'node:test';
import { selectDashboardView, dashboardTodayFilter, dashboardTodayWindow, dashboardViews } from '../src/lib/dashboard-selection';
import { loadDashboardLeadDetail, loadDashboardReviewDetail, loadDashboardTodayDetail } from '../src/lib/dashboard-detail';
import { prisma } from '../src/lib/prisma';
import type { AuthSession } from '../src/lib/auth';

test('a query cannot select a denied area, including repeated or malformed query values', () => {
  for (const value of ['revisioni', ['pratiche', 'lead'], '__proto__', '', null, undefined]) {
    assert.equal(selectDashboardView(value, ['lead', 'oggi']), 'lead');
  }
  assert.equal(selectDashboardView('oggi', ['lead', 'oggi']), 'oggi');
  assert.equal(selectDashboardView(undefined, dashboardViews), 'pratiche');
  assert.equal(selectDashboardView('lead', []), null);
});

test('today includes both day boundaries and retains open-state semantics without mutating the clock', () => {
  const now = new Date(2026, 9, 18, 15, 14, 13), original = now.getTime();
  const { startOfToday, endOfToday } = dashboardTodayWindow(now);
  assert.equal(now.getTime(), original);
  assert.equal(startOfToday.getHours(), 0); assert.equal(startOfToday.getMilliseconds(), 0);
  assert.equal(endOfToday.getHours(), 23); assert.equal(endOfToday.getMilliseconds(), 999);
  assert.deepEqual(dashboardTodayFilter(now), { deletedAt: null, status: { in: ['aperta', 'in_lavorazione'] }, dueAt: { gte: startOfToday, lte: endOfToday } });
});

test('denied permissions or an inactive Admin avoid querying detail', async t => {
  const session: AuthSession = { userId: 'synthetic-denied', role: 'consulente', active: true, expiresAt: 2_000_000_000,
    permissionOverrides: ['lead.read', 'service.read', 'dossier.read'].map(permission => ({ permission, allowed: false })) };
  const originalFind = prisma.lead.findMany;
  prisma.lead.findMany = () => { throw new Error('Unauthorized query'); };
  t.after(() => { prisma.lead.findMany = originalFind; });
  t.mock.method(prisma, '$transaction', () => { throw new Error('Unauthorized query'); });
  assert.deepEqual(await loadDashboardLeadDetail(session), []);
  assert.deepEqual(await loadDashboardReviewDetail(session), []);
  assert.deepEqual(await loadDashboardTodayDetail(session, new Date()), []);
  const inactiveAdmin = { ...session, role: 'admin' as const, active: false };
  assert.deepEqual(await loadDashboardLeadDetail(inactiveAdmin), []);
  assert.deepEqual(await loadDashboardReviewDetail(inactiveAdmin), []);
  assert.deepEqual(await loadDashboardTodayDetail(inactiveAdmin, new Date()), []);
});
