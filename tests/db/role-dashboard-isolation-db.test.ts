import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../src/lib/prisma';
import type { AuthSession } from '../../src/lib/auth';
import { getAccessibleDashboardOfferIds, countAccessibleDashboardOffers } from '../../src/lib/dashboard-business-counts';
import { getAccessibleDashboardTaskCounts, getClientDossierReadAccess, listAccessibleTasks } from '../../src/lib/read-access';
import { buildOperationalReportMarkdown } from '../../src/lib/operational-report';
import { assertAiOrchestratorEphemeralDatabaseIdentity, assertAiOrchestratorEphemeralDbTestConfiguration } from './ai-orchestrator-db-test-guard';

const enabled = process.env.ROLE_DASHBOARD_DB_CONFIRMED === '1' && assertAiOrchestratorEphemeralDbTestConfiguration({ requested: process.env.RUN_DB_TESTS === '1',
  destructiveConfirmed: process.env.AI_ORCHESTRATOR_DB_TESTS_CONFIRMED === '1', databaseUrl: process.env.DATABASE_URL,
  sentinel: process.env.AI_ORCHESTRATOR_DB_TEST_SENTINEL, appEnvironment: process.env.APP_ENV, nodeEnvironment: process.env.NODE_ENV });
test.before(async () => { if (enabled) await assertAiOrchestratorEphemeralDatabaseIdentity(prisma); });
test.after(() => prisma.$disconnect());

test('same-client assignments agree across complete counters, previews, dossier access and operational exports', { skip: !enabled }, async () => {
  const prefix = `isolation-${randomUUID()}-`, owner = prefix + 'owner', other = prefix + 'other', clientId = prefix + 'client';
  const session: AuthSession = { userId: owner, role: 'commerciale', active: true, permissionOverrides: [
    { permission: 'project.read', allowed: true }, { permission: 'service.read', allowed: true },
  ], clientReadScope: [clientId], expiresAt: Math.floor(Date.now() / 1000) + 3600 };
  const otherSession = { ...session, userId: other };
  const now = new Date('2026-01-02T12:00:00Z'), day = new Date('2026-01-02T00:00:00Z');
  await prisma.client.create({ data: { id: clientId, type: 'societa', displayName: prefix, salesOwnerId: owner } });
  await prisma.project.createMany({ data: [owner, other].map(id => ({ id: id + '-project', clientId, title: id, consultantId: id })) });
  await prisma.serviceCatalog.createMany({ data: [owner, other].map(id => ({ id: id + '-catalog', code: id, name: id + '-service-marker', category: 'synthetic_test' })) });
  await prisma.clientService.createMany({ data: [owner, other].map(id => ({ id: id + '-service', clientId, projectId: id + '-project', assignedToId: id, serviceCatalogId: id + '-catalog' })) });
  await prisma.task.createMany({ data: [owner, other].map(id => ({ id: id + '-task', clientId, title: id + '-task-marker', assignedToId: id, createdById: owner, dueAt: day })) });
  await prisma.lead.createMany({ data: [owner, other].map(id => ({ id: id + '-lead', clientId, firstName: 'Synthetic', lastName: id, assignedToId: id })) });
  await prisma.commercialOffer.createMany({ data: Array.from({ length: 122 }, (_, i) => ({ id: prefix + 'offer-' + String(i).padStart(3, '0'), clientId,
    leadId: (i % 2 ? other : owner) + '-lead', createdById: owner, title: 'Synthetic sibling offer', status: 'inviata', taxableAmount: 1, vatAmount: 0, totalAmount: 1 })) });
  await prisma.clientDossier.createMany({ data: [owner, other].map(id => ({ id: id + '-dossier', clientId, title: id, content: 'Synthetic dossier', createdById: id })) });
  try {
    const ids = (await getAccessibleDashboardOfferIds(session)).filter(id => id.startsWith(prefix));
    assert.equal(ids.length, 61); assert.ok(ids.every(id => Number(id.slice(-3)) % 2 === 0));
    assert.deepEqual(await countAccessibleDashboardOffers(session), { sent: 61, accepted: 0 });
    const tasks = await listAccessibleTasks(session, { where: { clientId } });
    assert.deepEqual(tasks.map(row => row.id), [owner + '-task']);
    const counts = await getAccessibleDashboardTaskCounts(session, { now, startOfToday: day, endOfToday: new Date('2026-01-02T23:59:59Z'), next7: new Date('2026-01-09') });
    assert.equal(counts.open, tasks.length); assert.equal(counts.mine, 1);
    assert.ok(await getClientDossierReadAccess(session, owner + '-dossier'));
    assert.equal(await getClientDossierReadAccess(session, other + '-dossier'), null);
    const report = await buildOperationalReportMarkdown(session, { clientId });
    assert.ok(report); assert.ok(report.markdown.includes(owner + '-service-marker'));
    assert.ok(!report.markdown.includes(other + '-service-marker')); assert.ok(!report.markdown.includes(other + '-task-marker'));
    const readerReport = await buildOperationalReportMarkdown(otherSession, { clientId });
    assert.ok(readerReport); assert.ok(!readerReport.markdown.includes(owner + '-service-marker'));
    await prisma.task.update({ where: { id: owner + '-task' }, data: { assignedToId: other } });
    assert.equal((await listAccessibleTasks(session, { where: { clientId } })).length, 0);
    assert.equal((await getAccessibleDashboardTaskCounts(session, { now, startOfToday: day, endOfToday: now, next7: now })).open, 0);
  } finally {
    // Exact synthetic IDs only, in the guarded disposable CI database.
    await prisma.commercialOffer.deleteMany({ where: { clientId } });
    await prisma.lead.deleteMany({ where: { clientId } });
    await prisma.clientDossier.deleteMany({ where: { clientId } });
    await prisma.task.deleteMany({ where: { clientId } });
    await prisma.clientService.deleteMany({ where: { clientId } });
    await prisma.serviceCatalog.deleteMany({ where: { id: { in: [owner + '-catalog', other + '-catalog'] } } });
    await prisma.project.deleteMany({ where: { clientId } });
    await prisma.client.delete({ where: { id: clientId } });
  }
});
