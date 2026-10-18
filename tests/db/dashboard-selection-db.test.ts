import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { prisma } from '../../src/lib/prisma';
import type { AuthSession } from '../../src/lib/auth';
import { loadDashboardLeadDetail, loadDashboardReviewDetail, loadDashboardTodayDetail, listDashboardTodayTasks } from '../../src/lib/dashboard-detail';
import { dashboardTodayWindow } from '../../src/lib/dashboard-selection';
import { countAccessibleDashboardDossiers } from '../../src/lib/dashboard-business-counts';
import { getAccessibleDashboardTaskCounts } from '../../src/lib/read-access';
import { assertAiOrchestratorEphemeralDatabaseIdentity, assertAiOrchestratorEphemeralDbTestConfiguration } from './ai-orchestrator-db-test-guard';
const run = assertAiOrchestratorEphemeralDbTestConfiguration({ requested: process.env.RUN_DB_TESTS === '1', destructiveConfirmed: process.env.AI_ORCHESTRATOR_DB_TESTS_CONFIRMED === '1', databaseUrl: process.env.DATABASE_URL, sentinel: process.env.AI_ORCHESTRATOR_DB_TEST_SENTINEL, appEnvironment: process.env.APP_ENV, nodeEnvironment: process.env.NODE_ENV });
const prefix = `dashboard-selection-${randomUUID()}-`;
const actor: AuthSession = { userId: prefix + 'reader', role: 'consulente', active: true, permissionOverrides: [], expiresAt: Math.floor(Date.now() / 1000) + 3600 };
test.before(async () => { if (run) await assertAiOrchestratorEphemeralDatabaseIdentity(prisma); });
test.after(async () => { await prisma.$disconnect(); });

test('lead preview narrows the count predicate and excludes deleted, different-status and reassigned records', { skip: !run }, async () => {
  const base = { firstName: 'Synthetic', lastName: 'Dashboard', assignedToId: actor.userId, status: 'da_contattare' as const };
  try {
    await prisma.lead.createMany({ data: [
      ...[1, 2, 3].map(i => ({ ...base, id: `${prefix}lead-${i}`, companyName: `Lead ${i}` })),
      { ...base, id: prefix + 'lead-deleted', deletedAt: new Date() },
      { ...base, id: prefix + 'lead-new', status: 'nuovo' },
      { ...base, id: prefix + 'lead-other', assignedToId: prefix + 'other' },
    ] });
    assert.equal((await loadDashboardLeadDetail(actor)).length, 3);
    assert((await loadDashboardLeadDetail(actor)).every(row => row.status === 'da_contattare' && !/deleted|other|new/.test(row.id)));
    await prisma.lead.update({ where: { id: prefix + 'lead-1' }, data: { assignedToId: prefix + 'other' } });
    assert.equal((await loadDashboardLeadDetail(actor)).length, 2);
    const denied = { ...actor, permissionOverrides: [{ permission: 'lead.read', allowed: false }] };
    assert.deepEqual(await loadDashboardLeadDetail(denied), []);
  } finally { await prisma.lead.deleteMany({ where: { id: { startsWith: prefix + 'lead-' } } }); }
});

test('review preview scans beyond an inaccessible page and matches complete count and parent coherence', { skip: !run }, async () => {
  const client = prefix + 'client', project = prefix + 'project', other = prefix + 'project-other';
  try {
    await prisma.client.create({ data: { id: client, type: 'societa', displayName: 'Synthetic review parent', consultantId: actor.userId } });
    await prisma.project.createMany({ data: [{ id: project, clientId: client, title: 'Visible synthetic project', consultantId: actor.userId }, { id: other, clientId: client, title: 'Excluded synthetic project', consultantId: prefix + 'other' }] });
    const base = { clientId: client, status: 'da_revisionare' as const };
    await prisma.preAnalysis.createMany({ data: [
      ...Array.from({ length: 101 }, (_, i) => ({ ...base, id: `${prefix}analysis-a${String(i).padStart(3, '0')}`, projectId: other })),
      ...[1, 2, 3].map(i => ({ ...base, id: `${prefix}analysis-z${i}`, projectId: project })),
      { ...base, id: prefix + 'analysis-dangling', projectId: prefix + 'absent' },
    ] });
    assert.equal((await countAccessibleDashboardDossiers(actor)).preReview, 3);
    const preview = await loadDashboardReviewDetail(actor);
    assert.equal(preview.length, 3); assert(preview.every(row => row.title === 'Visible synthetic project'));
    await prisma.project.update({ where: { id: project }, data: { consultantId: prefix + 'other' } });
    assert.deepEqual(await loadDashboardReviewDetail(actor), []);
    assert.equal((await countAccessibleDashboardDossiers(actor)).preReview, 0);
  } finally {
    await prisma.preAnalysis.deleteMany({ where: { id: { startsWith: prefix + 'analysis-' } } });
    await prisma.project.deleteMany({ where: { id: { in: [project, other] } } });
    await prisma.client.deleteMany({ where: { id: client } });
  }
});

test('today preview does not truncate access before filtering, and uses the exact open day count', { skip: !run }, async () => {
  const now = new Date(), { startOfToday, endOfToday } = dashboardTodayWindow(now);
  const base = { dueAt: now, title: 'Synthetic task', assignedToId: actor.userId, createdById: actor.userId };
  try {
    await prisma.task.createMany({ data: [
      ...Array.from({ length: 101 }, (_, i) => ({ ...base, id: `${prefix}task-a${String(i).padStart(3, '0')}`, assignedToId: prefix + 'other', createdById: prefix + 'other' })),
      ...[1, 2, 3].map(i => ({ ...base, id: `${prefix}task-z${i}` })),
      { ...base, id: prefix + 'task-complete', status: 'completata' },
      { ...base, id: prefix + 'task-old', dueAt: new Date(+startOfToday - 1) },
      { ...base, id: prefix + 'task-future', dueAt: new Date(+endOfToday + 1) },
      { ...base, id: prefix + 'task-deleted', deletedAt: now },
    ] });
    const counts = await getAccessibleDashboardTaskCounts(actor, { now, startOfToday, endOfToday, next7: new Date(+now + 7 * 86_400_000) });
    assert.equal(counts.today, 3);
    const rows = await loadDashboardTodayDetail(actor, now);
    assert.equal(rows.length, 3); assert(rows.every(row => row.id.startsWith(prefix + 'task-z')));
    await prisma.task.update({ where: { id: prefix + 'task-z1' }, data: { assignedToId: prefix + 'other' } });
    assert.equal((await loadDashboardTodayDetail(actor, now)).length, 2);
    await prisma.task.createMany({ data: Array.from({ length: 123 }, (_, i) => ({ ...base, id: `${prefix}task-zz${String(i).padStart(3, '0')}` })) });
    const completeList = await listDashboardTodayTasks(actor, now);
    assert.equal(completeList.length, 125);
    assert(!completeList.some(row => row.id === prefix + 'task-z1'));
    assert.equal((await getAccessibleDashboardTaskCounts(actor, { now, startOfToday, endOfToday, next7: new Date(+now + 7 * 86_400_000) })).today, completeList.length);
  } finally { await prisma.task.deleteMany({ where: { id: { startsWith: prefix + 'task-' } } }); }
});
