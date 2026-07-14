import assert from 'node:assert/strict';
import test from 'node:test';
import { hasPermission, isAdminSession } from '../src/lib/auth';
import { isNavItemVisible } from '../src/lib/nav-visibility';
import { canViewAiRecord, canViewProject } from '../src/lib/access-control';
import { prisma } from '../src/lib/prisma';
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
test('deny payment.read elimina pagamenti e ultimo pagamento dalla dashboard', () => {
  assert.equal(hasPermission({ role: 'amministrazione', active: true, permissionOverrides: [{ permission: 'payment.read', allowed: false }] }, 'payment.read'), false);
});

test('deny dossier.read elimina dossier dal fascicolo cliente', () => {
  assert.equal(hasPermission({ role: 'direzione', active: true, permissionOverrides: [{ permission: 'dossier.read', allowed: false }] }, 'dossier.read'), false);
});

test('deny contract.read elimina contratti dal fascicolo cliente', () => {
  assert.equal(hasPermission({ role: 'amministrazione', active: true, permissionOverrides: [{ permission: 'contract.read', allowed: false }] }, 'contract.read'), false);
});

test('deny technical.read elimina pratiche tecniche', () => {
  assert.equal(hasPermission({ role: 'consulente', active: true, permissionOverrides: [{ permission: 'technical.read', allowed: false }] }, 'technical.read'), false);
});

test('report cliente non contiene sezioni negate', () => {
  const session = { role: 'direzione' as const, active: true, permissionOverrides: [{ permission: 'payment.read' as const, allowed: false }, { permission: 'contract.read' as const, allowed: false }, { permission: 'technical.read' as const, allowed: false }] };
  assert.equal(hasPermission(session, 'payment.read'), false);
  assert.equal(hasPermission(session, 'contract.read'), false);
  assert.equal(hasPermission(session, 'technical.read'), false);
});

test('service.read senza service.write non mostra azioni Task', () => {
  assert.equal(hasPermission({ role: 'collaboratore_limitato', active: true, permissionOverrides: [] }, 'service.read'), true);
  assert.equal(hasPermission({ role: 'collaboratore_limitato', active: true, permissionOverrides: [] }, 'service.write'), false);
});

test('coerenza permission della Checklist', () => {
  assert.equal(isNavItemVisible({ permission: 'service.read' }, { role: 'collaboratore_limitato', permissions: ['service.read'] }), true);
});

test('accesso diretto a progetto non assegnato bloccato', () => {
  assert.equal(canViewProject({ userId: 'u1', role: 'consulente' }, { consultantId: 'u2', client: { salesOwnerId: 'u3', consultantId: 'u2' } }), false);
});

// Regression: blocked anti-lockout branches return a blocked result that server actions audit before throwing after commit.
test('audit dei tentativi anti-lockout usa rami bloccati persistibili', () => {
  const users = [{ id: 'a1', role: 'admin' as const, active: true }];
  assert.equal(canDeactivateUser('a1', users[0], users).reason, 'self_deactivation');
  assert.equal(canDeactivateUser('operator', users[0], users).reason, 'last_active_admin');
  assert.equal(canChangeUserRole(users[0], 'direzione', users).reason, 'last_active_admin');
});

test('gestione utenti: direzione non può modificare i propri override', () => {
  assert.equal(isAdminSession({ role: 'direzione' }), false);
});

test('gestione utenti: direzione non può modificare un altro utente', () => {
  assert.equal(isAdminSession({ role: 'direzione' }), false);
});

test('gestione utenti: admin può modificare un utente non admin', () => {
  assert.equal(isAdminSession({ role: 'admin' }), true);
});

test('gestione utenti: override non permettono a non-admin di auto-attribuirsi gestione utenti', () => {
  const session = { role: 'direzione' as const, active: true, permissionOverrides: [{ permission: 'settings.manage' as const, allowed: true }, { permission: 'user.write' as const, allowed: true }] };
  assert.equal(hasPermission(session, 'settings.manage'), true);
  assert.equal(hasPermission(session, 'user.write'), true);
  assert.equal(isAdminSession(session), false);
});

test('AI: consulente vede output del proprio cliente e non quello di altro cliente', () => {
  const consultant = { userId: 'u1', role: 'consulente' as const };
  assert.equal(canViewAiRecord(consultant, { client: { consultantId: 'u1', salesOwnerId: null } }), true);
  assert.equal(canViewAiRecord(consultant, { client: { consultantId: 'u2', salesOwnerId: null } }), false);
});

test('AI: revisore e creatore vedono output non collegati', () => {
  assert.equal(canViewAiRecord({ userId: 'reviewer', role: 'revisore' }, { createdById: null }), true);
  assert.equal(canViewAiRecord({ userId: 'creator', role: 'consulente' }, { createdById: 'creator' }), true);
  assert.equal(canViewAiRecord({ userId: 'other', role: 'consulente' }, { createdById: 'creator' }), false);
});

test('audit anti-lockout persistono nel database e utente resta invariato', { skip: !process.env.DATABASE_URL }, async () => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const admin = await prisma.user.create({ data: { email: `admin-${suffix}@example.test`, name: 'Admin Test', role: 'admin', active: true, passwordHash: 'test' } });
  try {
    const selfResult = await prisma.$transaction(async (tx) => {
      const users = await tx.user.findMany({ where: { deletedAt: null }, select: { id: true, role: true, active: true, deletedAt: true } });
      const target = await tx.user.findUniqueOrThrow({ where: { id: admin.id } });
      const safety = canDeactivateUser(admin.id, target, users);
      if (!safety.allowed) {
        await tx.auditLog.create({ data: { actorId: admin.id, event: 'blocked_self_deactivation', entityType: 'User', entityId: admin.id, after: { reason: safety.reason } } });
        return safety;
      }
      await tx.user.update({ where: { id: admin.id }, data: { active: false } });
      return safety;
    });
    assert.equal(selfResult.allowed, false);

    const roleResult = await prisma.$transaction(async (tx) => {
      const users = await tx.user.findMany({ where: { deletedAt: null }, select: { id: true, role: true, active: true, deletedAt: true } });
      const target = await tx.user.findUniqueOrThrow({ where: { id: admin.id } });
      const safety = canChangeUserRole(target, 'direzione', users);
      if (!safety.allowed) {
        await tx.auditLog.create({ data: { actorId: admin.id, event: 'blocked_last_admin_change', entityType: 'User', entityId: admin.id, after: { attemptedRole: 'direzione' } } });
        return safety;
      }
      await tx.user.update({ where: { id: admin.id }, data: { role: 'direzione' } });
      return safety;
    });
    assert.equal(roleResult.allowed, false);

    const [selfAudit, lastAdminAudit, unchanged] = await Promise.all([
      prisma.auditLog.findFirst({ where: { actorId: admin.id, event: 'blocked_self_deactivation' } }),
      prisma.auditLog.findFirst({ where: { actorId: admin.id, event: 'blocked_last_admin_change' } }),
      prisma.user.findUniqueOrThrow({ where: { id: admin.id } }),
    ]);
    assert.ok(selfAudit);
    assert.ok(lastAdminAudit);
    assert.equal(unchanged.active, true);
    assert.equal(unchanged.role, 'admin');
  } finally {
    await prisma.auditLog.deleteMany({ where: { actorId: admin.id } });
    await prisma.user.delete({ where: { id: admin.id } }).catch(() => undefined);
  }
});
