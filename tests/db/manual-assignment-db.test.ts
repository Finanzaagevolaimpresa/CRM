import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { PrismaClient, type RoleCode } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from './ai-orchestrator-db-test-guard';
import { createInternalSession, revokeAllInternalSessions } from '../../src/lib/internal-session-registry';
import { createRegistrySessionToken, digestRegistrySessionToken } from '../../src/lib/session';
import { authorizeManualAssignment, changedAssignee, withAssignmentGuard } from '../../src/lib/manual-assignment-guard';
import { canViewLead } from '../../src/lib/access-control';
import { leadVisibilityWhere } from '../../src/lib/core-query-policy';

const run = process.env.RUN_DB_TESTS === '1';
const db = new PrismaClient();
const users: string[] = [];
const leads: string[] = [];
const originalMode = process.env.INTERNAL_SESSION_MODE;
let admitted = false;
before(async () => {
  if (!run) return;
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  admitted = true;
  process.env.INTERNAL_SESSION_MODE = 'registry';
});
after(async () => {
  if (admitted) {
    await db.lead.deleteMany({ where: { id: { in: leads } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
    if (originalMode === undefined) delete process.env.INTERNAL_SESSION_MODE;
    else process.env.INTERNAL_SESSION_MODE = originalMode;
  }
  await db.$disconnect();
});
async function actor(role: RoleCode = 'commerciale') {
  const user = await db.user.create({ data: {
    name: 'Synthetic assignment operator', email: 'assignment-' + randomUUID() + '@example.test',
    passwordHash: 'synthetic-not-a-real-hash', role,
  } });
  users.push(user.id);
  const token = createRegistrySessionToken();
  const tokenDigest = await digestRegistrySessionToken(token.bytes);
  const session = await db.$transaction(tx => createInternalSession(tx, {
    userId: user.id, tokenDigest,
  }));
  return { userId: user.id, sessionId: session.id, role };
}
async function lead() {
  const item = await db.lead.create({ data: { firstName: 'Synthetic', lastName: 'Assignment', source: 'manuale' } });
  leads.push(item.id);
  return item;
}
test('admin assignment and unassignment are atomic; ownership immediately controls detail and database lists', { skip: !run }, async () => {
  const admin = await actor('admin'), owner = await actor(), other = await actor();
  const item = await lead();
  assert.equal(canViewLead(owner, item), false);
  assert.equal(await db.lead.count({ where: { id: item.id, AND: [leadVisibilityWhere(owner)] } }), 0);
  await withAssignmentGuard(db, admin, true, [{ userId: owner.userId }], async tx => {
    await tx.lead.update({ where: { id: item.id, assignedToId: null }, data: { assignedToId: owner.userId } });
    await tx.auditLog.create({ data: { actorId: admin.userId, entityType: 'Lead', entityId: item.id, event: 'synthetic_assignment' } });
  });
  assert.equal(await db.lead.count({ where: { id: item.id, AND: [leadVisibilityWhere(owner)] } }), 1);
  await withAssignmentGuard(db, admin, true, [{ userId: other.userId }], tx =>
    tx.lead.update({ where: { id: item.id, assignedToId: owner.userId }, data: { assignedToId: other.userId } }));
  assert.equal(canViewLead(owner, await db.lead.findUniqueOrThrow({ where: { id: item.id } })), false);
  assert.equal(await db.lead.count({ where: { id: item.id, AND: [leadVisibilityWhere(owner)] } }), 0);
  await withAssignmentGuard(db, admin, true, [], tx =>
    tx.lead.update({ where: { id: item.id }, data: { assignedToId: null } }));
  const direction = await actor('direzione');
  assert.equal(await db.lead.count({ where: { id: item.id, AND: [leadVisibilityWhere(direction)] } }), 0);
  assert.equal(canViewLead(admin, await db.lead.findUniqueOrThrow({ where: { id: item.id } })), true);
});
test('self assignment, direction, permission overrides, revoked sessions and stale admin roles cannot authorize ownership', { skip: !run }, async () => {
  const admin = await actor('admin'), operator = await actor(), direction = await actor('direzione');
  const item = await lead();
  for (const permission of ['service.assign', 'technical.assign', 'lead.inbox.assign']) {
    await db.userPermissionOverride.create({ data: { userId: operator.userId, permission, allowed: true } });
  }
  const assign = (current: { userId: string; sessionId?: string }) => withAssignmentGuard(db, current, true, [{ userId: operator.userId }], tx =>
    tx.lead.update({ where: { id: item.id }, data: { assignedToId: operator.userId } }));
  for (const current of [operator, direction, { userId: admin.userId }, { userId: admin.userId, sessionId: operator.sessionId }]) {
    await assert.rejects(assign(current), /amministratore/);
  }
  await db.user.update({ where: { id: admin.userId }, data: { role: 'direzione' } });
  await assert.rejects(assign(admin), /amministratore/);
  await db.user.update({ where: { id: admin.userId }, data: { role: 'admin' } });
  await db.$transaction(tx => revokeAllInternalSessions(tx, admin.userId, 'INTERNAL_GLOBAL', admin.userId));
  await assert.rejects(assign(admin), /amministratore/);
  assert.equal((await db.lead.findUniqueOrThrow({ where: { id: item.id } })).assignedToId, null);
});
test('inactive, removed and wrong-role targets fail before any write; a write/audit fault rolls back', { skip: !run }, async () => {
  const admin = await actor('admin'), target = await actor('consulente');
  const item = await lead();
  const assign = () => withAssignmentGuard(db, admin, true, [{ userId: target.userId }], tx =>
    tx.lead.update({ where: { id: item.id }, data: { assignedToId: target.userId } }));
  await db.user.update({ where: { id: target.userId }, data: { active: false } });
  await assert.rejects(assign(), /amministratore/);
  await db.user.update({ where: { id: target.userId }, data: { active: true, deletedAt: new Date() } });
  await assert.rejects(assign(), /amministratore/);
  await db.user.update({ where: { id: target.userId }, data: { deletedAt: null } });
  await assert.rejects(db.$transaction(tx => authorizeManualAssignment(tx, admin, [{ userId: target.userId, roles: ['commerciale'] }])), /amministratore/);
  await assert.rejects(withAssignmentGuard(db, admin, true, [{ userId: target.userId }], async tx => {
    await tx.lead.update({ where: { id: item.id }, data: { assignedToId: target.userId } });
    await tx.auditLog.create({ data: { actorId: admin.userId, event: 'synthetic_assignment_fault', entityType: 'Lead', entityId: item.id } });
    throw new Error('SYNTHETIC_FAULT');
  }), /SYNTHETIC_FAULT/);
  assert.equal((await db.lead.findUniqueOrThrow({ where: { id: item.id } })).assignedToId, null);
  assert.equal(await db.auditLog.count({ where: { entityId: item.id, event: 'synthetic_assignment_fault' } }), 0);
});
test('an omitted or unchanged stale form does not restore an earlier assignee', { skip: !run }, async () => {
  const first = await actor(), second = await actor();
  const item = await lead();
  await db.lead.update({ where: { id: item.id }, data: { assignedToId: second.userId } });
  for (const submitted of [false, true]) {
    const patch = changedAssignee(first.userId, submitted, first.userId);
    assert.equal(patch, undefined);
    await db.lead.update({ where: { id: item.id }, data: { assignedToId: patch, priority: 'alta' } });
    assert.equal((await db.lead.findUniqueOrThrow({ where: { id: item.id } })).assignedToId, second.userId);
  }
  assert.equal(changedAssignee(second.userId, true, null), null);
  assert.equal(changedAssignee(second.userId, true, first.userId), first.userId);
});
