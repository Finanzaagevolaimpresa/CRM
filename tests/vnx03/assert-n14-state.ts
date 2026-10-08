import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { parseLeadSubmittedEventV1 } from '../../src/lib/lead-event-contract';
import { responsibilityAcceptance, responsibilityDecision } from '../../src/lib/responsibility-contract';

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
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  assert.equal(item.originKind, 'BUSINESS_PROJECTION_N13');
  assert.equal(item.projectionLedgerId !== null, true);
  const ledger = await db.leadProjectionLedger.findUniqueOrThrow({
    where: { id: item.projectionLedgerId! },
    include: { inboxEvent: { include: {
      secureLeadGatewayReceipt: { include: { requests: true } },
      privacyEvidence: { include: { noticeVersion: true }, orderBy: { purposeCode: 'asc' } },
    } } },
  });
  const inbox = ledger.inboxEvent, receipt = inbox.secureLeadGatewayReceipt;
  const event = parseLeadSubmittedEventV1(JSON.parse(inbox.envelopeJson));
  assert.equal(ledger.leadId, lead.id);
  assert.equal(ledger.state, 'PROJECTED_NEW');
  assert.equal(inbox.state, 'PROCESSED');
  assert.equal(inbox.attemptCount, 1);
  assert.ok(receipt);
  assert.equal(receipt.requests.length, 1);
  assert.equal(receipt.inboxEventId, inbox.id);
  assert.equal(event.payload.email, lead.email);
  assert.equal(lead.source, 'N10:WORDPRESS:VNX03_SYNTHETIC_WPFORMS:v1');
  assert.deepEqual([item.sourceSystem, item.formCode, item.formVersion],
    [event.source.systemCode, event.source.formCode, event.source.formVersion]);
  assert.equal(event.idempotency.keyDigest, inbox.keyDigest);
  assert.equal(event.idempotency.payloadHash, inbox.payloadHash);
  assert.deepEqual(inbox.privacyEvidence.map(({ purposeCode, decision }) => ({ purposeCode, decision })), [
    { purposeCode: 'DIRECT_MARKETING', decision: 'DENIED' },
    { purposeCode: 'SERVICE_REQUEST_FOLLOW_UP', decision: 'ACKNOWLEDGED' },
  ]);
  for (const evidence of inbox.privacyEvidence) {
    const declared = evidence.purposeCode === 'DIRECT_MARKETING' ? event.privacy.marketing : event.privacy.service;
    assert.equal(evidence.noticeVersion.noticeCode, declared.noticeCode);
    assert.equal(evidence.noticeVersion.noticeVersion, declared.noticeVersion);
    assert.equal(evidence.sourceSystem, event.source.systemCode);
    assert.equal(evidence.formCode, event.source.formCode);
    assert.equal(evidence.formVersion, event.source.formVersion);
  }
  assert.equal(item.privacyEvidenceReceiptId,
    inbox.privacyEvidence.find(({ purposeCode }) => purposeCode === 'SERVICE_REQUEST_FOLLOW_UP')!.id);
  const leadAudits = await db.auditLog.findMany({
    where: { entityType: 'Lead', entityId: lead.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const decisions = leadAudits.filter(({ event }) => event === 'responsibility_assigned');
  const accepted = leadAudits.filter(({ event }) => event === 'responsibility_accepted');
  assert.equal(decisions.length, checkpoint === 'projected' ? 0 : 1);
  if (decisions.length) {
    const decision = responsibilityDecision.parse(decisions[0]!.after);
    assert.equal(decisions[0]!.actorId, 'vnx03-n14-admin');
    assert.equal(decision.allowed, true);
    assert.equal(decision.state.commercialOwnerId, lead.assignedToId);
    assert.equal(decision.version, 1);
  }
  assert.equal(accepted.length, ['accepted', 'scheduled'].includes(checkpoint ?? '') ? 1 : 0);
  if (accepted.length) {
    const acceptance = responsibilityAcceptance.parse(accepted[0]!.after);
    assert.equal(accepted[0]!.actorId, lead.assignedToId);
    assert.equal(acceptance.userId, lead.assignedToId);
    assert.equal(acceptance.decisionId, decisions[0]!.id);
    assert.equal(acceptance.role, 'commerciale');
    assert.ok(accepted[0]!.createdAt >= decisions[0]!.createdAt);
  }
  assert.equal(item.slaCycles.length, 1);
  assert.equal(item.slaCycles[0]?.dueAt.getTime(), item.slaCycles[0]!.availableAt.getTime() + 86_400_000);
  if (checkpoint === 'projected') {
    assert.equal(lead.assignedToId, null);
    assert.equal(item.version, 1);
    assert.deepEqual(item.activities.map((row) => row.activityType), ['INITIALIZED']);
    assert.deepEqual(auditEvents.map((row) => row.event), ['commercial_lead_inbox_initialized']);
    assert.equal(item.slaCycles[0]?.firstResponseAt, null);
  } else if (checkpoint === 'assigned') {
    assert.equal(lead.assignedToId, 'vnx03-n14-commercial-one');
    assert.equal(item.version, 2);
    assert.deepEqual(item.activities.map((row) => row.activityType), ['INITIALIZED', 'ASSIGNED']);
    assert.deepEqual(auditEvents.map((row) => row.event), [
      'commercial_lead_inbox_initialized', 'commercial_lead_inbox_assigned',
    ]);
    assert.equal(item.activities[1]?.actorSessionId !== null, true);
  } else if (checkpoint === 'contacted' || checkpoint === 'accepted' || checkpoint === 'scheduled') {
    assert.equal(lead.assignedToId, 'vnx03-n14-commercial-one');
    assert.equal(item.version, 3);
    assert.deepEqual(item.activities.map((row) => row.activityType), ['INITIALIZED', 'ASSIGNED', 'FIRST_RESPONSE_RECORDED']);
    assert.deepEqual(auditEvents.map((row) => row.event), [
      'commercial_lead_inbox_initialized', 'commercial_lead_inbox_assigned',
      'commercial_lead_inbox_first_response_recorded',
    ]);
    assert.equal(item.slaCycles[0]?.outcome, 'MET');
    assert.equal(item.slaCycles[0]?.firstResponseAt !== null, true);
  } else throw new Error('VNX03_N14_CHECKPOINT_INVALID');
  const updates = leadAudits.filter(({ event }) => event === 'lead_update');
  if (checkpoint === 'scheduled') {
    assert.equal(lead.nextActionNote, 'PRELANCIO02 synthetic follow-up');
    assert.equal(lead.nextActionDate?.toISOString(), '2030-10-15T10:30:00.000Z');
    assert.equal(lead.nextAction?.toISOString(), lead.nextActionDate?.toISOString());
    assert.equal(updates.length, 1);
    assert.equal(updates[0]!.actorId, lead.assignedToId);
    assert.ok(updates[0]!.createdAt >= accepted[0]!.createdAt);
  } else {
    assert.equal(lead.nextActionDate, null);
    assert.equal(lead.nextActionNote, null);
    assert.equal(updates.length, 0);
  }
  assert.equal(await db.communicationIntentRecord.count(), 0);
  assert.equal(await db.communicationHeldDecision.count(), 0);
  assert.equal(await db.communicationIntentAudit.count(), 0);
  const snapshotSha256 = createHash('sha256').update(JSON.stringify(
    { lead, item, ledger, leadAudits, auditEvents },
    (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value,
  )).digest('hex');
  process.stdout.write(`${JSON.stringify({ checkpoint, n14: true, snapshotSha256 })}\n`);
}

void main().catch((error: unknown) => {
  const line = /assert-n14-state\.ts:(\d+):\d+/u.exec(error instanceof Error ? error.stack ?? '' : '')?.[1] ?? 'UNKNOWN';
  process.stderr.write(`VNX03_N14_ASSERT_FAILED:LINE_${line}\n`);
  process.exitCode = 1;
}).finally(async () => db.$disconnect());
