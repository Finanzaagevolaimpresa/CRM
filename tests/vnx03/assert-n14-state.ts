import assert from 'node:assert/strict';
import { Prisma, PrismaClient } from '@prisma/client';

const db = new PrismaClient();

async function main() {
  const checkpoint = process.env.VNX03_N14_CHECKPOINT;
  const identity = await db.$queryRaw<Array<{ database: string; sentinel: string | null }>>(Prisma.sql`
    SELECT current_database() AS database, shobj_description(oid, 'pg_database') AS sentinel
    FROM pg_database WHERE datname = current_database()
  `);
  assert.deepEqual(identity, [{ database: 'fai_vnx03_e2e', sentinel: 'FAI_CRM_VNX03_EPHEMERAL_TEST_ONLY_V1' }]);
  const lead = await db.lead.findFirstOrThrow({ where: { email: 'commercial-browser@vnx03.invalid' } });
  const item = await db.commercialLeadInboxItem.findUniqueOrThrow({
    where: { leadId: lead.id }, include: { slaCycles: true, activities: { orderBy: { sequence: 'asc' } } },
  });
  const auditEvents = await db.auditLog.findMany({
    where: { entityType: 'CommercialLeadInboxItem', entityId: item.id },
    orderBy: { createdAt: 'asc' }, select: { event: true },
  });
  assert.equal(item.originKind, 'BUSINESS_PROJECTION_N13');
  assert.equal(item.projectionLedgerId !== null, true);
  assert.equal(item.slaCycles.length, 1);
  assert.equal(item.slaCycles[0]?.dueAt.getTime(), item.slaCycles[0]!.availableAt.getTime() + 86_400_000);
  if (checkpoint === 'projected') {
    assert.equal(lead.assignedToId, null);
    assert.equal(item.version, 1);
    assert.deepEqual(item.activities.map((row) => row.activityType), ['INITIALIZED']);
    assert.deepEqual(auditEvents.map((row) => row.event), ['commercial_lead_inbox_initialized']);
    assert.equal(item.slaCycles[0]?.firstResponseAt, null);
  } else if (checkpoint === 'claimed') {
    assert.equal(lead.assignedToId, 'vnx03-n14-commercial-one');
    assert.equal(item.version, 2);
    assert.deepEqual(item.activities.map((row) => row.activityType), ['INITIALIZED', 'CLAIMED']);
    assert.deepEqual(auditEvents.map((row) => row.event), [
      'commercial_lead_inbox_initialized', 'commercial_lead_inbox_claimed',
    ]);
    assert.equal(item.activities[1]?.actorSessionId !== null, true);
  } else if (checkpoint === 'contacted') {
    assert.equal(lead.assignedToId, 'vnx03-n14-commercial-one');
    assert.equal(item.version, 3);
    assert.deepEqual(item.activities.map((row) => row.activityType), ['INITIALIZED', 'CLAIMED', 'FIRST_RESPONSE_RECORDED']);
    assert.deepEqual(auditEvents.map((row) => row.event), [
      'commercial_lead_inbox_initialized', 'commercial_lead_inbox_claimed',
      'commercial_lead_inbox_first_response_recorded',
    ]);
    assert.equal(item.slaCycles[0]?.outcome, 'MET');
    assert.equal(item.slaCycles[0]?.firstResponseAt !== null, true);
  } else throw new Error('VNX03_N14_CHECKPOINT_INVALID');
  assert.equal(await db.communicationIntentRecord.count(), 0);
  assert.equal(await db.communicationHeldDecision.count(), 0);
  assert.equal(await db.communicationIntentAudit.count(), 0);
  process.stdout.write(`${JSON.stringify({ checkpoint, n14: true })}\n`);
}

void main().catch(() => {
  process.stderr.write('VNX03_N14_ASSERT_FAILED\n');
  process.exitCode = 1;
}).finally(async () => db.$disconnect());
