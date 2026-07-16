import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { Prisma, PrismaClient, type RoleCode } from '@prisma/client';
import { hasPermission } from '../../src/lib/auth';
import {
  activateInternalUserWithAudit,
  createInternalUserWithAudit,
  deactivateInternalUserWithAudit,
  resetPermissionOverridesWithAudit,
  updateInternalUserRoleWithAudit,
  updatePermissionOverridesWithAudit,
} from '../../src/lib/user-privilege-service';
import { withSerializableTransaction } from '../../src/lib/serializable';

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
  return withSerializableTransaction(prisma, fn);
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

  const createResult = await tx((transaction) => createInternalUserWithAudit(transaction, { userId: actor.id }, {
    email: email('blocked-create'),
    name: 'blocked-create',
    passwordHash,
    role: 'collaboratore_limitato',
    active: true,
  }));
  assert.equal(createResult.ok, false);
  assert.equal(await prisma.user.count({ where: { email: email('blocked-create') } }), 0);

  const activateResult = await tx((transaction) => activateInternalUserWithAudit(transaction, { userId: actor.id }, inactive.id));
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

  const promote = await tx((transaction) => updateInternalUserRoleWithAudit(transaction, { userId: admin.id }, target.id, 'admin'));
  assert.equal(promote.ok, true);
  assert.equal(await prisma.userPermissionOverride.count({ where: { userId: target.id } }), 0);
  const audit = await prisma.auditLog.findFirstOrThrow({ where: { actorId: admin.id, event: 'role_change', entityId: target.id }, orderBy: { createdAt: 'desc' } });
  assert.match(JSON.stringify(audit.after), /removedOverrides/);

  const demote = await tx((transaction) => updateInternalUserRoleWithAudit(transaction, { userId: admin.id }, target.id, 'consulente'));
  assert.equal(demote.ok, true);
  assert.equal(await prisma.userPermissionOverride.count({ where: { userId: target.id } }), 0);
});

test('admin inattivo demansionabile senza bloccare unico altro admin attivo', { skip: !runDbTests }, async () => {
  const admin = await user('admin', 'active-admin');
  const inactiveAdmin = await user('admin', 'inactive-admin', false);
  const result = await tx((transaction) => updateInternalUserRoleWithAudit(transaction, { userId: admin.id }, inactiveAdmin.id, 'revisore'));
  assert.equal(result.ok, true);
  const next = await prisma.user.findUniqueOrThrow({ where: { id: inactiveAdmin.id }, select: { role: true, active: true } });
  assert.deepEqual(next, { role: 'revisore', active: false });
});

test('race reale isolata con esattamente due admin attivi non elimina tutti gli admin', { skip: !runDbTests }, async () => {
  const existingActiveAdmins = await prisma.user.findMany({ where: { role: 'admin', active: true, deletedAt: null }, select: { id: true } });
  await prisma.user.updateMany({ where: { id: { in: existingActiveAdmins.map((item) => item.id) } }, data: { active: false } });
  const first = await user('admin', 'race-admin-one');
  const second = await user('admin', 'race-admin-two');
  try {
    assert.equal(await prisma.user.count({ where: { role: 'admin', active: true, deletedAt: null } }), 2);
    const settled = await Promise.allSettled([
      tx((transaction) => updateInternalUserRoleWithAudit(transaction, { userId: second.id }, first.id, 'revisore')),
      tx((transaction) => updateInternalUserRoleWithAudit(transaction, { userId: first.id }, second.id, 'revisore')),
    ]);
    const fulfilled = settled.filter((item): item is PromiseFulfilledResult<Awaited<ReturnType<typeof updateInternalUserRoleWithAudit>>> => item.status === 'fulfilled');
    const deniedOrConflict = settled.some((item) => item.status === 'rejected' && String(item.reason).includes('Operazione concorrente rilevata')) || fulfilled.some((item) => !item.value.ok);
    assert.equal(settled.length, 2);
    assert.equal(deniedOrConflict, true);
    assert.ok(await prisma.user.count({ where: { id: { in: [first.id, second.id] }, role: 'admin', active: true } }) >= 1);
  } finally {
    await prisma.user.updateMany({ where: { id: { in: existingActiveAdmins.map((item) => item.id) } }, data: { active: true } });
  }
});

