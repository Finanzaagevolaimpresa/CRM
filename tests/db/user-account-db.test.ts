import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import bcrypt from 'bcryptjs';
import { PrismaClient, type RoleCode } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from './ai-orchestrator-db-test-guard';
import { createInternalSession, resolveInternalSession } from '../../src/lib/internal-session-registry';
import { createAuthenticatedRegistryLoginSession } from '../../src/lib/registry-login-credentials';
import { createRegistrySessionToken, digestRegistrySessionToken } from '../../src/lib/session';
import { withSerializableTransaction } from '../../src/lib/serializable';
import { changeAccountPassword, resetAccountPassword, revokeAccountSessions, updateAccountProfile } from '../../src/lib/user-account-service';
import { updateInternalUserRoleWithAudit } from '../../src/lib/user-privilege-service';

const run = process.env.RUN_DB_TESTS === '1';
let admitted = false;
const db = new PrismaClient();
const ids: string[] = [];
const originalMode = process.env.INTERNAL_SESSION_MODE;
const password = 'Synthetic-initial-password-only!';
const nextPassword = 'Synthetic-updated-password-only!';

before(async () => {
  if (!run) return;
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  admitted = true;
  process.env.INTERNAL_SESSION_MODE = 'registry';
});
after(async () => {
  if (admitted) {
    await db.user.deleteMany({ where: { id: { in: ids } } });
    if (originalMode === undefined) delete process.env.INTERNAL_SESSION_MODE;
    else process.env.INTERNAL_SESSION_MODE = originalMode;
  }
  await db.$disconnect();
});
async function actor(role: RoleCode = 'consulente', initialPassword = password) {
  const user = await db.user.create({ data: {
    name: 'Synthetic account', email: `account-${randomUUID()}@example.test`,
    role, passwordHash: await bcrypt.hash(initialPassword, 4),
  } });
  ids.push(user.id);
  const token = createRegistrySessionToken();
  const tokenDigest = await digestRegistrySessionToken(token.bytes);
  const session = await db.$transaction((tx) => createInternalSession(tx, { userId: user.id, tokenDigest }));
  return { userId: user.id, sessionId: session.id, user, token: token.token };
}

test('password change rejects a wrong current password and revokes every existing session on success', { skip: !run }, async () => {
  const owner = await actor();
  const second = createRegistrySessionToken();
  const secondDigest = await digestRegistrySessionToken(second.bytes);
  await db.$transaction((tx) => createInternalSession(tx, { userId: owner.userId, tokenDigest: secondDigest }));
  const denied = await withSerializableTransaction(db, (tx) => changeAccountPassword(tx, owner, { currentPassword: 'wrong', password: nextPassword }));
  assert.equal(denied.ok, false);
  assert.ok(await resolveInternalSession(db, owner.token));
  const accepted = await withSerializableTransaction(db, (tx) => changeAccountPassword(tx, owner, { currentPassword: password, password: nextPassword }));
  assert.deepEqual(accepted, { ok: true, sessionRevoked: true });
  assert.equal(await resolveInternalSession(db, owner.token), null);
  assert.equal(await db.internalSession.count({ where: { userId: owner.userId, revokedAt: null } }), 0);
  const persisted = await db.user.findUniqueOrThrow({ where: { id: owner.userId } });
  assert.equal(await bcrypt.compare(nextPassword, persisted.passwordHash), true);
  const audits = await db.auditLog.findMany({ where: { actorId: owner.userId } });
  const auditJson = JSON.stringify(audits);
  for (const sensitive of [password, nextPassword, persisted.passwordHash, owner.user.passwordHash]) assert.equal(auditJson.includes(sensitive), false);
});

