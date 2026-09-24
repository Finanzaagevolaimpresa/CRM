import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { before, after } from 'node:test';
import { PrismaClient, type RoleCode } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from './ai-orchestrator-db-test-guard';
import { createInternalSession, resolveInternalSession, revokeAllInternalSessions } from '../../src/lib/internal-session-registry';
import { createRegistrySessionToken, digestRegistrySessionToken } from '../../src/lib/session';
import { withSerializableTransaction } from '../../src/lib/serializable';
import { removeInternalUserWithAudit, deactivateInternalUserWithAudit, activateInternalUserWithAudit, updateInternalUserRoleWithAudit } from '../../src/lib/user-privilege-service';
import { loadAssignmentExceptions, exceptionKinds } from '../../src/lib/assignment-exceptions';
import { withAssignmentGuard } from '../../src/lib/manual-assignment-guard';

const run = process.env.RUN_DB_TESTS === '1';
const db = new PrismaClient();
const users: string[] = [], leads: string[] = [], clients: string[] = [], projects: string[] = [], tasks: string[] = [], services: string[] = [], practices: string[] = [];
const originalMode = process.env.INTERNAL_SESSION_MODE;
let admitted = false;
before(async () => {
  if (!run) return;
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  admitted = true; process.env.INTERNAL_SESSION_MODE = 'registry';
});
after(async () => {
  if (admitted) {
    await db.technicalPractice.deleteMany({ where: { id: { in: practices } } });
    await db.clientService.deleteMany({ where: { id: { in: services } } });
    await db.task.deleteMany({ where: { id: { in: tasks } } });
    await db.project.deleteMany({ where: { id: { in: projects } } });
    await db.client.deleteMany({ where: { id: { in: clients } } });
    await db.lead.deleteMany({ where: { id: { in: leads } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
    if (originalMode === undefined) delete process.env.INTERNAL_SESSION_MODE; else process.env.INTERNAL_SESSION_MODE = originalMode;
  }
  await db.$disconnect();
});
async function actor(role: RoleCode = 'commerciale') {
  const user = await db.user.create({ data: { name: 'Synthetic continuity', email: `continuity-${randomUUID()}@example.test`, role, passwordHash: 'synthetic-not-a-login-hash' } });
  users.push(user.id);
  const token = createRegistrySessionToken();
  const tokenDigest = await digestRegistrySessionToken(token.bytes);
  const session = await db.$transaction(tx => createInternalSession(tx, { userId: user.id, tokenDigest }));
  return { userId: user.id, sessionId: session.id, token: token.token };
}
async function ownedLead(userId: string) {
  const lead = await db.lead.create({ data: { firstName: 'Continuity', lastName: 'Synthetic', assignedToId: userId } });
  leads.push(lead.id); return lead;
}
const tx = <T>(work: Parameters<typeof withSerializableTransaction<T>>[1]) => withSerializableTransaction(db, work);

test('logical removal preserves every assignment and history, revokes sessions, and exposes all six exception queues only to admin', { skip: !run }, async () => {
  const admin = await actor('admin'), owner = await actor(), other = await actor();
  const lead = await ownedLead(owner.userId);
  const client = await db.client.create({ data: { type: 'societa', displayName: 'Continuity client', salesOwnerId: owner.userId, consultantId: owner.userId } }); clients.push(client.id);
  const project = await db.project.create({ data: { clientId: client.id, title: 'Continuity project', consultantId: owner.userId } }); projects.push(project.id);
  const task = await db.task.create({ data: { title: 'Continuity task', clientId: client.id, assignedToId: owner.userId, createdById: owner.userId } }); tasks.push(task.id);
  const service = await db.clientService.create({ data: { clientId: client.id, serviceCatalogId: 'synthetic-continuity-only', assignedToId: owner.userId } }); services.push(service.id);
  const practice = await db.technicalPractice.create({ data: { clientId: client.id, title: 'Continuity practice', practiceType: 'synthetic', targetEntity: 'synthetic', commercialOwnerId: owner.userId, technicalOwnerId: owner.userId, createdById: owner.userId } }); practices.push(practice.id);
  const refs = { leads: lead.id, clients: client.id, projects: project.id, tasks: task.id, services: service.id, practices: practice.id };
  await db.auditLog.create({ data: { actorId: owner.userId, event: 'synthetic_prior_work', entityType: 'Lead', entityId: lead.id } });
  const result = await tx(t => removeInternalUserWithAudit(t, admin, owner.userId, true));
  assert.equal(result.ok, true);
  const removed = await db.user.findUniqueOrThrow({ where: { id: owner.userId } });
  assert.equal(removed.active, false); assert.ok(removed.deletedAt);
  assert.equal(await resolveInternalSession(db, owner.token), null);
  assert.equal(await db.internalSession.count({ where: { userId: owner.userId, revokedAt: null } }), 0);
  assert.deepEqual(await db.lead.findUnique({ where: { id: lead.id } }), lead);
  assert.deepEqual(await db.client.findUnique({ where: { id: client.id } }), client);
  assert.deepEqual(await db.project.findUnique({ where: { id: project.id } }), project);
  assert.deepEqual(await db.task.findUnique({ where: { id: task.id } }), task);
  assert.deepEqual(await db.clientService.findUnique({ where: { id: service.id } }), service);
  assert.deepEqual(await db.technicalPractice.findUnique({ where: { id: practice.id } }), practice);
  assert.equal(await db.auditLog.count({ where: { actorId: owner.userId, event: 'synthetic_prior_work' } }), 1);
  for (const kind of exceptionKinds) {
    const queue = await tx(t => loadAssignmentExceptions(t, admin, kind));
    assert.ok(queue.rows.some(row => row.id === refs[kind] && row.ownerIds.includes(owner.userId)));
    await assert.rejects(tx(t => loadAssignmentExceptions(t, other, kind)));
  }
  assert.equal((await tx(t => activateInternalUserWithAudit(t, admin, owner.userId))).ok, false);
  assert.equal((await tx(t => removeInternalUserWithAudit(t, admin, owner.userId, true))).ok, false);
  assert.equal(await db.auditLog.count({ where: { entityId: owner.userId, event: 'user_removed' } }), 1);
});

test('removal rejects missing admission, forged or revoked sessions, non-admin overrides and self removal', { skip: !run }, async () => {
  const admin = await actor('admin'), operator = await actor(), target = await actor();
  await db.userPermissionOverride.create({ data: { userId: operator.userId, permission: 'user.write', allowed: true } });
  for (const invalid of [operator, { userId: admin.userId }, { userId: admin.userId, sessionId: operator.sessionId }]) {
    assert.equal((await tx(t => removeInternalUserWithAudit(t, invalid, target.userId, true))).ok, false);
  }
  assert.equal((await tx(t => removeInternalUserWithAudit(t, admin, target.userId))).ok, false);
  assert.equal((await tx(t => removeInternalUserWithAudit(t, admin, admin.userId, true))).ok, false);
  await tx(t => revokeAllInternalSessions(t, admin.userId, 'INTERNAL_GLOBAL', admin.userId));
  assert.equal((await tx(t => removeInternalUserWithAudit(t, admin, target.userId, true))).ok, false);
  assert.equal((await tx(t => deactivateInternalUserWithAudit(t, admin, target.userId))).ok, false);
  assert.equal((await tx(t => updateInternalUserRoleWithAudit(t, admin, target.userId, 'admin'))).ok, false);
  assert.ok(await resolveInternalSession(db, target.token));
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: target.userId } })).deletedAt, null);
});

