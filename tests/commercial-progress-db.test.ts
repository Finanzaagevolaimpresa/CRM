import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { before, after } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { PrismaClient, type RoleCode } from '@prisma/client';
import type { AuthSession } from '../src/lib/auth';
import { readCommercialProgress, CommercialProgressUnavailable } from '../src/lib/commercial-progress';
import { createInternalSession } from '../src/lib/internal-session-registry';
import { createRegistrySessionToken, digestRegistrySessionToken } from '../src/lib/session';
import { SerializableConflictError } from '../src/lib/serializable';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from './db/ai-orchestrator-db-test-guard';

const enabled = process.env.RUN_DB_TESTS === '1', db = new PrismaClient();
const users: string[] = [], clients: string[] = [], projects: string[] = [], services: string[] = [], practices: string[] = [];
const previousMode = process.env.INTERNAL_SESSION_MODE;
let admitted = false;
before(async () => {
  if (!enabled) return;
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  admitted = true; process.env.INTERNAL_SESSION_MODE = 'registry';
});
after(async () => {
  if (admitted) {
    await db.technicalPractice.deleteMany({ where: { id: { in: practices } } });
    await db.clientService.deleteMany({ where: { id: { in: services } } });
    await db.project.deleteMany({ where: { id: { in: projects } } });
    await db.client.deleteMany({ where: { id: { in: clients } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
    if (previousMode === undefined) delete process.env.INTERNAL_SESSION_MODE; else process.env.INTERNAL_SESSION_MODE = previousMode;
  }
  await db.$disconnect();
});
async function actor(role: RoleCode) {
  const user = await db.user.create({ data: { name: 'Synthetic progress', email: `progress-${randomUUID()}@example.test`, role, passwordHash: 'synthetic-no-login' } });
  users.push(user.id);
  const token = createRegistrySessionToken(), tokenDigest = await digestRegistrySessionToken(token.bytes);
  const registry = await db.$transaction(tx => createInternalSession(tx, { userId: user.id, tokenDigest }));
  return { userId: user.id, sessionId: registry.id, expiresAt: Math.floor(registry.expiresAt.getTime() / 1000), role, active: true, permissionOverrides: [] } satisfies AuthSession;
}
async function fixture() {
  const a = await actor('commerciale'), b = await actor('commerciale'), t1 = await actor('consulente'), t2 = await actor('backoffice');
  async function context(sales: AuthSession, tech: AuthSession, name: string) {
    const client = await db.client.create({ data: { type: 'societa', displayName: name, salesOwnerId: sales.userId, consultantId: tech.userId, notes: 'PRIVATE_CLIENT_NOTE' } }); clients.push(client.id);
    const project = await db.project.create({ data: { clientId: client.id, title: 'PRIVATE_PROJECT_TITLE', consultantId: tech.userId, requestedAmount: 876543 } }); projects.push(project.id);
    const service = await db.clientService.create({ data: { clientId: client.id, projectId: project.id, serviceCatalogId: 'synthetic-progress-catalog', contractId: 'PRIVATE_CONTRACT_ID', paymentId: 'PRIVATE_PAYMENT_ID', internalNotes: 'PRIVATE_SERVICE_NOTE' } }); services.push(service.id);
    const practice = await db.technicalPractice.create({ data: { clientId: client.id, projectId: project.id, clientServiceId: service.id, commercialOwnerId: sales.userId, technicalOwnerId: tech.userId, title: 'PRIVATE_PRACTICE_TITLE', practiceType: 'synthetic', targetEntity: 'PRIVATE_ENTITY', createdById: t1.userId, status: 'in_progettazione', dueDate: new Date('2026-11-01T09:00:00Z'), nextClientUpdateAt: new Date('2026-10-30T09:00:00Z'), internalNotes: 'PRIVATE_TECHNICAL_NOTE', clientVisibleStatus: 'FREE_TEXT_NOT_AUTHORIZED' } }); practices.push(practice.id);
    return { client, project, service, practice };
  }
  return { a, b, t1, t2, first: await context(a, t1, 'Synthetic alpha %_'), second: await context(b, t2, 'Synthetic beta') };
}
const options = { skip: !enabled };

test('two sales see real positive progress of their own client only; no financial or free-text payload and no GET writes', options, async () => {
  const f = await fixture();
  const auditScope = { actorId: { in: [f.a.userId, f.b.userId, f.t1.userId, f.t2.userId] } };
  const messageScope = { clientId: { in: [f.first.client.id, f.second.client.id] } };
  const auditBefore = await db.auditLog.count({ where: auditScope }), messagesBefore = await db.approvedCommunication.count({ where: messageScope });
  for (const [actor, own, other] of [[f.a, f.first, f.second], [f.b, f.second, f.first]] as const) {
    const result = await readCommercialProgress(db, actor, {});
    assert.equal(result.items.length, 1); assert.equal(result.items[0].id, own.practice.id);
    assert.equal(result.items[0].statusLabel, 'In lavorazione'); assert.equal(result.items[0].clientName, own.client.displayName);
    assert.equal(result.items[0].dueDate!.toISOString(), '2026-11-01T09:00:00.000Z');
    assert.deepEqual(Object.keys(result.items[0]).sort(), ['id', 'clientId', 'clientName', 'status', 'statusLabel', 'dueDate', 'nextClientUpdateAt', 'updatedAt'].sort());
    const serialized = JSON.stringify(result);
    for (const forbidden of ['PRIVATE_', 'FREE_TEXT_', other.client.id, other.practice.id, own.project.id, own.service.id]) assert.ok(!serialized.includes(forbidden));
    assert.deepEqual((await readCommercialProgress(db, actor, { client: other.client.id })).items, []);
    assert.deepEqual((await readCommercialProgress(db, actor, { q: other.client.displayName })).items, []);
  }
  assert.equal((await readCommercialProgress(db, f.a, { q: '%_' })).items.length, 1);
  assert.equal((await readCommercialProgress(db, f.b, { q: '%_' })).items.length, 0);
  for (const tech of [f.t1, f.t2]) await assert.rejects(readCommercialProgress(db, tech, {}), CommercialProgressUnavailable);
  assert.equal(await db.auditLog.count({ where: auditScope }), auditBefore); assert.equal(await db.approvedCommunication.count({ where: messageScope }), messagesBefore);
});

test('technical reassignment preserves sales progress; sales reference changes immediately remove old access', options, async () => {
  const f = await fixture();
  await db.technicalPractice.update({ where: { id: f.first.practice.id }, data: { technicalOwnerId: f.t2.userId } });
  await db.project.update({ where: { id: f.first.project.id }, data: { consultantId: f.t2.userId } });
  assert.equal((await readCommercialProgress(db, f.a, {})).items[0].id, f.first.practice.id);
  await db.client.update({ where: { id: f.first.client.id }, data: { salesOwnerId: f.b.userId } });
  assert.deepEqual((await readCommercialProgress(db, f.a, {})).items, []);
  assert.equal((await readCommercialProgress(db, f.b, {})).items.length, 1);
  await db.technicalPractice.update({ where: { id: f.first.practice.id }, data: { commercialOwnerId: f.b.userId } });
  assert.equal((await readCommercialProgress(db, f.b, {})).items.length, 2);
});

test('fresh session, role, deny and expiry override a stale page snapshot', options, async () => {
  const f = await fixture();
  await db.userPermissionOverride.create({ data: { userId: f.a.userId, permission: 'client.read', allowed: false } });
  await assert.rejects(readCommercialProgress(db, f.a, {}), CommercialProgressUnavailable);
  await db.userPermissionOverride.deleteMany({ where: { userId: f.a.userId } });
  await db.user.update({ where: { id: f.a.userId }, data: { role: 'consulente' } });
  await assert.rejects(readCommercialProgress(db, f.a, {}), CommercialProgressUnavailable);
  await db.user.update({ where: { id: f.a.userId }, data: { role: 'commerciale' } });
  await assert.rejects(readCommercialProgress(db, { ...f.a, sessionId: f.b.sessionId }, {}), CommercialProgressUnavailable);
  await assert.rejects(readCommercialProgress(db, { ...f.a, expiresAt: 0 }, {}), CommercialProgressUnavailable);
  await db.internalSession.update({ where: { id: f.a.sessionId }, data: { createdAt: new Date(Date.now() - 120000), expiresAt: new Date(Date.now() - 60000) } });
  await assert.rejects(readCommercialProgress(db, f.a, {}), CommercialProgressUnavailable);
  await db.internalSession.update({ where: { id: f.b.sessionId }, data: { revokedAt: new Date(), revokedReason: 'INTERNAL_SINGLE' } });
  await assert.rejects(readCommercialProgress(db, f.b, {}), CommercialProgressUnavailable);
});

test('archived, missing, moved and cross-client parents are excluded from list, search and direct filter', options, async () => {
  const f = await fixture();
  const hidden = async () => assert.deepEqual((await readCommercialProgress(db, f.a, { client: f.first.client.id })).items, []);
  await db.clientService.update({ where: { id: f.first.service.id }, data: { status: 'archiviato' } }); await hidden();
  await db.clientService.update({ where: { id: f.first.service.id }, data: { status: 'in_lavorazione', clientId: f.second.client.id } }); await hidden();
  await db.clientService.update({ where: { id: f.first.service.id }, data: { clientId: f.first.client.id } });
  await db.project.update({ where: { id: f.first.project.id }, data: { status: 'archiviato' } }); await hidden();
  await db.project.update({ where: { id: f.first.project.id }, data: { status: 'idea', deletedAt: new Date() } }); await hidden();
  await db.project.update({ where: { id: f.first.project.id }, data: { deletedAt: null } });
  await db.technicalPractice.update({ where: { id: f.first.practice.id }, data: { projectId: 'missing-synthetic-project' } }); await hidden();
  await db.technicalPractice.update({ where: { id: f.first.practice.id }, data: { projectId: f.first.project.id, status: 'archiviata' } }); await hidden();
  await db.technicalPractice.update({ where: { id: f.first.practice.id }, data: { status: 'in_progettazione' } });
  assert.equal((await readCommercialProgress(db, f.a, {})).items.length, 1);
  await db.technicalPractice.update({ where: { id: f.first.practice.id }, data: { projectId: null } });
  assert.equal((await readCommercialProgress(db, f.a, {})).items.length, 1, 'A coherent project inherited from the linked service remains usable');
  await db.client.update({ where: { id: f.first.client.id }, data: { deletedAt: new Date() } }); await hidden();
});

test('pagination never uses another owner as cursor; all admitted practices remain discoverable', options, async () => {
  const f = await fixture();
  const extra = Array.from({ length: 50 }, () => ({ ...f.first.practice, id: `progress_${randomUUID().replaceAll('-', '')}` }));
  practices.push(...extra.map(row => row.id)); await db.technicalPractice.createMany({ data: extra });
  const first = await readCommercialProgress(db, f.a, {});
  assert.equal(first.items.length, 50); assert.equal(first.next, first.items[49].id);
  const second = await readCommercialProgress(db, f.a, { after: first.next! });
  assert.equal(second.items.length, 1); assert.equal(second.next, null);
  assert.equal(new Set([...first.items, ...second.items].map(row => row.id)).size, 51);
  assert.ok(!JSON.stringify([first, second]).includes(f.second.practice.id));
});

test('concurrent sales change or parent suspension cannot release a stale admitted projection', options, async () => {
  for (const boundary of ['client', 'project'] as const) {
    const f = await fixture();
    let pending: Promise<{ error?: unknown }> | undefined;
    await db.$transaction(async writer => {
      const [identity] = await writer.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      if (boundary === 'client') await writer.$queryRaw`SELECT "id" FROM "Client" WHERE "id"=${f.first.client.id} FOR UPDATE`;
      else await writer.$queryRaw`SELECT "id" FROM "Project" WHERE "id"=${f.first.project.id} FOR UPDATE`;
      pending = readCommercialProgress(db, f.a, {}).then(() => ({}), error => ({ error }));
      let blocked = false;
      for (let attempt = 0; attempt < 80; attempt++) {
        const [state] = await db.$queryRaw<Array<{ blocked: boolean }>>`SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
          AND ${identity.pid}=ANY(pg_blocking_pids(pid))
        ) AS blocked`;
        if (state.blocked) { blocked = true; break; }
        await delay(25);
      }
      assert.ok(blocked, 'Reader must actually contend with the writer, not merely run afterwards');
      if (boundary === 'client') await writer.client.update({ where: { id: f.first.client.id }, data: { salesOwnerId: f.b.userId } });
      else await writer.project.update({ where: { id: f.first.project.id }, data: { status: 'archiviato' } });
    }, { timeout: 10000 });
    const outcome = await pending!;
    assert.ok(outcome.error instanceof SerializableConflictError, 'The overlapping read must fail closed on its obsolete snapshot');
    assert.deepEqual((await readCommercialProgress(db, f.a, { client: f.first.client.id })).items, []);
  }
});
