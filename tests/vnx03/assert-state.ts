import assert from 'node:assert/strict';
import { Prisma, PrismaClient } from '@prisma/client';
import { canonicalJson } from '../../src/lib/canonical-json';
import {
  parseLeadSubmittedEventV1,
  type LeadSubmittedEventV1,
} from '../../src/lib/lead-event-contract';

const DATABASE_SENTINEL = 'FAI_CRM_VNX03_EPHEMERAL_TEST_ONLY_V1';
const db = new PrismaClient();

const expectedEvents = Object.freeze({
  granted: Object.freeze({
    email: 'granted@vnx03.invalid',
    firstName: 'Giulia',
    lastName: 'Sintetica',
    companyName: 'VNX03 Granted',
    phone: '+390212345678',
    requestedMinorUnits: 12_500_050,
    marketing: 'GRANTED' as const,
  }),
  denied: Object.freeze({
    email: 'denied@vnx03.invalid',
    firstName: 'Marco',
    lastName: 'Negato',
    companyName: 'VNX03 Denied',
    phone: '+390298765432',
    requestedMinorUnits: 8_000_000,
    marketing: 'DENIED' as const,
  }),
});

type ExpectedEvent = (typeof expectedEvents)[keyof typeof expectedEvents];

type ExpectedCounts = Readonly<{
  inbox: number;
  receipts: number;
  requests: number;
  leads: number;
  ledgers: number;
  privacy: number;
  attempts: number;
}>;

const checkpoints: Readonly<Record<string, ExpectedCounts>> = Object.freeze({
  empty: Object.freeze({
    inbox: 0, receipts: 0, requests: 0, leads: 0, ledgers: 0, privacy: 0, attempts: 0,
  }),
  after_granted_admission: Object.freeze({
    inbox: 1, receipts: 1, requests: 1, leads: 0, ledgers: 0, privacy: 0, attempts: 0,
  }),
  after_granted_projection: Object.freeze({
    inbox: 1, receipts: 1, requests: 1, leads: 1, ledgers: 1, privacy: 2, attempts: 1,
  }),
  after_lost_response: Object.freeze({
    inbox: 2, receipts: 2, requests: 2, leads: 1, ledgers: 1, privacy: 2, attempts: 1,
  }),
  after_retry: Object.freeze({
    inbox: 2, receipts: 2, requests: 3, leads: 1, ledgers: 1, privacy: 2, attempts: 1,
  }),
  after_denied_projection: Object.freeze({
    inbox: 2, receipts: 2, requests: 3, leads: 2, ledgers: 2, privacy: 4, attempts: 2,
  }),
  security_negatives: Object.freeze({
    inbox: 2, receipts: 2, requests: 3, leads: 2, ledgers: 2, privacy: 4, attempts: 2,
  }),
});

