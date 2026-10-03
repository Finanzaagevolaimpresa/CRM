import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import test from 'node:test';
import { Prisma, PrismaClient } from '@prisma/client';
import { PostgresPreferenceStore } from '../../src/lib/marketing-preferences/postgres-store';
import { MarketingPreferences, type PreferenceStore } from '../../src/lib/marketing-preferences/service';
import { emailContactKey } from '../../src/lib/marketing-preferences/policy';
import { admitBusinessInboxEvent } from '../../src/lib/business-event-backbone';
import { createLeadSubmittedEventV1 } from '../../src/lib/lead-event-contract';
import { createBusinessLeadPrivacyEvidence } from '../../src/lib/privacy-evidence';
import { syntheticLeadEventInputV1 } from '../fixtures/n10-lead-event-v1';
import { EPOCH, id, readiness, SYNTHETIC_EMAIL, SYNTHETIC_KEY, SYNTHETIC_NOTICE } from '../fixtures/r13-marketing-store';
import { assertAiOrchestratorEphemeralDatabaseIdentity, assertAiOrchestratorEphemeralDbTestConfiguration } from './ai-orchestrator-db-test-guard';

// Explicit opt-in, existing loopback/test-database/sentinel guard; never an app database.
const enabled = assertAiOrchestratorEphemeralDbTestConfiguration({
  requested: process.env.RUN_R13_DB_TESTS === '1' && process.env.RUN_DB_TESTS === '1',
  destructiveConfirmed: process.env.AI_ORCHESTRATOR_DB_TESTS_CONFIRMED === '1',
  databaseUrl: process.env.DATABASE_URL, sentinel: process.env.AI_ORCHESTRATOR_DB_TEST_SENTINEL,
  appEnvironment: process.env.APP_ENV, nodeEnvironment: process.env.NODE_ENV,
});
const root = enabled ? new PrismaClient() : null;
const schema = `r13_marketing_${process.pid}_${Date.now()}`;
let db: PrismaClient | null = null;
function client() { if (!db) throw new Error('R13_EPHEMERAL_DB_UNAVAILABLE'); return db; }
const service = () => new MarketingPreferences(new PostgresPreferenceStore(client()), SYNTHETIC_KEY, async () => null);

test.before(async () => {
  if (!enabled || !root) return;
  await assertAiOrchestratorEphemeralDatabaseIdentity(root);
  const url = new URL(process.env.DATABASE_URL!); url.searchParams.set('schema', schema);
  await root.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  const prisma = resolve('node_modules/prisma/build/index.js');
  const env = { ...process.env, DATABASE_URL: url.toString() };
  execFileSync(process.execPath, [prisma, 'migrate', 'deploy'], { env, stdio: 'pipe' });
  execFileSync(process.execPath, [prisma, 'db', 'execute', '--file', 'prisma/proposals/r13-marketing-preferences/migration.sql', '--schema', 'prisma/schema.prisma'], { env, stdio: 'pipe' });
  db = new PrismaClient({ datasources: { db: { url: url.toString() } } });
});
test.after(async () => {
  await db?.$disconnect();
  if (enabled && root) await root.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
  await root?.$disconnect();
});

test('R13 proposal creates empty ledgers without advancing the operational migration chain', { skip: !enabled }, async () => {
  const [row] = await client().$queryRaw<Array<{ migrations: number; subjects: number; events: number; epochs: number }>>(Prisma.sql`
    SELECT (SELECT count(*)::INT FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL) AS migrations,
      (SELECT count(*)::INT FROM "MarketingPreferenceSubject") AS subjects,
      (SELECT count(*)::INT FROM "MarketingPreferenceEvent") AS events,
      (SELECT count(*)::INT FROM "MarketingPreferenceEpoch") AS epochs
  `);
  assert.deepEqual(row, { migrations: 49, subjects: 0, events: 0, epochs: 0 });
});

test('SQL persists an anonymous block atomically and denies replay mutation and direct ledger rewriting', { skip: !enabled }, async () => {
  const before = await client().lead.count();
  assert.equal(await service().suppressPublic(SYNTHETIC_EMAIL, id(2)), 'RECORDED');
  assert.equal(await service().suppressPublic(SYNTHETIC_EMAIL, id(2)), 'REPLAY');
  const key = emailContactKey(SYNTHETIC_EMAIL, SYNTHETIC_KEY);
  const [row] = await client().$queryRaw<Array<{ revision: number; count: number }>>(Prisma.sql`
    SELECT subject."revision", count(event."eventId")::INT AS count FROM "MarketingPreferenceSubject" subject
    JOIN "MarketingPreferenceEvent" event USING ("contactKey") WHERE subject."contactKey" = ${key} GROUP BY subject."revision"
  `);
  assert.deepEqual(row, { revision: 1, count: 1 }); assert.equal(await client().lead.count(), before);
  await assert.rejects(client().$executeRaw(Prisma.sql`UPDATE "MarketingPreferenceEvent" SET "eventHash" = ${'0'.repeat(64)} WHERE "contactKey" = ${key}`));
  await assert.rejects(client().$executeRaw(Prisma.sql`DELETE FROM "MarketingPreferenceEvent" WHERE "contactKey" = ${key}`));
  await assert.rejects(client().$executeRaw(Prisma.sql`UPDATE "MarketingPreferenceSubject" SET "revision" = 0 WHERE "contactKey" = ${key}`));
  await assert.rejects(client().$executeRaw(Prisma.sql`TRUNCATE "MarketingPreferenceEvent"`));
  assert.equal((await service().select(SYNTHETIC_EMAIL)).ticket, null);
});

