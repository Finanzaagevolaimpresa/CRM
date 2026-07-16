import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { Prisma, PrismaClient, type RoleCode } from '@prisma/client';
import { hasPermission } from '../../src/lib/auth';
import {
  activateInternalUserWithAudit,
  createInternalUserWithAudit,
  resetPermissionOverridesWithAudit,
  serializableOptions,
  updateInternalUserRoleWithAudit,
} from '../../src/lib/user-privilege-service';

const prisma = new PrismaClient();
const runDbTests = process.env.RUN_DB_TESTS === '1';
const runId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const email = (name: string) => `${name}-${runId}@example.test`;
const passwordHash = 'not-a-real-login-hash';

test.after(async () => {
  await prisma.user.deleteMany({ where: { email: { endsWith: `-${runId}@example.test` } } });
  await prisma.$disconnect();
});

async function user(role: RoleCode, name: string, active = true) {
  return prisma.user.create({ data: { email: email(name), name, passwordHash, role, active } });
}

async function tx<T>(fn: (transaction: Prisma.TransactionClient) => Promise<T>) {
  return prisma.$transaction(fn, serializableOptions);
}

test('production seed reale preserva override esistenti e vincoli/cascade funzionano', { skip: !runDbTests }, async () => {
  const target = await user('collaboratore_limitato', 'seed-target');
  await prisma.userPermissionOverride.create({ data: { userId: target.id, permission: 'audit.read', allowed: true } });
  await assert.rejects(
    prisma.userPermissionOverride.create({ data: { userId: target.id, permission: 'audit.read', allowed: false } }),
    (error) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002',
  );

  execFileSync('npm', ['run', 'prisma:seed:production'], { stdio: 'inherit', env: { ...process.env, APP_ENV: 'production' } });
  execFileSync('npm', ['run', 'prisma:seed:production'], { stdio: 'inherit', env: { ...process.env, APP_ENV: 'production' } });

  assert.equal(await prisma.userPermissionOverride.count({ where: { userId: target.id, permission: 'audit.read', allowed: true } }), 1);
  await prisma.user.delete({ where: { id: target.id } });
  assert.equal(await prisma.userPermissionOverride.count({ where: { userId: target.id } }), 0);
});

test('logica applicativa blocca create/activate non-admin e persiste audit blocked', { skip: !runDbTests }, async () => {
  const actor = await user('direzione', 'non-admin-actor');
  const inactive = await user('collaboratore_limitato', 'inactive-target', false);

  const createResult = await tx((transaction) => createInternalUserWithAudit(transaction, { userId: actor.id, role: actor.role }, {
    email: email('blocked-create'),
    name: 'blocked-create',
    passwordHash,
    role: 'collaboratore_limitato',
    active: true,
  }));
  assert.equal(createResult.ok, false);
  assert.equal(await prisma.user.count({ where: { email: email('blocked-create') } }), 0);

  const activateResult = await tx((transaction) => activateInternalUserWithAudit(transaction, { userId: actor.id, role: actor.role }, inactive.id));
  assert.equal(activateResult.ok, false);
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: inactive.id } })).active, false);

  const blockedAudits = await prisma.auditLog.count({ where: { actorId: actor.id, event: 'blocked_user_privilege_change' } });
  assert.equal(blockedAudits, 2);
});

test('promozione admin elimina override e demozione successiva non ripristina eccezioni', { skip: !runDbTests }, async () => {
  const admin = await user('admin', 'promotion-admin');
  const target = await user('consulente', 'promotion-target');
  await prisma.userPermissionOverride.createMany({ data: [
    { userId: target.id, permission: 'audit.read', allowed: true },
    { userId: target.id, permission: 'project.read', allowed: false },
  ] });

  const promote = await tx((transaction) => updateInternalUserRoleWithAudit(transaction, { userId: admin.id, role: 'admin' }, target.id, 'admin'));
  assert.equal(promote.ok, true);
  assert.equal(await prisma.userPermissionOverride.count({ where: { userId: target.id } }), 0);
  const audit = await prisma.auditLog.findFirstOrThrow({ where: { actorId: admin.id, event: 'role_change', entityId: target.id }, orderBy: { createdAt: 'desc' } });
  assert.match(JSON.stringify(audit.after), /removedOverrides/);

  const demote = await tx((transaction) => updateInternalUserRoleWithAudit(transaction, { userId: admin.id, role: 'admin' }, target.id, 'consulente'));
  assert.equal(demote.ok, true);
  assert.equal(await prisma.userPermissionOverride.count({ where: { userId: target.id } }), 0);
});

test('admin inattivo demansionabile senza bloccare unico altro admin attivo', { skip: !runDbTests }, async () => {
  const admin = await user('admin', 'active-admin');
  const inactiveAdmin = await user('admin', 'inactive-admin', false);
  const result = await tx((transaction) => updateInternalUserRoleWithAudit(transaction, { userId: admin.id, role: 'admin' }, inactiveAdmin.id, 'revisore'));
  assert.equal(result.ok, true);
  const next = await prisma.user.findUniqueOrThrow({ where: { id: inactiveAdmin.id }, select: { role: true, active: true } });
  assert.deepEqual(next, { role: 'revisore', active: false });
});

test('race reale non elimina tutti gli admin attivi', { skip: !runDbTests }, async () => {
  const first = await user('admin', 'race-admin-one');
  const second = await user('admin', 'race-admin-two');
  const settled = await Promise.allSettled([
    tx((transaction) => updateInternalUserRoleWithAudit(transaction, { userId: second.id, role: 'admin' }, first.id, 'revisore')),
    tx((transaction) => updateInternalUserRoleWithAudit(transaction, { userId: first.id, role: 'admin' }, second.id, 'revisore')),
  ]);
  assert.equal(settled.length, 2);
  assert.ok(await prisma.user.count({ where: { id: { in: [first.id, second.id] }, role: 'admin', active: true } }) >= 1);
});

test('override deny riletto dal database e reset reale degli override', { skip: !runDbTests }, async () => {
  const admin = await user('admin', 'reset-admin');
  const target = await user('direzione', 'reset-target');
  await prisma.userPermissionOverride.create({ data: { userId: target.id, permission: 'audit.read', allowed: false } });
  const reloaded = await prisma.user.findUniqueOrThrow({ where: { id: target.id }, include: { permissionOverrides: true } });
  assert.equal(hasPermission({ role: reloaded.role, active: reloaded.active, permissionOverrides: reloaded.permissionOverrides }, 'audit.read'), false);

  const reset = await tx((transaction) => resetPermissionOverridesWithAudit(transaction, { userId: admin.id, role: 'admin' }, target.id));
  assert.equal(reset.ok, true);
  assert.equal(await prisma.userPermissionOverride.count({ where: { userId: target.id } }), 0);
});