async function databaseIdentity() {
  const rows = await db.$queryRaw<Array<{ database: string; comment: string | null }>>(Prisma.sql`
    SELECT current_database() AS database,
      shobj_description(oid, 'pg_database') AS comment
    FROM pg_database
    WHERE datname = current_database()
  `);
  assert.deepEqual(rows, [{ database: 'fai_vnx03_e2e', comment: DATABASE_SENTINEL }]);
  const migrations = await db.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
    SELECT COUNT(*)::BIGINT AS count
    FROM "_prisma_migrations"
    WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL
  `);
  assert.equal(Number(migrations[0]?.count), 43);
}

function verifyEnvelope(raw: string, expected: ExpectedEvent): LeadSubmittedEventV1 {
  const parsed = parseLeadSubmittedEventV1(JSON.parse(raw) as unknown);
  assert.equal(canonicalJson(parsed), raw);
  assert.equal(parsed.source.systemCode, 'WORDPRESS');
  assert.equal(parsed.source.formCode, 'VNX03_SYNTHETIC_WPFORMS');
  assert.equal(parsed.source.formVersion, 'v1');
  assert.match(parsed.source.submissionId, /^WPFORM:900001:EPHEMERAL:[0-9a-f]{32}$/u);
  assert.equal(parsed.payload.email, expected.email);
  assert.equal(parsed.payload.firstName, expected.firstName);
  assert.equal(parsed.payload.lastName, expected.lastName);
  assert.equal(parsed.payload.companyName, expected.companyName);
  assert.equal(parsed.payload.phone, expected.phone);
  assert.equal(parsed.payload.requestedAmount?.currency, 'EUR');
  assert.equal(parsed.payload.requestedAmount?.minorUnits, expected.requestedMinorUnits);
  assert.equal(parsed.privacy.service.decision, 'ACKNOWLEDGED');
  assert.equal(parsed.privacy.marketing.decision, expected.marketing);
  return parsed;
}

async function verifyBusinessEvents(checkpoint: string) {
  const rows = await db.businessInboxEvent.findMany({ orderBy: { createdAt: 'asc' } });
  const parsed = rows.map((row) => ({ row, event: parseLeadSubmittedEventV1(JSON.parse(row.envelopeJson)) }));
  const granted = parsed.find(({ event }) => event.payload.email === expectedEvents.granted.email);
  const denied = parsed.find(({ event }) => event.payload.email === expectedEvents.denied.email);

  if (rows.length >= 1) {
    assert.ok(granted);
    const verified = verifyEnvelope(granted.row.envelopeJson, expectedEvents.granted);
    assert.equal(verified.idempotency.keyDigest, granted.row.keyDigest);
    assert.equal(verified.idempotency.payloadHash, granted.row.payloadHash);
  }
  if (rows.length >= 2) {
    assert.ok(denied);
    const verified = verifyEnvelope(denied.row.envelopeJson, expectedEvents.denied);
    assert.equal(verified.idempotency.keyDigest, denied.row.keyDigest);
    assert.equal(verified.idempotency.payloadHash, denied.row.payloadHash);
  }
  if (checkpoint === 'after_granted_admission') {
    assert.equal(granted?.row.state, 'AVAILABLE');
  }
  if (['after_granted_projection', 'after_lost_response', 'after_retry'].includes(checkpoint)) {
    assert.equal(granted?.row.state, 'PROCESSED');
  }
  if (checkpoint === 'after_lost_response' || checkpoint === 'after_retry') {
    assert.equal(denied?.row.state, 'AVAILABLE');
  }
  if (checkpoint === 'after_denied_projection' || checkpoint === 'security_negatives') {
    assert.deepEqual(rows.map(({ state }) => state), ['PROCESSED', 'PROCESSED']);
  }
}

async function verifyProjection(checkpoint: string) {
  const expectedProjected = checkpoint === 'after_granted_projection'
    || checkpoint === 'after_lost_response'
    || checkpoint === 'after_retry'
    ? [expectedEvents.granted]
    : checkpoint === 'after_denied_projection' || checkpoint === 'security_negatives'
      ? [expectedEvents.granted, expectedEvents.denied]
      : [];

  const leads = await db.lead.findMany({ orderBy: { createdAt: 'asc' } });
  assert.equal(leads.length, expectedProjected.length);
  for (const expected of expectedProjected) {
    const lead = leads.find(({ email }) => email === expected.email);
    assert.ok(lead);
    assert.equal(lead.firstName, expected.firstName);
    assert.equal(lead.lastName, expected.lastName);
    assert.equal(lead.companyName, expected.companyName);
    assert.equal(lead.phone, expected.phone);
    assert.equal(lead.source, 'N10:WORDPRESS:VNX03_SYNTHETIC_WPFORMS:v1');
    assert.equal(lead.requestedAmount?.mul(100).toNumber(), expected.requestedMinorUnits);

    const evidence = await db.privacyEvidenceReceipt.findMany({
      where: { leadId: lead.id },
      orderBy: { purposeCode: 'asc' },
      select: { purposeCode: true, evidenceKind: true, decision: true },
    });
    assert.deepEqual(evidence, [
      { purposeCode: 'DIRECT_MARKETING', evidenceKind: 'CONSENT', decision: expected.marketing },
      {
        purposeCode: 'SERVICE_REQUEST_FOLLOW_UP',
        evidenceKind: 'NOTICE_ACKNOWLEDGEMENT',
        decision: 'ACKNOWLEDGED',
      },
    ]);
  }
}

async function verifyReceiptReplay(checkpoint: string) {
  if (!['after_lost_response', 'after_retry', 'after_denied_projection', 'security_negatives'].includes(checkpoint)) {
    return;
  }
  const receipts = await db.secureLeadGatewayReceipt.findMany({
    include: { inboxEvent: true, requests: true },
  });
  const deniedReceipt = receipts.find(({ inboxEvent }) => {
    const event = parseLeadSubmittedEventV1(JSON.parse(inboxEvent.envelopeJson));
    return event.payload.email === expectedEvents.denied.email;
  });
  assert.ok(deniedReceipt);
  const expectedRequests = checkpoint === 'after_lost_response' ? 1 : 2;
  assert.equal(deniedReceipt.requests.length, expectedRequests);
  assert.equal(new Set(deniedReceipt.requests.map(({ receiptId }) => receiptId)).size, 1);
  if (expectedRequests === 2) {
    assert.equal(
      new Set(deniedReceipt.requests.map(({ requestFingerprint }) => requestFingerprint)).size,
      2,
    );
  }
}

async function main() {
  assert.equal(process.env.VNX03_SYNTHETIC_E2E_CONFIRMED, '1');
  const checkpoint = process.env.VNX03_ASSERT_CHECKPOINT ?? '';
  const expected = checkpoints[checkpoint];
  assert.ok(expected, 'VNX03_ASSERT_CHECKPOINT_INVALID');
  await databaseIdentity();

  const counts: ExpectedCounts = {
    inbox: await db.businessInboxEvent.count(),
    receipts: await db.secureLeadGatewayReceipt.count(),
    requests: await db.secureLeadGatewayRequest.count(),
    leads: await db.lead.count(),
    ledgers: await db.leadProjectionLedger.count(),
    privacy: await db.privacyEvidenceReceipt.count(),
    attempts: await db.businessQueueAttempt.count(),
  };
  assert.deepEqual(counts, expected);
  assert.equal(await db.websiteLeadReceipt.count(), 0);
  assert.equal(await db.commercialLeadInboxItem.count(), 0);
  assert.equal(await db.commercialLeadSlaCycle.count(), 0);
  assert.equal(await db.commercialLeadActivity.count(), 0);
  assert.equal(await db.businessOutboxEvent.count(), 0);
  assert.equal(await db.secureLeadGatewayRateLimitBucket.count(), expected.requests > 0 ? 1 : 0);

  const gates = await db.applicationFeatureGate.findMany({ select: { code: true, enabled: true } });
  assert.equal(gates.find(({ code }) => code === 'INTEGRATIONS')?.enabled, true);
  for (const code of ['AI_DISPATCH', 'AI_EGRESS', 'AI_WORKER']) {
    assert.equal(gates.find((gate) => gate.code === code)?.enabled, false);
  }

  await verifyBusinessEvents(checkpoint);
  await verifyProjection(checkpoint);
  await verifyReceiptReplay(checkpoint);
  process.stdout.write(`${JSON.stringify({ checkpoint, counts, ok: true })}\n`);
}

void main()
  .catch(() => {
    process.stderr.write('VNX03_ASSERTION_FAILED\n');
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
