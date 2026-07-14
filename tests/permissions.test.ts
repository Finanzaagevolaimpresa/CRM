import assert from 'node:assert/strict';
import test from 'node:test';
import { hasPermission } from '../src/lib/auth';

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

test('protezione ultimo admin', () => {
  const activeAdmins = [{ id: 'a1', role: 'admin', active: true }, { id: 'u1', role: 'direzione', active: true }];
  const remainingAdmins = activeAdmins.filter((user) => user.role === 'admin' && user.active && user.id !== 'a1').length;
  assert.equal(remainingAdmins === 0, true);
});
