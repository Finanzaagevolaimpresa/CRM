import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Prisma } from '@prisma/client';
import type { AuthSession } from '../../src/lib/auth';
import { reserveAuthorizedAiRun } from '../../src/lib/ai-execution-authorization';
import { aiExecutionCanonicalSha256V2 } from '../../src/lib/canonical-json';
import { prisma } from '../../src/lib/prisma';
import {
  getAccessibleDashboardAiReviewCount,
  getAccessibleDashboardTaskCounts,
  listAccessibleAiOutputs,
  listAccessibleTasks,
} from '../../src/lib/read-access';
import {
  assertAiOrchestratorEphemeralDatabaseIdentity,
  assertAiOrchestratorEphemeralDbTestConfiguration,
} from './ai-orchestrator-db-test-guard';

const runDbTests = assertAiOrchestratorEphemeralDbTestConfiguration({
  requested: process.env.RUN_DB_TESTS === '1',
  destructiveConfirmed: process.env.AI_ORCHESTRATOR_DB_TESTS_CONFIRMED === '1',
  databaseUrl: process.env.DATABASE_URL,
  sentinel: process.env.AI_ORCHESTRATOR_DB_TEST_SENTINEL,
  appEnvironment: process.env.APP_ENV,
  nodeEnvironment: process.env.NODE_ENV,
});
const runPrefix = `dashboard-counts-${randomUUID()}-`;
const dates = {
  now: new Date('2026-09-12T12:00:00.000Z'),
  startOfToday: new Date('2026-09-12T00:00:00.000Z'),
  endOfToday: new Date('2026-09-12T23:59:59.999Z'),
  next7: new Date('2026-09-19T12:00:00.000Z'),
};
const zeroTaskCounts = { open: 0, today: 0, overdue: 0, dueSoon: 0, mine: 0 };