test('SQL rolls back both request and subject when persistence fails before commit', { skip: !enabled }, async () => {
  const store = new PostgresPreferenceStore(client());
  const failing: PreferenceStore = {
    verifiedChoice: (receiptId, text) => store.verifiedChoice(receiptId, text),
    withContact: (key, operation) => store.withContact(key, async tx => {
      await operation(tx); throw new Error('R13_SYNTHETIC_FAILURE_BEFORE_COMMIT');
    }),
  };
  const email = 'rollback@r13.invalid';
  await assert.rejects(new MarketingPreferences(failing, SYNTHETIC_KEY, async () => null).suppressPublic(email, id(3)));
  const [row] = await client().$queryRaw<Array<{ count: number }>>(Prisma.sql`
    SELECT count(*)::INT AS count FROM "MarketingPreferenceSubject" WHERE "contactKey" = ${emailContactKey(email, SYNTHETIC_KEY)}
  `);
  assert.equal(row.count, 0);
});

test('SQL concurrent duplicates produce one event; serialization losers can retry safely', { skip: !enabled }, async () => {
  const email = 'concurrent@r13.invalid';
  const results = await Promise.allSettled([service().suppressPublic(email, id(4)), service().suppressPublic(email, id(4))]);
  assert.ok(results.some(result => result.status === 'fulfilled'));
  assert.equal(await service().suppressPublic(email, id(4)), 'REPLAY');
  const [row] = await client().$queryRaw<Array<{ count: number }>>(Prisma.sql`
    SELECT count(*)::INT AS count FROM "MarketingPreferenceEvent" WHERE "contactKey" = ${emailContactKey(email, SYNTHETIC_KEY)}
  `);
  assert.equal(row.count, 1);
});

async function persistedSyntheticChoice(ordinal: number, decision: 'GRANTED' | 'DENIED') {
  const database = client();
  const [clock] = await database.$queryRaw<Array<{ now: Date }>>(Prisma.sql`SELECT clock_timestamp() AS "now"`);
  const occurredAt = new Date(clock.now.getTime() - 1000).toISOString();
  const base = syntheticLeadEventInputV1();
  const email = `persisted-${ordinal}@r13.invalid`;
  const noticeVersionId = id(900 + ordinal);
  const event = createLeadSubmittedEventV1({
    ...base, eventId: id(1000 + ordinal), businessCorrelationId: id(2000 + ordinal), occurredAt,
    source: { ...base.source, submissionId: `R13-DB-SYNTHETIC-${ordinal}` },
    payload: { ...base.payload, email },
    privacy: {
      service: { ...base.privacy.service, noticeCode: `R13_SYNTHETIC_SERVICE_${ordinal}` },
      marketing: { ...base.privacy.marketing, noticeCode: `R13_SYNTHETIC_MARKETING_${ordinal}`, decision },
    },
  });
  const noticeHash = createHash('sha256').update(SYNTHETIC_NOTICE).digest('hex');
  await database.privacyNoticeVersion.createMany({ data: [
    { id: id(800 + ordinal), noticeCode: event.privacy.service.noticeCode, noticeVersion: 'v1',
      purposeCode: 'SERVICE_REQUEST_FOLLOW_UP', legalBasisCode: 'PRE_CONTRACTUAL_MEASURES',
      evidenceKind: 'NOTICE_ACKNOWLEDGEMENT', contentHash: '1'.repeat(64) },
    { id: noticeVersionId, noticeCode: event.privacy.marketing.noticeCode, noticeVersion: 'v1',
      purposeCode: 'DIRECT_MARKETING', legalBasisCode: 'CONSENT', evidenceKind: 'CONSENT', contentHash: noticeHash },
  ] });
  await database.privacyNoticeVersion.updateMany({
    where: { id: { in: [id(800 + ordinal), noticeVersionId] }, status: 'DRAFT' },
    data: { status: 'ACTIVE', effectiveFrom: new Date(clock.now.getTime() - 60_000) },
  });
  const admitted = await admitBusinessInboxEvent(database, event);
  await database.$transaction(tx => createBusinessLeadPrivacyEvidence(tx, {
    businessInboxEventId: admitted.inboxEventId, event,
  }));
  const receipt = await database.privacyEvidenceReceipt.findFirstOrThrow({
    where: { businessInboxEventId: admitted.inboxEventId, purposeCode: 'DIRECT_MARKETING' },
  });
  return { email, receipt, noticeVersionId, noticeHash, occurredAt };
}