test('audit blocked persiste per self-disable, ultimo admin, override admin e role non-admin', { skip: !runDbTests }, async () => {
  const existingActiveAdmins = await prisma.user.findMany({ where: { role: 'admin', active: true, deletedAt: null }, select: { id: true } });
  await prisma.user.updateMany({ where: { id: { in: existingActiveAdmins.map((item) => item.id) } }, data: { active: false } });
  const onlyAdmin = await user('admin', 'audit-only-admin');
  const secondAdmin = await user('admin', 'audit-second-admin');
  const nonAdmin = await user('direzione', 'audit-non-admin');
  try {
    const selfDisable = await tx((transaction) => deactivateInternalUserWithAudit(transaction, { userId: onlyAdmin.id }, onlyAdmin.id));
    assert.equal(selfDisable.ok, false);
    const demoteLast = await tx((transaction) => updateInternalUserRoleWithAudit(transaction, { userId: secondAdmin.id }, onlyAdmin.id, 'revisore'));
    assert.equal(demoteLast.ok, true);
    const blockedLast = await tx((transaction) => updateInternalUserRoleWithAudit(transaction, { userId: onlyAdmin.id }, secondAdmin.id, 'revisore'));
    assert.equal(blockedLast.ok, false);
    await tx((transaction) => updateInternalUserRoleWithAudit(transaction, { userId: onlyAdmin.id }, secondAdmin.id, 'admin'));
    const overrideAdmin = await tx((transaction) => updatePermissionOverridesWithAudit(transaction, { userId: onlyAdmin.id }, secondAdmin.id, [{ permission: 'audit.read', allowed: false }]));
    assert.equal(overrideAdmin.ok, false);
    const roleNonAdmin = await tx((transaction) => updateInternalUserRoleWithAudit(transaction, { userId: nonAdmin.id }, secondAdmin.id, 'revisore'));
    assert.equal(roleNonAdmin.ok, false);
    assert.ok(await prisma.auditLog.count({ where: { event: 'blocked_user_privilege_change', actorId: { in: [onlyAdmin.id, nonAdmin.id] } } }) >= 4);
  } finally {
    await prisma.user.updateMany({ where: { id: { in: existingActiveAdmins.map((item) => item.id) } }, data: { active: true } });
  }
});

test('actor admin obsoleto viene riletto dal DB e bloccato per create, role e override', { skip: !runDbTests }, async () => {
  const staleActor = await user('admin', 'stale-actor');
  const stableAdmin = await user('admin', 'stable-admin');
  const target = await user('consulente', 'stale-target');
  const staleSnapshot = { userId: staleActor.id };

  await prisma.user.update({ where: { id: staleActor.id }, data: { role: 'revisore' } });
  const createResult = await tx((transaction) => createInternalUserWithAudit(transaction, staleSnapshot, {
    email: email('stale-create'),
    name: 'stale-create',
    passwordHash,
    role: 'collaboratore_limitato',
    active: true,
  }));
  assert.equal(createResult.ok, false);
  assert.equal(await prisma.user.count({ where: { email: email('stale-create') } }), 0);

  const promoteResult = await tx((transaction) => updateInternalUserRoleWithAudit(transaction, staleSnapshot, target.id, 'admin'));
  assert.equal(promoteResult.ok, false);
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: target.id } })).role, 'consulente');

  await prisma.user.update({ where: { id: staleActor.id }, data: { role: 'admin', active: false } });
  const overrideResult = await tx((transaction) => updatePermissionOverridesWithAudit(transaction, staleSnapshot, target.id, [{ permission: 'audit.read', allowed: true }]));
  assert.equal(overrideResult.ok, false);
  assert.equal(await prisma.userPermissionOverride.count({ where: { userId: target.id } }), 0);
  assert.equal(await prisma.auditLog.count({ where: { actorId: staleActor.id, event: 'blocked_user_privilege_change' } }), 3);

  await tx((transaction) => updateInternalUserRoleWithAudit(transaction, { userId: stableAdmin.id }, staleActor.id, 'revisore'));
});

test('override deny riletto dal database e reset reale degli override', { skip: !runDbTests }, async () => {
  const admin = await user('admin', 'reset-admin');
  const target = await user('direzione', 'reset-target');
  await prisma.userPermissionOverride.create({ data: { userId: target.id, permission: 'audit.read', allowed: false } });
  const reloaded = await prisma.user.findUniqueOrThrow({ where: { id: target.id }, include: { permissionOverrides: true } });
  assert.equal(hasPermission({ role: reloaded.role, active: reloaded.active, permissionOverrides: reloaded.permissionOverrides }, 'audit.read'), false);

  const reset = await tx((transaction) => resetPermissionOverridesWithAudit(transaction, { userId: admin.id }, target.id));
  assert.equal(reset.ok, true);
  assert.equal(await prisma.userPermissionOverride.count({ where: { userId: target.id } }), 0);
});
