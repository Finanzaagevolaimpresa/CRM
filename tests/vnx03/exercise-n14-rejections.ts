import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import {
  claimCommercialLeadInboxItem,
  recordCommercialLeadFirstResponse,
} from '../../src/lib/commercial-lead-inbox';
import { CommercialLeadInboxError } from '../../src/lib/commercial-lead-inbox-contract';
import { internalSessionMode } from '../../src/lib/session';

const db = new PrismaClient();

async function snapshot() {
  const lead = await db.lead.findFirstOrThrow({ where: { email: 'commercial-browser@vnx03.invalid' } });
  const item = await db.commercialLeadInboxItem.findUniqueOrThrow({
    where: { leadId: lead.id }, include: { slaCycles: true, activities: { orderBy: { sequence: 'asc' } } },
  });
  return {
    leadId: lead.id, assignedToId: lead.assignedToId, leadUpdatedAt: lead.updatedAt.toISOString(),
    itemVersion: item.version, itemUpdatedAt: item.updatedAt.toISOString(),
    cycles: item.slaCycles.map((cycle) => ({
      version: cycle.version, firstResponseAt: cycle.firstResponseAt?.toISOString() ?? null,
      outcome: cycle.outcome, updatedAt: cycle.updatedAt.toISOString(),
    })),
    activities: item.activities.map((activity) => ({
      sequence: activity.sequence, activityType: activity.activityType,
      actorUserId: activity.actorUserId, actorSessionId: activity.actorSessionId,
    })),
  };
}

async function actor(userId: string) {
  const session = await db.internalSession.findFirstOrThrow({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' },
  });
  return { userId, sessionId: session.id };
}

async function main() {
  assert.equal(process.env.COMMERCIAL_LEAD_INBOX_MODE, 'enforced');
  assert.equal(internalSessionMode(), 'registry', 'VNX03_N14_REGISTRY_AUTHORITY_REQUIRED');
  const scenario = process.env.VNX03_N14_REJECTION;
  const before = await snapshot();
  let expectedCode: 'N14_VERSION_CONFLICT' | 'N14_PERMISSION_DENIED';
  let operation: Promise<unknown>;
  if (scenario === 'stale_claim') {
    expectedCode = 'N14_VERSION_CONFLICT';
    operation = claimCommercialLeadInboxItem(db, {
      leadId: before.leadId, actor: await actor('vnx03-n14-commercial-one'), expectedInboxVersion: 1,
    });
  } else if (scenario === 'foreign_first_response') {
    expectedCode = 'N14_PERMISSION_DENIED';
    operation = recordCommercialLeadFirstResponse(db, {
      leadId: before.leadId, actor: await actor('vnx03-n14-commercial-two'), expectedInboxVersion: 2,
    });
  } else throw new Error('VNX03_N14_REJECTION_INVALID');
  await assert.rejects(operation, (error) =>
    error instanceof CommercialLeadInboxError && error.code === expectedCode);
  assert.deepEqual(await snapshot(), before);
  process.stdout.write(`${JSON.stringify({ scenario, rejectedBy: expectedCode, stateUnchanged: true })}\n`);
}

void main().catch(() => {
  process.stderr.write('VNX03_N14_REJECTION_ASSERT_FAILED\n');
  process.exitCode = 1;
}).finally(async () => db.$disconnect());