test('SQL binds GRANTED and DENIED to persisted immutable N04 receipts without creating a lead', { skip: !enabled }, async () => {
  const leadCount = await client().lead.count();
  for (const [ordinal, decision] of [[101, 'GRANTED'], [102, 'DENIED']] as const) {
    const source = await persistedSyntheticChoice(ordinal, decision);
    const store = new PostgresPreferenceStore(client());
    const verified = await store.verifiedChoice(source.receipt.id, SYNTHETIC_NOTICE);
    assert.equal(verified.email, source.email); assert.equal(verified.kind, decision);
    assert.equal(verified.occurredAt, source.occurredAt);
    assert.equal(await service().recordChoice(source.receipt.id, SYNTHETIC_NOTICE), 'RECORDED');
    assert.equal(await service().recordChoice(source.receipt.id, SYNTHETIC_NOTICE), 'REPLAY');
    const snapshot = await store.withContact(emailContactKey(source.email, SYNTHETIC_KEY), tx => tx.snapshot());
    assert.equal(snapshot.events.length, 1); assert.equal(snapshot.events[0].kind, decision);
    assert.equal(snapshot.events[0].canonicalNoticeText, SYNTHETIC_NOTICE);
    assert.deepEqual(await client().privacyEvidenceReceipt.findUniqueOrThrow({ where: { id: source.receipt.id } }), source.receipt);
  }
  assert.equal(await client().lead.count(), leadCount);
});

test('SQL refuses an altered notice and a preference decision that contradicts its persisted receipt', { skip: !enabled }, async () => {
  const source = await persistedSyntheticChoice(103, 'GRANTED');
  const store = new PostgresPreferenceStore(client());
  await assert.rejects(store.verifiedChoice(source.receipt.id, SYNTHETIC_NOTICE + ' altered'));
  const key = emailContactKey(source.email, SYNTHETIC_KEY);
  await assert.rejects(store.withContact(key, tx => tx.append({
    contactKey: key, eventId: source.receipt.id, kind: 'DENIED', occurredAt: source.occurredAt,
    source: 'Q05_RECEIPT', operatorRef: null, outcome: 'PROMOTIONAL_BLOCKED',
    receiptId: source.receipt.id, noticeVersionId: source.noticeVersionId,
    noticeHash: source.noticeHash, canonicalNoticeText: SYNTHETIC_NOTICE,
  })));
  const [row] = await client().$queryRaw<Array<{ count: number }>>(Prisma.sql`
    SELECT count(*)::INT AS count FROM "MarketingPreferenceSubject" WHERE "contactKey" = ${key}
  `);
  assert.equal(row.count, 0);
  await assert.rejects(client().privacyEvidenceReceipt.update({
    where: { id: source.receipt.id }, data: { decision: 'DENIED' },
  }));
  assert.deepEqual(await client().privacyEvidenceReceipt.findUniqueOrThrow({ where: { id: source.receipt.id } }), source.receipt);
});

test('SQL public suppression invalidates a previously eligible selection before the final callback', { skip: !enabled }, async () => {
  const source = await persistedSyntheticChoice(104, 'GRANTED');
  await client().$executeRaw(Prisma.sql`
    INSERT INTO "MarketingPreferenceEpoch" ("singleton", "epoch", "reconciled") VALUES (true, ${EPOCH}::UUID, true)
  `);
  const qualifiedSynthetic = new MarketingPreferences(new PostgresPreferenceStore(client()), SYNTHETIC_KEY, async () => {
    const [clock] = await client().$queryRaw<Array<{ now: Date }>>(Prisma.sql`SELECT clock_timestamp() AS "now"`);
    return { ...readiness(), checkedAt: clock.now.toISOString(),
      approvedEmailNotices: [{ noticeVersionId: source.noticeVersionId, contentHash: source.noticeHash }] };
  });
  await qualifiedSynthetic.recordChoice(source.receipt.id, SYNTHETIC_NOTICE);
  const selection = await qualifiedSynthetic.select(source.email);
  assert.equal(selection.decision.eligible, true); assert.ok(selection.ticket);
  await qualifiedSynthetic.suppressPublic(source.email, id(450));
  let callbackCount = 0;
  const result = await qualifiedSynthetic.atFinalHandoff(source.email, selection.ticket, async () => ++callbackCount);
  assert.equal(result.admitted, false); assert.equal(callbackCount, 0);
  assert.equal((await qualifiedSynthetic.select(source.email)).decision.eligible, false);
  assert.deepEqual(await client().privacyEvidenceReceipt.findUniqueOrThrow({ where: { id: source.receipt.id } }), source.receipt);
});
