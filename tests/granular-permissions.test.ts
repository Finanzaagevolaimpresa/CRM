import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getEffectivePermissions, hasPermission, isPermission, permissionCatalog, roleHasPermission, type AuthSession } from '../src/lib/auth';
import { visibleNavItemsForTest } from '../src/components/nav-links';

const root = resolve(import.meta.dirname, '..');
const session = (role: AuthSession['role'], overrides: AuthSession['permissionOverrides'] = [], active = true): AuthSession => ({ userId: 'u1', expiresAt: 9999999999, role, active, permissionOverrides: overrides });

test('permesso ereditato consentito e negato', () => {
  assert.equal(roleHasPermission('consulente', 'project.read'), true);
  assert.equal(hasPermission(session('consulente'), 'project.read'), true);
  assert.equal(roleHasPermission('collaboratore_limitato', 'audit.read'), false);
  assert.equal(hasPermission(session('collaboratore_limitato'), 'audit.read'), false);
});

test('override allow e deny hanno precedenza sul ruolo', () => {
  assert.equal(hasPermission(session('collaboratore_limitato', [{ permission: 'audit.read', allowed: true }]), 'audit.read'), true);
  assert.equal(hasPermission(session('direzione', [{ permission: 'audit.read', allowed: false }]), 'audit.read'), false);
  assert.equal(hasPermission(session('collaboratore_limitato', [{ permission: 'project.read', allowed: false }]), 'project.read'), false);
  assert.equal(hasPermission(session('collaboratore_limitato', [{ permission: 'lead.read', allowed: true }]), 'lead.read'), true);
});

if (false) {
  // @ts-expect-error permissionOverrides è obbligatorio per evitare call-site role-only
  hasPermission({ role: 'direzione', active: true }, 'audit.read');
}

test('admin sempre consentito, inattivo negato e permission sconosciuta rifiutata', () => {
  assert.equal(hasPermission(session('admin', [{ permission: 'audit.read', allowed: false }]), 'audit.read'), true);
  assert.equal(hasPermission(session('admin', [], false), 'audit.read'), false);
  assert.equal(isPermission('unknown.permission'), false);
  assert.equal(hasPermission(session('admin'), 'unknown.permission' as never), false);
});

test('catalogo include ai.external.run e tipo derivato', () => {
  assert.ok(permissionCatalog.some((p) => p.code === 'ai.external.run'));
  assert.ok(getEffectivePermissions(session('direzione')).includes('ai.external.run'));
});

test('override immediato senza nuovo login e reset', () => {
  const s = session('collaboratore_limitato');
  assert.equal(hasPermission(s, 'audit.read'), false);
  s.permissionOverrides = [{ permission: 'audit.read', allowed: true }];
  assert.equal(hasPermission(s, 'audit.read'), true);
  s.permissionOverrides = [];
  assert.equal(hasPermission(s, 'audit.read'), false);
});

test('azioni proteggono auto-disattivazione, ultimo admin e override admin con transazioni serializzabili', () => {
  const source = readFileSync(resolve(root, 'src/lib/user-privilege-service.ts'), 'utf8');
  assert.match(source, /userId === actor\.userId[\s\S]*Non puoi disattivare te stesso/);
  assert.match(source, /activeAdminCount\(tx\) <= 1|activeAdminCount\(tx\) <= 1/);
  assert.match(source, /TransactionIsolationLevel\.Serializable/);
  assert.match(source, /user\.role === 'admin'[\s\S]*admin sono immuni dagli override/i);
  assert.match(source, /blocked_user_privilege_change/);
});

test('navigazione filtrata in base ai permessi effettivi', () => {
  const limited = visibleNavItemsForTest({ role: 'collaboratore_limitato', effectivePermissions: ['client.read'] });
  assert.ok(limited.includes('/clients'));
  assert.ok(!limited.includes('/audit-log'));
  const granted = visibleNavItemsForTest({ role: 'collaboratore_limitato', effectivePermissions: ['audit.read'] });
  assert.ok(granted.includes('/audit-log'));
  const technicalOverride = visibleNavItemsForTest({ role: 'collaboratore_limitato', effectivePermissions: ['technical.read'] });
  assert.ok(technicalOverride.includes('/technical-office'));
  const contractOverride = visibleNavItemsForTest({ role: 'collaboratore_limitato', effectivePermissions: ['legal.read'] });
  assert.ok(contractOverride.includes('/legal-compliance'));
});

test('seed production idempotente non elimina override esistenti', () => {
  const seed = readFileSync(resolve(root, 'prisma/seed-production.ts'), 'utf8');
  assert.doesNotMatch(seed, /userPermissionOverride\.(delete|deleteMany|update|upsert|create)/);
});
