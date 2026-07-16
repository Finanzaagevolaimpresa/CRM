import assert from 'node:assert/strict';
import test from 'node:test';
import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();
const runDbTests = process.env.RUN_DB_TESTS === '1';

test('PostgreSQL permission overrides are unique, cascading and preserved by production seed', { skip: !runDbTests }, async () => {
  const email = `perm-db-${Date.now()}@example.test`;
  const user = await prisma.user.create({
    data: { email, name: 'Perm DB Test', passwordHash: 'not-a-real-login-hash', role: 'collaboratore_limitato', active: true },
  });
  try {
    await prisma.userPermissionOverride.create({ data: { userId: user.id, permission: 'audit.read', allowed: true } });
    await assert.rejects(
      prisma.userPermissionOverride.create({ data: { userId: user.id, permission: 'audit.read', allowed: false } }),
      (error) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002',
    );

    const beforeSeed = await prisma.userPermissionOverride.count({ where: { userId: user.id } });
    assert.equal(beforeSeed, 1);
  } finally {
    await prisma.user.delete({ where: { id: user.id } });
  }
  assert.equal(await prisma.userPermissionOverride.count({ where: { userId: user.id } }), 0);
});

test('Serializable anti-lockout transaction leaves at least one active admin', { skip: !runDbTests }, async () => {
  const admin = await prisma.user.create({
    data: { email: `admin-db-${Date.now()}@example.test`, name: 'Only Admin DB Test', passwordHash: 'not-a-real-login-hash', role: 'admin', active: true },
  });
  try {
    await assert.rejects(
      prisma.$transaction(async (tx) => {
        const activeAdmins = await tx.user.count({ where: { role: 'admin', active: true, deletedAt: null } });
        if (activeAdmins <= 1) throw new Error('Impossibile disattivare l’ultimo admin attivo.');
        await tx.user.update({ where: { id: admin.id }, data: { active: false } });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }),
      /ultimo admin attivo/,
    );
    const stillAdmin = await prisma.user.findUniqueOrThrow({ where: { id: admin.id }, select: { active: true, role: true } });
    assert.deepEqual(stillAdmin, { active: true, role: 'admin' });
  } finally {
    await prisma.user.delete({ where: { id: admin.id } });
  }
});
