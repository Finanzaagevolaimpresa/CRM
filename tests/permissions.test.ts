import assert from 'node:assert/strict';
import test from 'node:test';
import { hasPermission } from '../src/lib/auth';
import { isNavItemVisible } from '../src/lib/nav-visibility';
import { canChangeUserRole, canDeactivateUser, shouldClearPermissionOverridesOnRoleChange } from '../src/lib/user-safety';

test('permesso ereditato dal ruolo', () => {
  assert.equal(hasPermission({ role: 'commerciale', active: true, permissionOverrides: [] }, 'lead.read'), true);
});

test('permesso negato tramite override', () => {
  assert.equal(hasPermission({ role: 'commerciale', active: true, permissionOverrides: [{ permission: 'lead.read', allowed: false }] }, 'lead.read'), false);
});

test('permesso aggiunto tramite override', () => {
  assert.equal(hasPermission({ role: 'commerciale', active: true, permissionOverrides: [{ permission: 'audit.read', allowed: true }] }, 'audit.read'), true);
});

test('assenza di override usa il ruolo', () => {
  assert.equal(hasPermission({ role: 'collaboratore_limitato', active: true, permissionOverrides: [] }, 'audit.read'), false);
});

test('admin sempre autorizzato anche con override negato', () => {
  assert.equal(hasPermission({ role: 'admin', active: true, permissionOverrides: [{ permission: 'audit.read', allowed: false }] }, 'audit.read'), true);
});

test('utente non attivo bloccato', () => {
  assert.equal(hasPermission({ role: 'admin', active: false, permissionOverrides: [] }, 'audit.read'), false);
});

test('un solo admin attivo: disattivazione bloccata', () => {
  const users = [{ id: 'a1', role: 'admin' as const, active: true }];
  assert.deepEqual(canDeactivateUser('operator', users[0], users), { allowed: false, reason: 'last_active_admin' });
});

test('un solo admin attivo: cambio ruolo bloccato', () => {
  const users = [{ id: 'a1', role: 'admin' as const, active: true }];
  assert.deepEqual(canChangeUserRole(users[0], 'direzione', users), { allowed: false, reason: 'last_active_admin' });
});

test('due admin attivi: modifica di uno consentita', () => {
  const users = [{ id: 'a1', role: 'admin' as const, active: true }, { id: 'a2', role: 'admin' as const, active: true }];
  assert.deepEqual(canDeactivateUser('operator', users[0], users), { allowed: true });
  assert.deepEqual(canChangeUserRole(users[0], 'direzione', users), { allowed: true });
});

test('auto-disattivazione bloccata', () => {
  const users = [{ id: 'a1', role: 'admin' as const, active: true }, { id: 'a2', role: 'admin' as const, active: true }];
  assert.deepEqual(canDeactivateUser('a1', users[0], users), { allowed: false, reason: 'self_deactivation' });
});

test('promozione ad admin elimina gli override', () => {
  assert.equal(shouldClearPermissionOverridesOnRoleChange('admin'), true);
  assert.equal(shouldClearPermissionOverridesOnRoleChange('direzione'), false);
});

test('sidebar: permission ereditata mostra la voce', () => {
  const permissions = ['lead.read'] as const;
  assert.equal(isNavItemVisible({ permission: 'lead.read' }, { role: 'commerciale', permissions }), true);
});

test('sidebar: deny nasconde la voce', () => {
  assert.equal(isNavItemVisible({ permission: 'lead.read' }, { role: 'commerciale', permissions: [] }), false);
});

test('sidebar: allow aggiunge la voce a un ruolo diverso', () => {
  const permissions = ['audit.read'] as const;
  assert.equal(isNavItemVisible({ permission: 'audit.read' }, { role: 'commerciale', permissions }), true);
});

test('sidebar: admin vede sempre la voce', () => {
  assert.equal(isNavItemVisible({ permission: 'audit.read' }, { role: 'admin', permissions: [] }), true);
});
import { clientSectionVisible, dashboardAreaVisible, reportSectionVisible } from '../src/lib/permission-projections';

test('deny payment.read elimina pagamenti e ultimo pagamento dalla dashboard', () => {
  assert.equal(dashboardAreaVisible([], 'payment.read'), false);
});

test('deny dossier.read elimina dossier dal fascicolo cliente', () => {
  assert.equal(clientSectionVisible([], 'dossier'), false);
});

test('deny contract.read elimina contratti dal fascicolo cliente', () => {
  assert.equal(clientSectionVisible([], 'contratti'), false);
});

test('deny technical.read elimina pratiche tecniche', () => {
  assert.equal(clientSectionVisible([], 'ufficio-tecnico-pratiche'), false);
});

test('report cliente non contiene sezioni negate', () => {
  assert.equal(reportSectionVisible([], 'payments'), false);
  assert.equal(reportSectionVisible([], 'contracts'), false);
  assert.equal(reportSectionVisible([], 'technical'), false);
});

test('service.read senza service.write non mostra azioni Task', () => {
  assert.equal(hasPermission({ role: 'collaboratore_limitato', active: true, permissionOverrides: [] }, 'service.read'), true);
  assert.equal(hasPermission({ role: 'collaboratore_limitato', active: true, permissionOverrides: [] }, 'service.write'), false);
});

test('coerenza permission della Checklist', () => {
  assert.equal(isNavItemVisible({ permission: 'service.read' }, { role: 'collaboratore_limitato', permissions: ['service.read'] }), true);
});

test('accesso diretto a progetto non assegnato bloccato', () => {
  const allowed = canChangeUserRole({ id: 'admin-1', role: 'admin', active: true }, 'direzione', [{ id: 'admin-1', role: 'admin', active: true }]);
  assert.deepEqual(allowed, { allowed: false, reason: 'last_active_admin' });
});

// Regression: blocked anti-lockout branches return a blocked result that server actions audit before throwing after commit.
test('audit dei tentativi anti-lockout usa rami bloccati persistibili', () => {
  const users = [{ id: 'a1', role: 'admin' as const, active: true }];
  assert.equal(canDeactivateUser('a1', users[0], users).reason, 'self_deactivation');
  assert.equal(canDeactivateUser('operator', users[0], users).reason, 'last_active_admin');
  assert.equal(canChangeUserRole(users[0], 'direzione', users).reason, 'last_active_admin');
});