test('bcrypt-equivalent legacy password changes preserve hash, live sessions and absence of success audits', { skip: !run }, async () => {
  const legacyPassword = 'x'.repeat(80);
  const candidate = legacyPassword.slice(0, 72);
  const owner = await actor('consulente', legacyPassword);
  assert.notEqual(candidate, legacyPassword);
  assert.equal(await bcrypt.compare(candidate, owner.user.passwordHash), true);
  const result = await withSerializableTransaction(db, (tx) => changeAccountPassword(tx, owner, { currentPassword: legacyPassword, password: candidate }));
  assert.deepEqual(result, { ok: false, message: 'La nuova password deve essere diversa da quella attuale.' });
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: owner.userId } })).passwordHash, owner.user.passwordHash);
  assert.ok(await resolveInternalSession(db, owner.token));
  assert.equal(await db.internalSession.count({ where: { userId: owner.userId, revokedAt: { not: null } } }), 0);
  assert.equal(await db.auditLog.count({ where: { actorId: owner.userId, event: { in: ['user_password_changed', 'sessions_revoked_global'] } } }), 0);
});

test('reset requires an active admin session; overrides, revoked sessions and other-user sessions do not authorize it', { skip: !run }, async () => {
  const admin = await actor('admin');
  const operator = await actor();
  const target = await actor();
  const passwordHash = await bcrypt.hash(nextPassword, 4);
  await db.userPermissionOverride.create({ data: { userId: operator.userId, permission: 'user.write', allowed: true } });
  for (const invalid of [operator, { userId: admin.userId, sessionId: operator.sessionId }, { userId: admin.userId }]) {
    assert.equal((await withSerializableTransaction(db, (tx) => resetAccountPassword(tx, invalid, target.userId, passwordHash))).ok, false);
  }
  assert.equal((await withSerializableTransaction(db, (tx) => resetAccountPassword(tx, admin, target.userId, passwordHash))).ok, true);
  assert.equal(await resolveInternalSession(db, target.token), null);
  assert.ok(await resolveInternalSession(db, admin.token));
  await withSerializableTransaction(db, (tx) => revokeAccountSessions(tx, admin, admin.userId));
  assert.equal((await withSerializableTransaction(db, (tx) => resetAccountPassword(tx, admin, target.userId, passwordHash))).ok, false);
});

test('a login verified before a reset cannot issue a fresh session after the reset', { skip: !run }, async () => {
  const admin = await actor('admin');
  const target = await actor();
  const verifiedBeforeReset = target.user.passwordHash;
  const passwordHash = await bcrypt.hash(nextPassword, 4);
  await withSerializableTransaction(db, (tx) => resetAccountPassword(tx, admin, target.userId, passwordHash));
  const stale = createRegistrySessionToken();
  const input = { userId: target.userId, tokenDigest: await digestRegistrySessionToken(stale.bytes), expectedEmail: target.user.email };
  assert.equal(await createAuthenticatedRegistryLoginSession(db, { ...input, expectedPasswordHash: verifiedBeforeReset }), null);
  assert.ok(await createAuthenticatedRegistryLoginSession(db, { ...input, expectedPasswordHash: passwordHash }));
});

test('own profile edits preserve role; only the admin may change a login email or another profile', { skip: !run }, async () => {
  const admin = await actor('admin');
  const owner = await actor();
  const target = await actor();
  assert.equal((await withSerializableTransaction(db, (tx) => updateAccountProfile(tx, owner, owner.userId, { name: 'Reopened name', email: owner.user.email, role: 'admin' }))).ok, true);
  const persisted = await db.user.findUniqueOrThrow({ where: { id: owner.userId } });
  assert.equal(persisted.name, 'Reopened name');
  assert.equal(persisted.role, 'consulente');
  assert.equal((await withSerializableTransaction(db, (tx) => updateAccountProfile(tx, owner, owner.userId, { name: 'Ignored', email: `other-${randomUUID()}@example.test` }))).ok, false);
  assert.equal((await withSerializableTransaction(db, (tx) => updateAccountProfile(tx, owner, target.userId, { name: 'Ignored', email: target.user.email }, true))).ok, false);
  const email = `replaced-${randomUUID()}@example.test`;
  assert.equal((await withSerializableTransaction(db, (tx) => updateAccountProfile(tx, admin, target.userId, { name: 'Admin updated', email }, true))).ok, true);
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: target.userId } })).email, email);
  assert.equal(await resolveInternalSession(db, target.token), null);
  const token = createRegistrySessionToken();
  const loginInput = { userId: target.userId, tokenDigest: await digestRegistrySessionToken(token.bytes), expectedPasswordHash: target.user.passwordHash };
  assert.equal(await createAuthenticatedRegistryLoginSession(db, { ...loginInput, expectedEmail: target.user.email }), null);
  assert.ok(await createAuthenticatedRegistryLoginSession(db, { ...loginInput, expectedEmail: email }));
});