test('suspension keeps assignments in the queue; explicit reassignment and reactivation reconcile it without reviving sessions', { skip: !run }, async () => {
  const admin = await actor('admin'), owner = await actor(), replacement = await actor();
  const lead = await ownedLead(owner.userId);
  assert.equal((await tx(t => deactivateInternalUserWithAudit(t, admin, owner.userId))).ok, true);
  assert.equal(await resolveInternalSession(db, owner.token), null);
  assert.ok((await tx(t => loadAssignmentExceptions(t, admin, 'leads'))).rows.some(row => row.id === lead.id));
  await assert.rejects(withAssignmentGuard(db, admin, true, [{ userId: owner.userId }], t => t.lead.update({ where: { id: lead.id }, data: { assignedToId: owner.userId } })));
  await withAssignmentGuard(db, admin, true, [{ userId: replacement.userId }], t => t.lead.update({ where: { id: lead.id }, data: { assignedToId: replacement.userId } }));
  assert.equal((await tx(t => loadAssignmentExceptions(t, admin, 'leads'))).rows.some(row => row.id === lead.id), false);
  assert.equal((await tx(t => activateInternalUserWithAudit(t, admin, owner.userId))).ok, true);
  assert.equal(await resolveInternalSession(db, owner.token), null);
});

test('exception cursor covers more than fifty records without duplication and rejects malformed input', { skip: !run }, async () => {
  const admin = await actor('admin'), owner = await actor();
  const ownIds = Array.from({ length: 53 }, () => 'continuity-' + randomUUID());
  leads.push(...ownIds);
  await db.lead.createMany({ data: ownIds.map(id => ({ id, firstName: 'Cursor', lastName: 'Synthetic', assignedToId: owner.userId })) });
  assert.equal((await tx(t => deactivateInternalUserWithAudit(t, admin, owner.userId))).ok, true);
  const seen: string[] = []; let cursor: string | undefined;
  do {
    const page = await tx(t => loadAssignmentExceptions(t, admin, 'leads', cursor));
    assert.ok(page.rows.length <= 50);
    seen.push(...page.rows.map(row => row.id)); cursor = page.next ?? undefined;
  } while (cursor);
  assert.equal(new Set(seen).size, seen.length);
  assert.ok(ownIds.every(id => seen.includes(id)));
  await assert.rejects(tx(t => loadAssignmentExceptions(t, admin, 'leads', '../invalid')));
});