function sessionFor(userId: string, role: AuthSession['role'] = 'commerciale'): AuthSession {
  return {
    userId,
    role,
    active: true,
    permissionOverrides: [],
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
}

function numbered(prefix: string, index: number) {
  return `${prefix}${String(index).padStart(4, '0')}`;
}

test.before(async () => {
  if (runDbTests) await assertAiOrchestratorEphemeralDatabaseIdentity(prisma);
});

test.after(async () => {
  await prisma.$disconnect();
});

test('dashboard task totals cross 50 visible rows and 520 inaccessible candidates while previews stay bounded', { skip: !runDbTests }, async () => {
  const prefix = `${runPrefix}task-pages-`;
  const session = sessionFor(`${prefix}owner`);
  try {
    await prisma.task.createMany({ data: [
      ...Array.from({ length: 520 }, (_, index) => ({
        id: numbered(`${prefix}a-hidden-`, index),
        title: 'Synthetic inaccessible task',
        assignedToId: `${prefix}another-owner`,
      })),
      ...Array.from({ length: 61 }, (_, index) => ({
        id: numbered(`${prefix}z-visible-`, index),
        title: 'Synthetic accessible task',
        assignedToId: session.userId,
        status: index % 2 === 0 ? 'aperta' as const : 'in_lavorazione' as const,
        dueAt: index === 60 ? dates.now : new Date(dates.startOfToday.getTime() - 1),
      })),
    ] });

    assert.deepEqual(await getAccessibleDashboardTaskCounts(session, dates), {
      open: 61, today: 1, overdue: 60, dueSoon: 1, mine: 61,
    });
    const hiddenPrefixPreview = await listAccessibleTasks(session, {
      where: { id: { startsWith: prefix }, deletedAt: null },
      orderBy: { id: 'asc' },
      take: 100,
    });
    assert.equal(hiddenPrefixPreview.length, 0, 'the existing preview still limits candidates to 500');
    const visiblePreview = await listAccessibleTasks(session, {
      where: { id: { startsWith: `${prefix}z-visible-` }, deletedAt: null },
      orderBy: { id: 'asc' },
    });
    assert.equal(visiblePreview.length, 50, 'the existing preview still defaults to 50 rows');
    assert.equal(new Set(visiblePreview.map(({ id }) => id)).size, 50);
  } finally {
    await prisma.task.deleteMany({ where: { id: { startsWith: prefix } } });
  }
});

test('dashboard task buckets preserve exact dates and reject deleted, closed and inconsistent contexts', { skip: !runDbTests }, async () => {
  const prefix = `${runPrefix}task-context-`;
  const session = sessionFor(`${prefix}owner`, 'consulente');
  const clientId = `${prefix}client`;
  const deletedClientId = `${prefix}deleted-client`;
  const otherClientId = `${prefix}other-client`;
  const projectId = `${prefix}project`;
  const deletedProjectId = `${prefix}deleted-project`;
  const serviceId = `${prefix}service`;
  const deletedServiceId = `${prefix}deleted-service`;
  const mismatchedServiceId = `${prefix}mismatched-service`;
  const dateValues = [
    new Date(dates.startOfToday.getTime() - 1),
    dates.startOfToday,
    new Date(dates.now.getTime() - 1),
    dates.now,
    dates.endOfToday,
    dates.next7,
    new Date(dates.next7.getTime() + 1),
    null,
  ];
  try {
    await prisma.client.createMany({ data: [
      { id: clientId, type: 'societa', displayName: 'Synthetic project client' },
      { id: deletedClientId, type: 'societa', displayName: 'Synthetic deleted client', deletedAt: dates.now },
      { id: otherClientId, type: 'societa', displayName: 'Synthetic other client' },
    ] });
    await prisma.project.createMany({ data: [
      { id: projectId, clientId, title: 'Synthetic assigned project', consultantId: session.userId },
      { id: deletedProjectId, clientId, title: 'Synthetic deleted project', consultantId: session.userId, deletedAt: dates.now },
    ] });
    await prisma.serviceCatalog.create({ data: {
      id: `${prefix}catalog`, code: `${prefix}catalog`,
      name: 'Synthetic count service', category: 'synthetic_test',
    } });
    await prisma.clientService.createMany({ data: [
      { id: serviceId, clientId, projectId, serviceCatalogId: `${prefix}catalog` },
      { id: deletedServiceId, clientId, projectId, serviceCatalogId: `${prefix}catalog`, deletedAt: dates.now },
      { id: mismatchedServiceId, clientId: otherClientId, projectId, serviceCatalogId: `${prefix}catalog` },
    ] });
    const invalidContexts: Prisma.TaskCreateManyInput[] = [
      { id: `${prefix}missing-client`, clientId: `${prefix}absent-client`, title: 'Missing client', assignedToId: session.userId },
      { id: `${prefix}deleted-client-task`, clientId: deletedClientId, title: 'Deleted client', assignedToId: session.userId },
      { id: `${prefix}missing-project`, clientId, projectId: `${prefix}absent-project`, title: 'Missing project', assignedToId: session.userId },
      { id: `${prefix}deleted-project-task`, clientId, projectId: deletedProjectId, title: 'Deleted project', assignedToId: session.userId },
      { id: `${prefix}deleted-service-task`, clientId, clientServiceId: deletedServiceId, title: 'Deleted service', assignedToId: session.userId },
      { id: `${prefix}mismatched-service-task`, clientId, clientServiceId: mismatchedServiceId, title: 'Mismatched service', assignedToId: session.userId },
      { id: `${prefix}orphan-service-task`, clientServiceId: serviceId, title: 'Missing root client', assignedToId: session.userId },
    ];
    await prisma.task.createMany({ data: [
      ...dateValues.map((dueAt, index) => ({
        id: numbered(`${prefix}date-`, index),
        title: 'Synthetic date boundary',
        dueAt,
        assignedToId: session.userId,
      })),
      // The task has no direct projectId: access comes only through the service's project.
      { id: `${prefix}service-only`, clientId, clientServiceId: serviceId, title: 'Synthetic service-only access' },
      { id: `${prefix}completed`, title: 'Completed task', assignedToId: session.userId, status: 'completata', dueAt: dates.now },
      { id: `${prefix}cancelled`, title: 'Cancelled task', assignedToId: session.userId, status: 'annullata', dueAt: dates.now },
      { id: `${prefix}deleted`, title: 'Deleted task', assignedToId: session.userId, deletedAt: dates.now, dueAt: dates.now },
      ...invalidContexts,
    ] });

    assert.deepEqual(await getAccessibleDashboardTaskCounts(session, dates), {
      open: 9, today: 4, overdue: 3, dueSoon: 3, mine: 8,
    });
    const serviceOnlyPreview = await listAccessibleTasks(session, {
      where: { id: `${prefix}service-only` },
    });
    assert.deepEqual(serviceOnlyPreview.map(({ id }) => id), [`${prefix}service-only`]);
    assert.equal((await listAccessibleTasks(session, {
      where: { id: { in: invalidContexts.map(({ id }) => id as string) } },
      take: 100,
    })).length, 0);
  } finally {
    await prisma.task.deleteMany({ where: { id: { startsWith: prefix } } });
    await prisma.clientService.deleteMany({ where: { id: { startsWith: prefix } } });
    await prisma.serviceCatalog.deleteMany({ where: { id: `${prefix}catalog` } });
    await prisma.project.deleteMany({ where: { id: { startsWith: prefix } } });
    await prisma.client.deleteMany({ where: { id: { startsWith: prefix } } });
  }
});

test('dashboard AI review totals cross both preview limits and reject inconsistent or ineligible output rows', { skip: !runDbTests }, async () => {
  const prefix = `${runPrefix}ai-pages-`;
  const config = await prisma.aiAgentConfigVersion.findFirstOrThrow({
    where: { active: true, provider: 'mock' },
    orderBy: [{ agentId: 'asc' }, { version: 'desc' }],
  });
  const [admin, requester] = await Promise.all([
    prisma.user.create({ data: {
      id: `${prefix}admin`, email: `${prefix}admin@example.test`,
      name: 'Synthetic dashboard Admin', passwordHash: 'synthetic-test-no-login', role: 'admin',
    } }),
    prisma.user.create({ data: {
      id: `${prefix}requester`, email: `${prefix}requester@example.test`,
      name: 'Synthetic dashboard requester', passwordHash: 'synthetic-test-no-login', role: 'commerciale',
    } }),
  ]);
  const client = await prisma.client.create({ data: {
    id: `${prefix}client`, type: 'societa', displayName: 'Synthetic AI count client',
    salesOwnerId: requester.id,
  } });
  const session = sessionFor(requester.id);
  const input = { synthetic: true, test: 'dashboard-counts', runPrefix };
  const inputFingerprint = aiExecutionCanonicalSha256V2(input);
  const key = randomUUID();
  // Use the real authorization path; never disable a trigger to manufacture runs.
  const request = await prisma.aiExecutionRequest.create({ data: {
    origin: 'CRM_UI', requesterKind: 'HUMAN_USER', requesterUserId: requester.id,
    clientId: client.id, functionCode: 'DASHBOARD_SYNTHETIC_DB_TEST',
    agentId: config.agentId, agentConfigVersion: config.version,
    provider: 'mock', model: config.model,
    purposeCode: 'SYNTHETIC_TEST', dataCategories: ['synthetic_test'],
    correlationId: key, idempotencyKey: key, inputFingerprint,
    executionInputHash: aiExecutionCanonicalSha256V2(input), hashCanonicalizationVersion: 2,
    expiresAt: new Date(Date.now() + 30 * 60 * 1000),
  } });
  await prisma.aiExecutionDecision.create({ data: {
    requestId: request.id, decisionType: 'APPROVED', actorUserId: admin.id, actorRole: admin.role,
    reasonCode: 'AI_EXECUTION_APPROVED',
    reason: 'Synthetic dashboard count fixture; no provider execution.',
    requestFingerprint: inputFingerprint,
  } });
  const grant = await prisma.aiExecutionAuthorizationGrant.findUniqueOrThrow({
    where: { requestId: request.id },
  });
  const reservation = await reserveAuthorizedAiRun({
    requestId: request.id, authorizationGrantId: grant.id, inputFingerprint, input,
  });
  // Reservation only. No adapter, worker, scheduler or external provider is invoked.
  const baseOutput = {
    aiRunId: reservation.run.id, clientId: client.id,
    title: 'Synthetic review count', content: 'Invented test content only.',
  };
  try {
    await prisma.aiOutput.createMany({ data: [
      ...Array.from({ length: 520 }, (_, index) => ({
        ...baseOutput, id: numbered(`${prefix}a-hidden-`, index), clientId: null,
      })),
      ...Array.from({ length: 61 }, (_, index) => ({
        ...baseOutput, id: numbered(`${prefix}z-visible-`, index),
        status: index % 2 === 0 ? 'needs_review' as const : 'flagged' as const,
      })),
      { ...baseOutput, id: `${prefix}missing-run`, aiRunId: `${prefix}absent-run` },
      { ...baseOutput, id: `${prefix}missing-project`, projectId: `${prefix}absent-project` },
      { ...baseOutput, id: `${prefix}no-review`, requiresHumanReview: false },
      { ...baseOutput, id: `${prefix}approved`, status: 'approved' },
      { ...baseOutput, id: `${prefix}rejected`, status: 'rejected' },
      { ...baseOutput, id: `${prefix}archived`, status: 'archived' },
    ] });

    assert.equal(await getAccessibleDashboardAiReviewCount(session), 61);
    assert.equal((await listAccessibleAiOutputs(session, {
      where: { id: { startsWith: prefix }, requiresHumanReview: true, status: { in: ['needs_review', 'flagged'] } },
      orderBy: { id: 'asc' }, take: 100,
    })).length, 0, 'the existing preview does not scan beyond 500 candidates');
    assert.equal((await listAccessibleAiOutputs(session, {
      where: { id: { startsWith: `${prefix}z-visible-` } }, orderBy: { id: 'asc' },
    })).length, 50, 'the preview stays bounded while the count is complete');
    assert.equal(await getAccessibleDashboardAiReviewCount(sessionFor(`${prefix}unrelated`)), 0);

    await prisma.client.update({ where: { id: client.id }, data: { deletedAt: new Date() } });
    assert.equal(await getAccessibleDashboardAiReviewCount(session), 0, 'deleted client contexts do not contribute');
  } finally {
    await prisma.aiOutput.deleteMany({ where: { id: { startsWith: prefix } } });
    // Requests, grants, decisions and the bound run are append-only synthetic evidence.
    // Their referenced users/client stay in the guarded ephemeral database; no trigger,
    // audit, ledger or unrelated record is altered or removed for cleanup.
  }
});

test('dashboard aggregates return zero for an unrelated actor with no accessible data', { skip: !runDbTests }, async () => {
  const session = sessionFor(`${runPrefix}no-access`);
  assert.deepEqual(await getAccessibleDashboardTaskCounts(session, dates), zeroTaskCounts);
  assert.equal(await getAccessibleDashboardAiReviewCount(session), 0);
});
