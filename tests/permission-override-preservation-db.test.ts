import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from './db/ai-orchestrator-db-test-guard';
import { contextFixture, contextPerson } from './admin-email/fixture';
import { executeAdminUserCommand } from '../src/lib/admin-user-commands';
import { adminUserVersion } from '../src/lib/admin-user-version';
import { readPermissionDenialRestoration } from '../src/lib/admin-permission-restoration';
import { createPrivilegedStepUpToken } from '../src/lib/privileged-step-up-token';
import { evaluatePermission } from '../src/lib/permission-evaluator';
const enabled = process.env.CI === 'true' && process.env.RUN_DB_TESTS === '1' && process.env.PERMISSION_PRESERVATION_DB_TESTS === '1';
const options = { skip: !enabled }, db = new PrismaClient();
before(async () => { if (enabled) await assertAiOrchestratorEphemeralDatabaseIdentity(db); });
after(async () => db.$disconnect());
const snapshot = (id: string) => db.user.findUniqueOrThrow({ where: { id }, include: { permissionOverrides: true } });
async function fixture(lost = false) {
  const f = await contextFixture(db), target = await contextPerson(db, 'consulente');
  const old = [{ permission: 'video.manage', allowed: false }, { permission: 'user.write', allowed: false },
    { permission: 'communications.internal.read', allowed: false }];
  const saved = [{ permission: 'communications.internal.read', allowed: true }];
  await db.userPermissionOverride.createMany({ data: (lost ? saved : old).map(row => ({ userId: target.user.id, ...row })) });
  const source = await db.auditLog.create({ data: { actorId: f.owner.user.id, entityType: 'User', entityId: target.user.id,
    event: 'user_permission_overrides_updated', before: old, after: lost ? saved : old } });
  const current = await snapshot(target.user.id);
  const identity = { operation: lost ? 'RESTORE_PERMISSION_DENIALS' : 'OVERRIDES', commandId: randomUUID(),
    userId: target.user.id, expectedVersion: adminUserVersion(current) };
  const proposal = lost ? (await readPermissionDenialRestoration(db, current))! : null;
  const values = lost ? { sourceAuditId: source.id, sourceHash: proposal!.sourceHash, confirmed: true }
    : { overrides: [{ permission: 'communications.internal.read', value: 'allow' }] };
  return { ...f, target, source, current, identity, values };
}
test('native Admin save retains disabled denials, persists allowed selection and audits full before/after once', options, async () => {
  const f = await fixture();
  const first = await executeAdminUserCommand(db, f.owner.actor, f.identity, f.values, f.credentials);
  assert.deepEqual(await executeAdminUserCommand(db, f.owner.actor, f.identity, f.values, f.credentials), first);
  const user = await snapshot(f.target.user.id);
  assert.equal(user.permissionOverrides.length, 3);
  for (const permission of ['video.manage', 'user.write']) assert.equal(user.permissionOverrides.find(row => row.permission === permission)?.allowed, false);
  assert.equal(user.permissionOverrides.find(row => row.permission === 'communications.internal.read')?.allowed, true);
  assert.equal(await db.adminRecordRevision.count({ where: { commandId: f.identity.commandId } }), 1);
});
test('historical restoration is explicit, preserves current choices and original source, and replays without duplication', options, async () => {
  const f = await fixture(true), sourceBefore = JSON.stringify(f.source);
  await executeAdminUserCommand(db, f.owner.actor, f.identity, f.values, f.credentials);
  await executeAdminUserCommand(db, f.owner.actor, f.identity, f.values, f.credentials);
  const user = await snapshot(f.target.user.id);
  assert.equal(user.permissionOverrides.length, 3);
  assert.equal(user.permissionOverrides.find(row => row.permission === 'communications.internal.read')?.allowed, true);
  assert.equal(await readPermissionDenialRestoration(db, user), null);
  assert.equal(JSON.stringify(await db.auditLog.findUniqueOrThrow({ where: { id: f.source.id } })), sourceBefore);
  const audit = await db.auditLog.findMany({ where: { entityId: user.id, event: 'user_permission_denials_restored' } });
  assert.equal(audit.length, 1); assert.equal(audit[0].actorId, f.owner.user.id);
  assert.equal(await db.adminRecordRevision.count({ where: { commandId: f.identity.commandId } }), 1);
});
test('restoration rejects forged source, missing confirmation, stale version and forged snapshot without writes', options, async () => {
  const f = await fixture(true), initial = adminUserVersion(await snapshot(f.target.user.id));
  for (const values of [{ ...f.values, sourceAuditId: 'another-user-audit' }, { ...f.values, confirmed: false },
    { ...f.values, sourceHash: '0'.repeat(64) }, { ...f.values, denials: [{ permission: 'video.manage', allowed: true }] }]) {
    await assert.rejects(executeAdminUserCommand(db, f.owner.actor, { ...f.identity, commandId: randomUUID() }, values, f.credentials));
  }
  await assert.rejects(executeAdminUserCommand(db, f.owner.actor, { ...f.identity, expectedVersion: '0'.repeat(64) }, f.values, f.credentials));
  assert.equal(adminUserVersion(await snapshot(f.target.user.id)), initial);
});
test('restoration rejects non-admin and expired step-up, leaving every override and audit unchanged', options, async () => {
  const f = await fixture(true), initial = adminUserVersion(await snapshot(f.target.user.id));
  await assert.rejects(executeAdminUserCommand(db, f.target.actor, f.identity, f.values, f.credentials));
  const expired = createPrivilegedStepUpToken({ key: f.key, userId: f.owner.user.id, sessionToken: f.owner.cookie,
    nowSeconds: Math.floor(Date.now() / 1000) - 3600 });
  await assert.rejects(executeAdminUserCommand(db, f.owner.actor, f.identity, f.values, { ...f.credentials, stepUpToken: expired }));
  assert.equal(adminUserVersion(await snapshot(f.target.user.id)), initial);
  assert.equal(await db.auditLog.count({ where: { entityId: f.target.user.id, event: 'user_permission_denials_restored' } }), 0);
});
test('forged readonly allows remain denied and explicit reset keeps its separate semantics', options, async () => {
  const f = await fixture(), initial = adminUserVersion(f.current);
  await assert.rejects(executeAdminUserCommand(db, f.owner.actor, f.identity,
    { overrides: [{ permission: 'video.manage', value: 'allow' }] }, f.credentials));
  assert.equal(adminUserVersion(await snapshot(f.target.user.id)), initial);
  await executeAdminUserCommand(db, f.owner.actor, { ...f.identity, operation: 'RESET_OVERRIDES' }, {}, f.credentials);
  assert.equal((await snapshot(f.target.user.id)).permissionOverrides.length, 0);
  assert.equal(await readPermissionDenialRestoration(db, await snapshot(f.target.user.id)), null);
});

