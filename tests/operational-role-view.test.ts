import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDashboardCounterGroups, type DashboardCounterCounts } from '../src/lib/dashboard-counter-groups';
import { operationalDashboardView, operationalNavigationAllows } from '../src/lib/operational-role-view';

const counts: DashboardCounterCounts = {
  leadDaContattare: 11, trattativeAperte: 12, offerteInviate: 13, offerteAccettate: 14,
  activeTechnicalPracticesCount: 21, overdueClientUpdates: 22, commsToReview: 23, approvedUnusedComms: 24,
  clientiAttivi: 31, progettiAttivi: 32, serviziAcquistati: 33, tasks: 41, todayTasksCount: 42,
  overdueTasks: 43, dueSoonTasks: 44, payments: 51, preReview: 61, dossierBozza: 62,
  aiReview: 63, pendingAiAuthorizationRequestCount: 127,
};

test('sales keeps lead, offers and own progress while excluding administrative and technical counters', () => {
  const view = operationalDashboardView('commerciale', () => true);
  const groups = buildDashboardCounterGroups({ ...view, isAdmin: false }, counts);
  assert.deepEqual(groups.map(g => g.id), ['commerciale', 'clienti-servizi', 'attivita-scadenze']);
  assert.deepEqual(groups[0].counters.map(c => c.value), [11, 12, 13, 14]);
  assert.deepEqual(groups[1].counters.map(c => c.value), [31]);
  assert.equal(view.canReadCommercialProgress, true);
  assert.equal(view.showPipeline, false);
  assert.equal(view.showLegacyDetails, false);
  for (const path of ['/leads', '/commercial-offers', '/clients', '/progress']) assert.equal(operationalNavigationAllows('commerciale', path), true);
  for (const path of ['/contracts', '/payments', '/technical-office', '/dossiers', '/ai/outputs-to-review']) assert.equal(operationalNavigationAllows('commerciale', path), false);
});

test('technical profiles retain operational projects, practices and tasks without customer or financial summaries', () => {
  for (const role of ['consulente', 'backoffice'] as const) {
    const view = operationalDashboardView(role, () => true);
    const groups = buildDashboardCounterGroups({ ...view, isAdmin: false }, counts);
    assert.deepEqual(groups.map(g => g.id), ['ufficio-tecnico', 'clienti-servizi', 'attivita-scadenze']);
    assert.deepEqual(groups[0].counters.map(c => c.value), [21, 22]);
    assert.equal(groups[1].title, 'Progetti');
    assert.deepEqual(groups[1].counters.map(c => c.value), [32]);
    for (const path of ['/projects', '/technical-office/practices', '/documents', '/document-checklists', '/tasks']) assert.equal(operationalNavigationAllows(role, path), true);
    for (const path of ['/leads', '/clients', '/contracts', '/payments', '/commercial-offers', '/portals', '/reporting']) assert.equal(operationalNavigationAllows(role, path), false);
    assert.equal(view.showLegacyDetails, false);
  }
});

test('current permission denial suppresses all counters and commercial progress regardless of role', () => {
  for (const role of ['commerciale', 'consulente', 'backoffice', 'collaboratore_limitato'] as const) {
    const view = operationalDashboardView(role, () => false);
    assert.deepEqual(buildDashboardCounterGroups({ ...view, isAdmin: false }, counts), []);
    assert.equal(view.canReadCommercialProgress, false);
  }
  assert.equal(operationalDashboardView('admin', permission => permission !== 'payment.read').showLegacyDetails, false);
});

test('limited collaborator is not promoted to sales and zero-valued forbidden groups stay absent', () => {
  const view = operationalDashboardView('collaboratore_limitato', () => true);
  const zero = Object.fromEntries(Object.keys(counts).map(k => [k, 0])) as DashboardCounterCounts;
  const groups = buildDashboardCounterGroups({ ...view, isAdmin: false }, zero);
  assert.deepEqual(groups.map(g => g.id), ['clienti-servizi', 'attivita-scadenze']);
  assert.equal(operationalNavigationAllows('collaboratore_limitato', '/leads'), false);
  assert.equal(operationalNavigationAllows('collaboratore_limitato', '/commercial-offers'), false);
  assert.equal(operationalNavigationAllows('collaboratore_limitato', '/progress'), false);
  assert.equal(operationalNavigationAllows(undefined, '/dashboard'), false);
});