test('concurrent removal of two administrators preserves an active admin and its authority', { skip: !run }, async () => {
  const previous = await db.user.findMany({ where: { role: 'admin', active: true, deletedAt: null }, select: { id: true } });
  await db.user.updateMany({ where: { id: { in: previous.map(user => user.id) } }, data: { active: false } });
  const first = await actor('admin'), second = await actor('admin');
  try {
    const results = await Promise.allSettled([
      tx(t => removeInternalUserWithAudit(t, first, second.userId, true)),
      tx(t => removeInternalUserWithAudit(t, second, first.userId, true)),
    ]);
    assert.ok(results.some(result => result.status === 'rejected' || !result.value.ok));
    assert.ok(await db.user.count({ where: { id: { in: [first.userId, second.userId] }, active: true, deletedAt: null, role: 'admin' } }) >= 1);
  } finally { await db.user.updateMany({ where: { id: { in: previous.map(user => user.id) } }, data: { active: true } }); }
});

test('removal and session revocation roll back together if the audit cannot persist; legacy mode denies removal', { skip: !run }, async () => {
  const admin = await actor('admin'), owner = await actor();
  await db.$executeRawUnsafe(`CREATE FUNCTION r05_removal_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event = 'user_removed' THEN RAISE EXCEPTION 'R05_SYNTHETIC_FAULT'; END IF; RETURN NEW; END $$`);
  await db.$executeRawUnsafe('CREATE TRIGGER r05_removal_fault BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION r05_removal_fault()');
  try {
    await assert.rejects(tx(t => removeInternalUserWithAudit(t, admin, owner.userId, true)));
    const user = await db.user.findUniqueOrThrow({ where: { id: owner.userId } });
    assert.equal(user.active, true); assert.equal(user.deletedAt, null);
    assert.ok(await resolveInternalSession(db, owner.token));
    assert.equal(await db.auditLog.count({ where: { entityId: owner.userId, event: { in: ['user_removed', 'sessions_revoked_global'] } } }), 0);
  } finally {
    await db.$executeRawUnsafe('DROP TRIGGER r05_removal_fault ON "AuditLog"');
    await db.$executeRawUnsafe('DROP FUNCTION r05_removal_fault()');
  }
  process.env.INTERNAL_SESSION_MODE = 'legacy';
  try { assert.equal((await tx(t => removeInternalUserWithAudit(t, admin, owner.userId, true))).ok, false); }
  finally { process.env.INTERNAL_SESSION_MODE = 'registry'; }
});