test('adding a technical function preserves newly disabled stored values with full audit and idempotent replay', options, async () => {
  const f = await contextFixture(db), target = await contextPerson(db, 'commerciale');
  const prior = [{ permission: 'legal.read', allowed: false }, { permission: 'user.write', allowed: true }];
  await db.userPermissionOverride.createMany({ data: prior.map(row => ({ userId: target.user.id, ...row })) });
  const current = await snapshot(target.user.id), identity = { operation: 'OVERRIDES', commandId: randomUUID(),
    userId: target.user.id, expectedVersion: adminUserVersion(current) };
  await assert.rejects(executeAdminUserCommand(db, f.owner.actor, identity,
    { overrides: [{ permission: 'technical.write', value: 'allow' }, { permission: 'legal.read', value: 'allow' }] }, f.credentials));
  assert.equal(adminUserVersion(await snapshot(target.user.id)), identity.expectedVersion);
  const values = { overrides: [{ permission: 'technical.write', value: 'allow' }] };
  const first = await executeAdminUserCommand(db, f.owner.actor, identity, values, f.credentials);
  assert.deepEqual(await executeAdminUserCommand(db, f.owner.actor, identity, values, f.credentials), first);
  const reopened = await snapshot(target.user.id);
  assert.equal(reopened.permissionOverrides.length, 3);
  for (const row of prior) {
    assert.equal(reopened.permissionOverrides.find(item => item.permission === row.permission)?.allowed, row.allowed);
    assert.equal(evaluatePermission(reopened, row.permission as 'legal.read' | 'user.write').allowed, false);
  }
  const audits = await db.auditLog.findMany({ where: { entityId: target.user.id, event: 'user_permission_overrides_updated' } });
  assert.equal(audits.length, 1);
  const order = (rows: typeof prior) => [...rows].sort((a, b) => a.permission.localeCompare(b.permission));
  assert.deepEqual(order(audits[0].before as typeof prior), order(prior));
  assert.deepEqual(order(audits[0].after as typeof prior), order([...prior, { permission: 'technical.write', allowed: true }]));
  assert.equal(await db.adminRecordRevision.count({ where: { commandId: identity.commandId } }), 1);
});
