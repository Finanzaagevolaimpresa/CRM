import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { before, after } from 'node:test';
import { PrismaClient, type RoleCode } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from './db/ai-orchestrator-db-test-guard';
import { createInternalSession, revokeAllInternalSessions, resolveInternalSession } from '../src/lib/internal-session-registry';
import { createRegistrySessionToken, digestRegistrySessionToken } from '../src/lib/session';
import { withSerializableTransaction } from '../src/lib/serializable';
import { changeClientReadGrant, loadClientReadScope } from '../src/lib/client-read-perimeter';
import { removeInternalUserWithAudit } from '../src/lib/user-privilege-service';

const enabled = process.env.RUN_DB_TESTS === '1';
const db = new PrismaClient();
const users: string[] = [], clients: string[] = [];
const priorMode = process.env.INTERNAL_SESSION_MODE;
let admitted = false;
before(async () => {
  if (!enabled) return;
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  assert.equal(await db.$queryRaw<Array<{ exists: boolean }>>`SELECT to_regclass('public."ClientReadGrant"') IS NOT NULL AS "exists"`.then(rows => rows[0].exists), true);
  admitted = true; process.env.INTERNAL_SESSION_MODE = 'registry';
});
after(async () => {
  if (admitted) {
    await db.clientReadGrant.deleteMany({ where: { userId: { in: users } } });
    await db.client.deleteMany({ where: { id: { in: clients } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
    if (priorMode === undefined) delete process.env.INTERNAL_SESSION_MODE; else process.env.INTERNAL_SESSION_MODE = priorMode;
  }
  await db.$disconnect();
});
const tx = <T>(work: Parameters<typeof withSerializableTransaction<T>>[1]) => withSerializableTransaction(db, work);
async function actor(role: RoleCode = 'revisore') {
  const user = await db.user.create({ data: { name: 'Synthetic perimeter', email: `perimeter-${randomUUID()}@example.test`, role, passwordHash: 'synthetic-not-a-login-hash' } });
  users.push(user.id);
  const token = createRegistrySessionToken();
  const tokenDigest = await digestRegistrySessionToken(token.bytes);
  const session = await db.$transaction(t => createInternalSession(t, { userId: user.id, tokenDigest }));
  return { userId: user.id, sessionId: session.id, token: token.token };
}
async function fixture() {
  const admin = await actor('admin'), reader = await actor();
  const client = await db.client.create({ data: { type: 'societa', displayName: 'Synthetic perimeter client', salesOwnerId: 'unchanged-sales', consultantId: 'unchanged-technical' } });
  clients.push(client.id);
  return { admin, reader, client, input: { userId: reader.userId, clientId: client.id, expectedVersion: 0, active: true } };
}

test('grant/revoke/regrant preserves responsibility, revision and audit; active scope is fresh', { skip: !enabled }, async () => {
  const { admin, reader, client, input } = await fixture();
  assert.deepEqual(await loadClientReadScope(db, reader.userId), []);
  const grant = await tx(t => changeClientReadGrant(t, admin, input, true));
  assert.equal(grant.version, 1);
  assert.deepEqual(await loadClientReadScope(db, reader.userId), [client.id]);
  const revoked = await tx(t => changeClientReadGrant(t, admin, { ...input, expectedVersion: 1, active: false }, true));
  assert.equal(revoked.version, 2); assert.equal(revoked.id, grant.id);
  assert.deepEqual(await loadClientReadScope(db, reader.userId), []);
  await assert.rejects(tx(t => changeClientReadGrant(t, admin, input, true)));
  const renewed = await tx(t => changeClientReadGrant(t, admin, { ...input, expectedVersion: 2 }, true));
  assert.equal(renewed.id, grant.id); assert.equal(renewed.createdById, admin.userId); assert.equal(renewed.version, 3);
  assert.deepEqual(await db.client.findUniqueOrThrow({ where: { id: client.id } }), client);
  assert.equal(await db.auditLog.count({ where: { entityId: grant.id, actorId: admin.userId } }), 3);
});

test('admission, current admin session, active recipient and client are mandatory', { skip: !enabled }, async () => {
  const { admin, reader, client, input } = await fixture();
  await assert.rejects(tx(t => changeClientReadGrant(t, admin, input, false)));
  await assert.rejects(tx(t => changeClientReadGrant(t, reader, input, true)));
  await assert.rejects(tx(t => changeClientReadGrant(t, { ...admin, sessionId: reader.sessionId }, input, true)));
  await assert.rejects(tx(t => changeClientReadGrant(t, admin, { ...input, clientId: 'missing-client' }, true)));
  await db.user.update({ where: { id: reader.userId }, data: { active: false } });
  await assert.rejects(tx(t => changeClientReadGrant(t, admin, input, true)));
  await db.user.update({ where: { id: reader.userId }, data: { active: true, role: 'direzione' } });
  await assert.rejects(tx(t => changeClientReadGrant(t, admin, input, true)));
  await db.user.update({ where: { id: reader.userId }, data: { role: 'revisore' } });
  await tx(t => revokeAllInternalSessions(t, admin.userId, 'INTERNAL_GLOBAL', admin.userId));
  await assert.rejects(tx(t => changeClientReadGrant(t, admin, input, true)));
  assert.equal(await db.clientReadGrant.count({ where: { clientId: client.id } }), 0);
});

test('concurrent duplicate grants and revokes have one winner and one audit event', { skip: !enabled }, async () => {
  const { admin, reader, input } = await fixture();
  const outcomes = await Promise.allSettled([1, 2].map(() => tx(t => changeClientReadGrant(t, admin, input, true))));
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
  const grant = await db.clientReadGrant.findFirstOrThrow({ where: { userId: reader.userId } });
  const revoked = await Promise.allSettled([1, 2].map(() => tx(t => changeClientReadGrant(t, admin, { ...input, expectedVersion: 1, active: false }, true))));
  assert.equal(revoked.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(await db.auditLog.count({ where: { entityId: grant.id } }), 2);
  assert.equal((await db.clientReadGrant.findUniqueOrThrow({ where: { id: grant.id } })).version, 2);
});

test('audit failure rolls back grant revocation and revision', { skip: !enabled }, async () => {
  const { admin, input } = await fixture();
  const grant = await tx(t => changeClientReadGrant(t, admin, input, true));
  await db.$executeRawUnsafe(`CREATE FUNCTION perimeter_test_audit_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."event" = 'client_read_grant_revoked' THEN RAISE EXCEPTION 'synthetic perimeter audit fault'; END IF; RETURN NEW; END $$`);
  await db.$executeRawUnsafe('CREATE TRIGGER perimeter_test_audit_fault BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION perimeter_test_audit_fault()');
  try {
    await assert.rejects(tx(t => changeClientReadGrant(t, admin, { ...input, active: false, expectedVersion: 1 }, true)));
    assert.deepEqual(await db.clientReadGrant.findUniqueOrThrow({ where: { id: grant.id } }), grant);
    assert.equal(await db.auditLog.count({ where: { entityId: grant.id } }), 1);
  } finally {
    await db.$executeRawUnsafe('DROP TRIGGER perimeter_test_audit_fault ON "AuditLog"');
    await db.$executeRawUnsafe('DROP FUNCTION perimeter_test_audit_fault()');
  }
});

test('archived clients and removed users lose scope while history survives and remains revocable', { skip: !enabled }, async () => {
  const { admin, reader, client, input } = await fixture();
  const grant = await tx(t => changeClientReadGrant(t, admin, input, true));
  await db.client.update({ where: { id: client.id }, data: { deletedAt: new Date() } });
  assert.deepEqual(await loadClientReadScope(db, reader.userId), []);
  await tx(t => changeClientReadGrant(t, admin, { ...input, active: false, expectedVersion: 1 }, true));
  await db.client.update({ where: { id: client.id }, data: { deletedAt: null } });
  await tx(t => changeClientReadGrant(t, admin, { ...input, expectedVersion: 2 }, true));
  assert.equal((await tx(t => removeInternalUserWithAudit(t, admin, reader.userId, true))).ok, true);
  assert.equal(await resolveInternalSession(db, reader.token), null);
  assert.deepEqual(await loadClientReadScope(db, reader.userId), []);
  assert.equal((await db.clientReadGrant.findUniqueOrThrow({ where: { id: grant.id } })).userId, reader.userId);
  await tx(t => changeClientReadGrant(t, admin, { ...input, active: false, expectedVersion: 3 }, true));
  await assert.rejects(db.user.delete({ where: { id: reader.userId } }));
});
