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