test('a promotion after the initial non-admin role read cannot replace privileged profile admission', { skip: !run }, async () => {
  const admin = await actor('admin');
  const owner = await actor();
  const initialRole = owner.user.role;
  assert.equal(initialRole, 'consulente');
  assert.equal((await withSerializableTransaction(db, (tx) => updateInternalUserRoleWithAudit(tx, admin, owner.userId, 'admin'))).ok, true);
  assert.equal((await resolveInternalSession(db, owner.token))?.user.role, 'admin');
  const email = `promoted-${randomUUID()}@example.test`;
  const denied = await withSerializableTransaction(db, (tx) => updateAccountProfile(tx, owner, owner.userId, { name: 'Ignored', email }, false));
  assert.equal(denied.ok, false);
  const unchanged = await db.user.findUniqueOrThrow({ where: { id: owner.userId } });
  assert.equal(unchanged.email, owner.user.email);
  assert.equal(unchanged.name, owner.user.name);
  assert.ok(await resolveInternalSession(db, owner.token));
  assert.equal(await db.auditLog.count({ where: { actorId: owner.userId, event: 'user_profile_updated' } }), 0);
  assert.equal((await withSerializableTransaction(db, (tx) => updateAccountProfile(tx, owner, owner.userId, { name: 'Own admin name', email: owner.user.email }, false))).ok, true);
  assert.equal((await withSerializableTransaction(db, (tx) => updateAccountProfile(tx, owner, owner.userId, { name: 'Own admin name', email }, true))).ok, true);
  assert.equal(await resolveInternalSession(db, owner.token), null);
});

test('self revocation is allowed, cross-user revocation is admin-only, and legacy mode fails closed', { skip: !run }, async () => {
  const owner = await actor();
  const target = await actor();
  assert.equal((await withSerializableTransaction(db, (tx) => revokeAccountSessions(tx, owner, target.userId))).ok, false);
  process.env.INTERNAL_SESSION_MODE = 'legacy';
  try {
    assert.equal((await withSerializableTransaction(db, (tx) => revokeAccountSessions(tx, owner, owner.userId))).ok, false);
  } finally { process.env.INTERNAL_SESSION_MODE = 'registry'; }
  assert.ok(await resolveInternalSession(db, owner.token));
  assert.deepEqual(await withSerializableTransaction(db, (tx) => revokeAccountSessions(tx, owner, owner.userId)), { ok: true, sessionRevoked: true });
  assert.equal(await resolveInternalSession(db, owner.token), null);
});

test('concurrent password changes cannot reuse the revoked authorizing session', { skip: !run }, async () => {
  const owner = await actor();
  const results = await Promise.allSettled([1, 2].map(() => withSerializableTransaction(db, (tx) =>
    changeAccountPassword(tx, owner, { currentPassword: password, password: nextPassword }))));
  assert.equal(results.filter((item) => item.status === 'fulfilled' && item.value.ok).length, 1);
  assert.equal(await db.auditLog.count({ where: { actorId: owner.userId, event: 'user_password_changed' } }), 1);
  assert.equal(await resolveInternalSession(db, owner.token), null);
});
