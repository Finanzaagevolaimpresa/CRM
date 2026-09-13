import assert from 'node:assert/strict';
import test from 'node:test';
import type { Prisma } from '@prisma/client';
import type { AuthSession } from '../src/lib/auth';
import { prisma } from '../src/lib/prisma';
import { getAccessibleDashboardAiReviewCount, getAccessibleDashboardTaskCounts } from '../src/lib/read-access';

const session: AuthSession = {
  userId: 'synthetic-counter-admin', role: 'admin', active: true,
  permissionOverrides: [], expiresAt: 2_000_000_000,
};
const window = {
  now: new Date('2026-09-12T12:00:00Z'),
  startOfToday: new Date('2026-09-12T00:00:00Z'),
  endOfToday: new Date('2026-09-12T23:59:59.999Z'),
  next7: new Date('2026-09-19T12:00:00Z'),
};

for (const kind of ['task', 'aiOutput'] as const) {
  test(`${kind} complete counter propagates a later-page failure instead of returning a partial total`, async (t) => {
    let pages = 0;
    const failure = new Error('synthetic later-page database failure');
    const rows = Array.from({ length: 100 }, (_, i) => ({
      id: `synthetic-${String(i).padStart(4, '0')}`, aiRunId: 'synthetic-run',
      clientId: null, projectId: null, clientServiceId: null,
      assignedToId: session.userId, createdById: session.userId,
      dueAt: window.now, status: 'needs_review', requiresHumanReview: true,
      forbiddenPhrases: null, reviewedById: null, reviewedAt: null,
    }));
    const transaction = {
      [kind]: { findMany: async () => { if (++pages === 1) return rows; throw failure; } },
      client: { findMany: async () => [] },
      project: { findMany: async () => [] },
      clientService: { findMany: async () => [] },
      aiRun: { findMany: async () => [{ id: 'synthetic-run', clientId: null, projectId: null, clientServiceId: null }] },
    } as unknown as Prisma.TransactionClient;
    t.mock.method(prisma, '$transaction', async (run: (tx: Prisma.TransactionClient) => Promise<unknown>) => run(transaction));

    await assert.rejects(
      kind === 'task' ? getAccessibleDashboardTaskCounts(session, window) : getAccessibleDashboardAiReviewCount(session),
      (error) => error === failure,
    );
    assert.equal(pages, 2);
  });
}
