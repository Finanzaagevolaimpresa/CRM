import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { syntheticPerson } from '../selective-sharing/fixtures';
import { collectionKey } from '../payment-collection/fixture';
import { syntheticIntakeFixture } from './fixture';
import { createSyntheticNewsletterRuntime, SYNTHETIC_NEWSLETTER_KEY } from '../../src/lib/workflow-newsletter-test-runtime';
import { MarketingPreferences } from '../../src/lib/marketing-preferences/service';
import { emailContactKey } from '../../src/lib/marketing-preferences/policy';
import { marketingWithdrawalHandlers, withdrawalBudgetNamespace, withdrawalBudgetLimit } from '../../src/lib/workflow-marketing-withdrawal';

const db = new PrismaClient(), otherDb = new PrismaClient(), enabled = process.env.RUN_DB_TESTS === '1';
let epoch: string, intake: Awaited<ReturnType<typeof syntheticIntakeFixture>>;
let preferences: MarketingPreferences, oldMode: string | undefined, oldNative: string | undefined;
const origin = 'https://example.test';
const credential = async () => ({ key: Buffer.from(SYNTHETIC_NEWSLETTER_KEY), epoch, publicOrigin: origin,
  unsubscribeUrl: origin + '/preferenze-email', keyFingerprint: createHash('sha256').update(SYNTHETIC_NEWSLETTER_KEY).digest('hex') });
const handlers = marketingWithdrawalHandlers(db, credential);
const request = (email: string, requestId: string = randomUUID(), requestOrigin = origin) => new Request(origin + '/preferenze-email', {
  method: 'POST', headers: { origin: requestOrigin, 'content-type': 'application/json' }, body: JSON.stringify({ email, requestId }) });

before(async () => {
  if (!enabled) return;
  await assertAiOrchestratorEphemeralDatabaseIdentity(db); assert.equal(process.env.APP_ENV, 'test'); await collectionKey(db);
  oldMode = process.env.WORKFLOW_MARKETING_WITHDRAWAL_MODE; oldNative = process.env.WORKFLOW_NATIVE_PREPARATION_MODE;
  process.env.WORKFLOW_MARKETING_WITHDRAWAL_MODE = 'enabled'; process.env.WORKFLOW_NATIVE_PREPARATION_MODE = 'disabled';
  const admin = await syntheticPerson(db, 'Admin preferenze soltanto sintetiche', 'admin');
  intake = await syntheticIntakeFixture(db, admin.user.id);
  await db.$executeRaw`INSERT INTO "MarketingPreferenceEpoch" (singleton,epoch,reconciled) VALUES (true,${randomUUID()}::uuid,true) ON CONFLICT (singleton) DO NOTHING`;
  epoch = (await db.$queryRaw<Array<{ epoch: string }>>`SELECT epoch FROM "MarketingPreferenceEpoch" WHERE singleton=true`)[0].epoch;
  preferences = (await createSyntheticNewsletterRuntime(db)).preferences as MarketingPreferences;
});
after(async () => {
  if (enabled) {
    if (oldMode === undefined) delete process.env.WORKFLOW_MARKETING_WITHDRAWAL_MODE; else process.env.WORKFLOW_MARKETING_WITHDRAWAL_MODE = oldMode;
    if (oldNative === undefined) delete process.env.WORKFLOW_NATIVE_PREPARATION_MODE; else process.env.WORKFLOW_NATIVE_PREPARATION_MODE = oldNative;
  }
  await Promise.all([db.$disconnect(), otherDb.$disconnect()]);
});

