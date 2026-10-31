import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { syntheticAuthority, syntheticPerson, syntheticSession } from './selective-sharing/fixtures';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from './db/ai-orchestrator-db-test-guard';
import { createPrivilegedStepUpToken } from '../src/lib/privileged-step-up-token';
import { readAdminRoleProfile, saveAdminRoleProfile, reconcileAdminRoleProfile } from '../src/lib/admin-role-profiles';
import { roleProfileModel, roleProfileDigest, type ProfileRole } from '../src/lib/admin-role-profile-contract';
import { executeAdminUserCommand, reconcileAdminUserCommand } from '../src/lib/admin-user-commands';
import { adminUserVersion } from '../src/lib/admin-user-command-contract';
import { roleHasPermission, type Permission } from '../src/lib/permissions';
import { hasPermission } from '../src/lib/permission-evaluator';

const enabled = process.env.RUN_DB_TESTS === '1' && process.env.ADMIN_ROLE_PROFILE_DB_TESTS === '1';
const options = { skip: !enabled }, db = new PrismaClient();
const key = { version: Number(process.env.PRIVILEGED_STEP_UP_KEY_VERSION), secret: process.env.PRIVILEGED_STEP_UP_SECRET! };
type Person = Awaited<ReturnType<typeof syntheticPerson>>;
let admin: Person;
before(async () => {
  if (!enabled) return; await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  const existing = await db.selectiveAccessAuthority.findFirst();
  if (existing) { const user = await db.user.findUniqueOrThrow({ where: { id: existing.userId } }); admin = { user, ...await syntheticSession(db, user) }; }
  else admin = await syntheticAuthority(db);
});
after(async () => db.$disconnect());
function proof(person = admin, secondsAgo = 0) {
  return { key, sessionToken: person.token, stepUpToken: createPrivilegedStepUpToken({
    key, userId: person.user.id, role: person.user.role, sessionToken: person.token, nowSeconds: Math.floor(Date.now() / 1000) - secondsAgo,
  }) };
}
async function change(role: ProfileRole = 'commerciale', permission: Permission = 'lead.write') {
  const value = await readAdminRoleProfile(db, admin.session, role);
  const allowed = !(value.current.overrides.find(item => item.permission === permission)?.allowed ?? roleHasPermission(role, permission));
  return { commandId: randomUUID(), role, expectedVersion: value.version, reason: 'Profilo sintetico isolato',
    overrides: [...value.current.overrides.filter(item => item.permission !== permission), { permission, allowed }], confirmed: true as const };
}
async function newAccount(role: ProfileRole = 'commerciale') {
  const preset = await readAdminRoleProfile(db, admin.session, role), id = randomUUID();
  return { identity: { commandId: randomUUID(), operation: 'CREATE' as const, userId: id, expectedVersion: adminUserVersion(null) },
    values: { name: 'Account profilo sintetico', email: id + '@example.test', password: 'synthetic-profile-password-00000', role,
      active: true, roleProfileVersion: preset.version } };
}
test('role profile is versioned without changing existing users, grants or compiled roles', options, async () => {
  const target = await syntheticPerson(db, 'Profilo già esistente', 'commerciale');
  const prior = await db.user.findUniqueOrThrow({ where: { id: target.user.id }, include: { permissionOverrides: true } });
  const input = await change(), priorProfile = await readAdminRoleProfile(db, admin.session, input.role);
  await saveAdminRoleProfile(db, admin.session, input, proof());
  const reopened = await readAdminRoleProfile(db, admin.session, input.role);
  assert.equal(reopened.current.revision, priorProfile.current.revision + 1);
  assert.notEqual(reopened.version, priorProfile.version);
  assert.deepEqual(await db.user.findUniqueOrThrow({ where: { id: target.user.id }, include: { permissionOverrides: true } }), prior);
  assert.equal(roleHasPermission('commerciale', 'lead.write'), true);
  assert.equal(reopened.history[0].commandId, input.commandId);
});
test('new account receives the exact chosen profile once and native authority still evaluates it', options, async () => {
  const prepared = await newAccount();
  await executeAdminUserCommand(db, admin.session, prepared.identity, prepared.values, proof());
  await executeAdminUserCommand(db, admin.session, prepared.identity, prepared.values, proof());
  const target = await db.user.findUniqueOrThrow({ where: { id: prepared.identity.userId }, include: { permissionOverrides: true } });
  const preset = await readAdminRoleProfile(db, admin.session, 'commerciale');
  assert.deepEqual(target.permissionOverrides.map(({ permission, allowed }) => ({ permission, allowed })).sort((a, b) => a.permission.localeCompare(b.permission)), preset.current.overrides);
  assert.equal(hasPermission(target, 'lead.write'), false);
  assert.equal(await db.adminRecordRevision.count({ where: { commandId: prepared.identity.commandId } }), 1);
  assert.equal(await db.auditLog.count({ where: { entityId: target.id, event: 'admin_role_profile_applied' } }), 1);
});
test('changed profile rejects an old creation choice atomically until a fresh explicit version is supplied', options, async () => {
  const prepared = await newAccount();
  await saveAdminRoleProfile(db, admin.session, await change(), proof());
  await assert.rejects(executeAdminUserCommand(db, admin.session, prepared.identity, prepared.values, proof()), /STALE/);
  assert.equal(await db.user.count({ where: { id: prepared.identity.userId } }), 0);
  assert.equal(await db.adminRecordRevision.count({ where: { commandId: prepared.identity.commandId } }), 0);
  prepared.values.roleProfileVersion = (await readAdminRoleProfile(db, admin.session, 'commerciale')).version;
  await executeAdminUserCommand(db, admin.session, prepared.identity, prepared.values, proof());
  assert.equal(await db.user.count({ where: { id: prepared.identity.userId } }), 1);
});
test('existing account applies only the confirmed profile version and preserves identity and personal assignments', options, async () => {
  await saveAdminRoleProfile(db, admin.session, await change(), proof());
  const target = await syntheticPerson(db, 'Applicazione esplicita', 'commerciale');
  await db.userPermissionOverride.create({ data: { userId: target.user.id, permission: 'company.write', allowed: true } });
  const before = await db.user.findUniqueOrThrow({ where: { id: target.user.id }, include: { permissionOverrides: true } });
  const preset = await readAdminRoleProfile(db, admin.session, target.user.role);
  const identity = { operation: 'APPLY_ROLE_PROFILE', commandId: randomUUID(), userId: target.user.id, expectedVersion: adminUserVersion(before) };
  const values = { roleProfileVersion: preset.version, confirmed: true };
  await assert.rejects(executeAdminUserCommand(db, admin.session, identity, { ...values, confirmed: false }, proof()));
  await executeAdminUserCommand(db, admin.session, identity, values, proof());
  await executeAdminUserCommand(db, admin.session, identity, values, proof());
  const after = await db.user.findUniqueOrThrow({ where: { id: target.user.id }, include: { permissionOverrides: true } });
  assert.equal(after.id, before.id); assert.equal(after.role, before.role);
  assert.equal(after.name, before.name); assert.equal(after.email, before.email);
  assert.deepEqual(after.permissionOverrides.map(({ permission, allowed }) => ({ permission, allowed })).sort((a, b) => a.permission.localeCompare(b.permission)), preset.current.overrides);
  assert.equal(await db.adminRecordRevision.count({ where: { commandId: identity.commandId } }), 1);
  assert.equal((await reconcileAdminUserCommand(db, admin.session, identity))?.userId, target.user.id);
});
test('protected, financial and external execution permissions cannot be introduced through a role profile', options, async () => {
  const input = await change(), before = await readAdminRoleProfile(db, admin.session, input.role);
  for (const permission of ['payment.write', 'ai.execution.consume', 'ai.execution.approve', 'lead.duplicate.resolve', 'lead.inbox.assign', 'video.manage']) {
    await assert.rejects(saveAdminRoleProfile(db, admin.session, { ...input, commandId: randomUUID(), overrides: [{ permission, allowed: true }] }, proof()));
  }
  await assert.rejects(saveAdminRoleProfile(db, admin.session, { ...input, role: 'admin' }, proof()));
  await assert.rejects(saveAdminRoleProfile(db, admin.session, { ...input, overrides: [{ permission: 'unknown.permission', allowed: true }] }, proof()));
  assert.equal((await readAdminRoleProfile(db, admin.session, input.role)).version, before.version);
});
test('profile confirmation expiry retains the same choice and renewal produces one recorded revision', options, async () => {
  const input = await change(), before = await readAdminRoleProfile(db, admin.session, input.role);
  await assert.rejects(saveAdminRoleProfile(db, admin.session, input, proof(admin, 1800)));
  assert.equal((await readAdminRoleProfile(db, admin.session, input.role)).version, before.version);
  await saveAdminRoleProfile(db, admin.session, input, proof(admin, 1790));
  await saveAdminRoleProfile(db, admin.session, input, proof());
  assert.equal(await db.adminRecordRevision.count({ where: { commandId: input.commandId } }), 1);
});
test('profile receipt recovery and terminal closure never create a duplicate or admit a late command', options, async () => {
  const input = await change();
  assert.equal((await reconcileAdminRoleProfile(db, admin.session, { commandId: input.commandId, role: input.role, close: false })).status, 'UNKNOWN');
  await saveAdminRoleProfile(db, admin.session, input, proof());
  assert.equal((await reconcileAdminRoleProfile(db, admin.session, { commandId: input.commandId, role: input.role, close: true })).status, 'RECORDED');
  await assert.rejects(saveAdminRoleProfile(db, admin.session, { ...input, reason: 'Altro payload sintetico' }, proof()), /STALE/);
  const late = await change();
  assert.equal((await reconcileAdminRoleProfile(db, admin.session, { commandId: late.commandId, role: late.role, close: true })).status, 'CLOSED');
  await assert.rejects(saveAdminRoleProfile(db, admin.session, late, proof()), /CLOSED/);
  assert.equal(await db.adminRecordRevision.count({ where: { commandId: late.commandId, operation: 'UPDATE' } }), 0);
});
test('restoring old role choices creates a new attributed revision and retains every previous revision', options, async () => {
  const input = await change(), before = await readAdminRoleProfile(db, admin.session, input.role);
  await saveAdminRoleProfile(db, admin.session, input, proof());
  const current = await readAdminRoleProfile(db, admin.session, input.role), restoreId = randomUUID();
  await saveAdminRoleProfile(db, admin.session, { ...input, commandId: restoreId, expectedVersion: current.version, overrides: before.current.overrides }, proof());
  const restored = await readAdminRoleProfile(db, admin.session, input.role);
  assert.equal(restored.current.revision, current.current.revision + 1);
  assert.deepEqual(restored.current.overrides, before.current.overrides);
  assert.equal(await db.adminRecordRevision.count({ where: { commandId: { in: [input.commandId, restoreId] } } }), 2);
});
test('stale concurrent profile choices cannot silently overwrite an accepted revision', options, async () => {
  const first = await change(), second = { ...first, commandId: randomUUID() };
  const results = await Promise.allSettled([saveAdminRoleProfile(db, admin.session, first, proof()), saveAdminRoleProfile(db, admin.session, second, proof())]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(await db.adminRecordRevision.count({ where: { commandId: { in: [first.commandId, second.commandId] } } }), 1);
});
test('revoked sessions, non Admin actors and receipt substitution fail without exposing or changing a profile', options, async () => {
  const input = await change(), other = await syntheticPerson(db, 'Altro Admin profilo');
  await saveAdminRoleProfile(db, admin.session, input, proof());
  await assert.rejects(reconcileAdminRoleProfile(db, other.session, { commandId: input.commandId, role: input.role, close: false }), /DENIED/);
  const reader = await syntheticPerson(db, 'Commerciale profilo', 'commerciale');
  await assert.rejects(readAdminRoleProfile(db, reader.session, input.role), /DENIED/);
  await db.internalSession.update({ where: { id: other.session.sessionId! }, data: { revokedAt: new Date(), revokedReason: 'INTERNAL_SINGLE', revokedByUserId: admin.user.id } });
  await assert.rejects(saveAdminRoleProfile(db, other.session, await change(), proof(other)));
});
test('an audit collision rolls back the role revision rather than returning an apparently successful receipt', options, async () => {
  const input = await change(), before = await readAdminRoleProfile(db, admin.session, input.role);
  await db.auditLog.create({ data: { id: 'admin-record:' + input.commandId, actorId: admin.user.id, entityType: roleProfileModel,
    entityId: input.role, event: 'synthetic_existing_audit_collision' } });
  await assert.rejects(saveAdminRoleProfile(db, admin.session, input, proof()));
  assert.equal(await db.adminRecordRevision.count({ where: { commandId: input.commandId } }), 0);
  assert.equal((await readAdminRoleProfile(db, admin.session, input.role)).version, before.version);
});
test('a self-consistent but disconnected profile revision is rejected with no fallback to compiled grants', options, async () => {
  const role = 'revisore', before = (await readAdminRoleProfile(db, admin.session, role)).current;
  const after = { ...before, revision: before.revision + 2 }, commandId = randomUUID();
  const beforeHash = roleProfileDigest(before), afterHash = roleProfileDigest(after);
  await db.$transaction(async tx => {
    await tx.adminRecordRevision.create({ data: { commandId, actorId: admin.user.id, sessionId: admin.session.sessionId!,
      model: roleProfileModel, recordId: role, operation: 'UPDATE', requestHash: roleProfileDigest({ commandId }), beforeHash, afterHash,
      before: before as Prisma.InputJsonValue, after: after as Prisma.InputJsonValue, reason: 'Catena sintetica disconnessa' } });
    await tx.auditLog.create({ data: { id: 'admin-record:' + commandId, actorId: admin.user.id, entityType: roleProfileModel,
      entityId: role, event: 'admin_record_changed', after: { commandId, action: 'UPDATE', beforeHash, afterHash } } });
  });
  await assert.rejects(readAdminRoleProfile(db, admin.session, role), /INTEGRITY/);
});