test('public opt-out persists once for known and unknown email while native sending is disabled', { skip: !enabled }, async () => {
  const acquired = await intake.receive(false, 'GRANTED');
  const evidence = await db.privacyEvidenceReceipt.findFirstOrThrow({ where: { businessInboxEventId: acquired.receipt.inboxEventId, purposeCode: 'DIRECT_MARKETING' } });
  await preferences.recordChoice(evidence.id, intake.marketingNoticeText);
  const email = acquired.event.payload.email!;
  assert.equal((await preferences.select(email)).decision.eligible, true);
  const screen = await handlers.GET(new Request(origin + '/preferenze-email'));
  assert.equal(screen.status, 200); assert.equal(screen.headers.get('cache-control'), 'no-store');
  const html = await screen.text();
  assert.match(html, /method="post" action="\/preferenze-email"/); assert(!html.includes(email));
  assert.match(html, /Non inviarmi più email promozionali/); assert(!html.includes('/notifications'));
  const requestId = /name="requestId" value="([a-f0-9-]+)"/.exec(html)![1];
  const response = await handlers.POST(request(email, requestId));
  assert.equal(response.status, 200);
  const publicResult = await response.text();
  assert.equal((await handlers.POST(request(email, requestId))).status, 200);
  const unknown = `unknown-${randomUUID()}@example.invalid`;
  const unknownResponse = await handlers.POST(request(unknown));
  assert.equal(unknownResponse.status, 200); assert.equal(await unknownResponse.text(), publicResult);
  const key = emailContactKey(email, SYNTHETIC_NEWSLETTER_KEY);
  const [row] = await db.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) FROM "MarketingPreferenceEvent" WHERE "contactKey"=${key} AND payload->>'kind'='SUPPRESSED'`;
  assert.equal(row.count, 1n);
  assert.equal((await preferences.select(email)).decision.reason, 'SUPPRESSED');
  assert.equal((await preferences.select(unknown)).decision.reason, 'SUPPRESSED');
});

test('wrong origin, invalid input and mismatched reconciliation epoch cannot attest a withdrawal', { skip: !enabled }, async () => {
  const email = `denied-${randomUUID()}@example.invalid`, key = emailContactKey(email, SYNTHETIC_NEWSLETTER_KEY);
  assert.equal((await handlers.POST(request(email, randomUUID(), 'https://attacker.invalid'))).status, 403);
  assert.equal((await handlers.POST(new Request(origin + '/preferenze-email', { method: 'POST',
    headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ email, requestId: randomUUID(), admin: true }) }))).status, 400);
  const stale = marketingWithdrawalHandlers(db, async () => ({ ...await credential(), epoch: randomUUID() }));
  assert.equal((await stale.POST(request(email))).status, 503);
  assert.equal((await stale.GET(new Request(origin + '/preferenze-email'))).status, 503);
  const [row] = await db.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) FROM "MarketingPreferenceEvent" WHERE "contactKey"=${key}`;
  assert.equal(row.count, 0n);
});

test('separate HTTP runtimes share a bounded request budget without touching the lead intake bucket', { skip: !enabled }, async () => {
  const before = await db.websiteLeadRateLimitBucket.findUnique({ where: { namespace: 'website-lead:legacy:v1' } });
  await db.websiteLeadRateLimitBucket.upsert({ where: { namespace: withdrawalBudgetNamespace },
    create: { namespace: withdrawalBudgetNamespace, callerDigest: 'public-marketing-withdrawal', windowStartedAt: new Date(), requestCount: withdrawalBudgetLimit - 1 },
    update: { windowStartedAt: new Date(), requestCount: withdrawalBudgetLimit - 1 } });
  const other = marketingWithdrawalHandlers(otherDb, credential);
  const results = await Promise.all([handlers.POST(request(`budget-a-${randomUUID()}@example.invalid`)), other.POST(request(`budget-b-${randomUUID()}@example.invalid`))]);
  assert.deepEqual(results.map(row => row.status).sort(), [200, 429]);
  await db.websiteLeadRateLimitBucket.update({ where: { namespace: withdrawalBudgetNamespace }, data: { windowStartedAt: new Date(Date.now() - 120_000) } });
  assert.equal((await other.POST(request(`budget-reset-${randomUUID()}@example.invalid`))).status, 200);
  assert.deepEqual(await db.websiteLeadRateLimitBucket.findUnique({ where: { namespace: 'website-lead:legacy:v1' } }), before);
});
