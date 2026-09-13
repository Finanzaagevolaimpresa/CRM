import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  admitBusinessInboxEvent, BusinessEventBackboneError, claimBusinessQueueEvent,
  completeBusinessQueueEvent, enqueueBusinessOutboxEvent, heartbeatBusinessQueueLease,
  recoverExpiredBusinessQueueLeases,
} from '../../src/lib/business-event-backbone';
import {
  createPrismaLeadIntakeConsumerOperations, runLeadIntakeConsumer,
  type LeadIntakeConsumerLogRecord,
} from '../../src/lib/lead-intake-consumer';
import {
  acquireLeadIdentityWriteLock, calculateLeadIdentityKeyDigest, LEAD_NORMALIZATION_VERSION,
} from '../../src/lib/lead-identity';
import { createLeadSubmittedEventV1, type LeadEventPayloadV1 } from '../../src/lib/lead-event-contract';
import { syntheticLeadEventInputV1 } from '../fixtures/n10-lead-event-v1';
import { N13_SYNTHETIC_KEY_SECRET, N13_SYNTHETIC_KEY_VERSION } from '../fixtures/n13-lead-projection-v1';
import {
  assertAiOrchestratorEphemeralDatabaseIdentity, assertAiOrchestratorEphemeralDbTestConfiguration,
} from './ai-orchestrator-db-test-guard';

const enabled = assertAiOrchestratorEphemeralDbTestConfiguration({
  requested: process.env.RUN_DB_TESTS === '1',
  destructiveConfirmed: process.env.AI_ORCHESTRATOR_DB_TESTS_CONFIRMED === '1',
  databaseUrl: process.env.DATABASE_URL,
  sentinel: process.env.AI_ORCHESTRATOR_DB_TEST_SENTINEL,
  appEnvironment: process.env.APP_ENV,
  nodeEnvironment: process.env.NODE_ENV,
});
const packaged = process.env.VNX05_PACKAGED_TESTS === '1';
const schema = `vnx05_synthetic_${process.pid}`;
const root = enabled ? new PrismaClient() : null;
let db: PrismaClient;
let schemaUrl: string;
let keyRoot: string;
let keyPath: string;
let schemaCreated = false;
let ordinal = 0;
const dbTest = { skip: !enabled };

function env(ids: readonly string[], overrides: Record<string, string | undefined> = {}) {
  return {
    VNX01_LEAD_INTAKE_CONSUMER_ENABLED: '1',
    VNX01_LEAD_INTAKE_LEASE_OWNER_ID: randomUUID(),
    VNX01_LEAD_INTAKE_BATCH_SIZE: '100',
    VNX01_LEAD_INTAKE_RECOVERY_BATCH_SIZE: '100',
    VNX05_LEAD_INTAKE_PILOT_ENABLED: '1',
    VNX05_LEAD_INTAKE_INBOX_EVENT_IDS: JSON.stringify(ids),
    LEAD_IDENTITY_KEY_FILE: keyPath,
    WEBSITE_LEAD_MODE: 'disabled',
    COMMERCIAL_LEAD_INBOX_MODE: 'disabled',
    ...overrides,
  };
}

function run(ids: readonly string[], overrides: Record<string, string | undefined> = {}) {
  return runLeadIntakeConsumer(createPrismaLeadIntakeConsumerOperations(db, {
    allowedSecretRoot: keyRoot,
  }), { environment: env(ids, overrides), logger() {} });
}

async function admit(payload: Partial<LeadEventPayloadV1> = {}) {
  const number = ++ordinal;
  const base = syntheticLeadEventInputV1();
  const event = createLeadSubmittedEventV1({
    ...base, eventId: randomUUID(), businessCorrelationId: randomUUID(),
    source: { ...base.source, submissionId: `VNX05-SYNTHETIC-${number}` },
    payload: {
      ...base.payload, firstName: `Synthetic${number}`, lastName: `Vnx05${number}`,
      companyName: `Synthetic VNX05 Company ${number}`, email: `synthetic-${number}@vnx05.invalid`,
      phone: `+390000${String(number).padStart(6, '0')}`, ...payload,
    },
  });
  const result = await admitBusinessInboxEvent(db, event);
  return { id: result.inboxEventId, event };
}

// No other writer runs during each before/after comparison. Include every field,
// every outside attempt (open or closed), immutable event data and OUTBOX rows.
async function outside(ids: readonly string[]) {
  return {
    inbox: await db.businessInboxEvent.findMany({ where: { id: { notIn: [...ids] } }, orderBy: { id: 'asc' } }),
    attempts: await db.businessQueueAttempt.findMany({
      where: { OR: [{ inboxEventId: null }, { inboxEventId: { notIn: [...ids] } }] }, orderBy: { id: 'asc' },
    }),
    outbox: await db.businessOutboxEvent.findMany({ orderBy: { id: 'asc' } }),
    ledgers: await db.leadProjectionLedger.findMany({ where: { inboxEventId: { notIn: [...ids] } }, orderBy: { id: 'asc' } }),
  };
}

function child(ids: readonly string[], mode = 'normal', overrides: Record<string, string | undefined> = {}) {
  const operational = packaged && mode === 'normal';
  const processChild = spawn(process.execPath, [
    '--import', 'tsx', operational ? 'scripts/vnx01-lead-intake-consumer.ts'
      : 'tests/db/vnx05-consumer-process-fixture.ts', ...(operational ? [] : [mode]),
  ], {
    env: {
      ...process.env, ...env(ids, overrides),
      DATABASE_URL: operational ? schemaUrl : process.env.DATABASE_URL,
      VNX05_TEST_SCHEMA_URL: schemaUrl, VNX05_TEST_SECRET_ROOT: keyRoot,
    }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let errors = '';
  processChild.stdout.on('data', (chunk) => { output += chunk; });
  processChild.stderr.on('data', (chunk) => { errors += chunk; });
  const result = new Promise<{ code: number | null; signal: NodeJS.Signals | null; rows: LeadIntakeConsumerLogRecord[] }>((resolveResult, reject) => {
    const timer = setTimeout(() => { processChild.kill('SIGKILL'); reject(new Error('VNX05_CHILD_TIMEOUT')); }, 15_000);
    processChild.once('error', (error) => { clearTimeout(timer); reject(error); });
    processChild.once('close', (code, signal) => {
      clearTimeout(timer);
      try {
        assert.doesNotMatch(output + errors, /@vnx05|secretBase64|postgresql|leaseToken|inboxEventIds/);
        for (const id of ids) assert.ok(!(output + errors).includes(id));
        const rows = (output + errors).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
        resolveResult({ code, signal, rows });
      } catch (error) { reject(error); }
    });
  });
  return { process: processChild, result };
}

function completed(result: Awaited<ReturnType<typeof child>['result']>) {
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  const summary = result.rows.filter((row) => row.event === 'VNX01_CONSUMER_COMPLETED').at(-1);
  assert.ok(summary && summary.event === 'VNX01_CONSUMER_COMPLETED');
  assert.equal(summary.failed, 0);
  return summary;
}

test.before(async () => {
  if (!enabled) return;
  await assertAiOrchestratorEphemeralDatabaseIdentity(root!);
  const url = new URL(process.env.DATABASE_URL!);
  url.searchParams.set('schema', schema);
  schemaUrl = url.toString();
  await root!.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  schemaCreated = true;
  assert.equal(readdirSync('prisma/migrations', { withFileTypes: true }).filter((item) => item.isDirectory()).length, 44);
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: schemaUrl }, stdio: 'pipe', timeout: 180_000,
  });
  db = new PrismaClient({ datasources: { db: { url: schemaUrl } } });
  keyRoot = packaged ? '/run/secrets' : mkdtempSync(join(tmpdir(), 'vnx05-synthetic-'));
  keyPath = join(keyRoot, `vnx05-synthetic-${process.pid}.json`);
  writeFileSync(keyPath, JSON.stringify({
    version: N13_SYNTHETIC_KEY_VERSION, secretBase64: N13_SYNTHETIC_KEY_SECRET.toString('base64'),
  }), { mode: 0o600, flag: 'wx' });
  const actor = await db.user.create({ data: {
    email: 'synthetic-admin@vnx05.invalid', name: 'Synthetic VNX05 Admin',
    passwordHash: 'synthetic-not-a-password', role: 'admin',
  } });
  const key = await db.leadIdentityKeyVersion.create({ data: {
    version: N13_SYNTHETIC_KEY_VERSION, normalizationVersion: LEAD_NORMALIZATION_VERSION,
    keyDigest: calculateLeadIdentityKeyDigest(N13_SYNTHETIC_KEY_SECRET), createdById: actor.id,
  } });
  await db.leadIdentityKeyVersion.update({ where: { id: key.id }, data: { status: 'ACTIVE', activatedAt: new Date() } });
  await db.privacyNoticeVersion.createMany({ data: [
    { noticeCode: 'SYNTHETIC_PRIVACY_NOTICE', noticeVersion: 'v1', purposeCode: 'SERVICE_REQUEST_FOLLOW_UP',
      legalBasisCode: 'PRE_CONTRACTUAL_MEASURES', evidenceKind: 'NOTICE_ACKNOWLEDGEMENT', contentHash: '1'.repeat(64) },
    { noticeCode: 'SYNTHETIC_MARKETING_NOTICE', noticeVersion: 'v1', purposeCode: 'DIRECT_MARKETING',
      legalBasisCode: 'CONSENT', evidenceKind: 'CONSENT', contentHash: '2'.repeat(64) },
  ] });
  await db.privacyNoticeVersion.updateMany({ where: { status: 'DRAFT' }, data: { status: 'ACTIVE', effectiveFrom: new Date('2026-01-01T00:00:00.000Z') } });
});

test.after(async () => {
  await db?.$disconnect();
  if (schemaCreated) {
    await assertAiOrchestratorEphemeralDatabaseIdentity(root!);
    await root!.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
  }
  await root?.$disconnect();
  if (keyPath) unlinkSync(keyPath);
  if (keyRoot && !packaged) rmSync(keyRoot, { recursive: true });
});

test('VNX-05 mixed INBOX selects only authorized rows among 100 IDs despite older foreign candidates', dbTest, async () => {
  const foreign = await admit();
  await db.$transaction((tx) => enqueueBusinessOutboxEvent(tx, {
    sourceInboxEventId: foreign.id, producerCode: 'VNX05_SYNTHETIC', destinationCode: 'SYNTHETIC_ONLY',
  }));
  assert.ok(await claimBusinessQueueEvent(db, { queueKind: 'OUTBOX', leaseOwnerId: randomUUID() }));
  const first = await admit();
  const second = await admit();
  const ids = [first.id, second.id, ...Array.from({ length: 98 }, () => randomUUID())];
  const before = await outside(ids);
  const summary = completed(await child(ids).result);
  assert.equal(summary.claimed, 2);
  assert.equal(summary.projectedNew, 2);
  assert.deepEqual(await outside(ids), before);
  assert.equal((await db.businessInboxEvent.findUniqueOrThrow({ where: { id: foreign.id } })).state, 'AVAILABLE');
  assert.equal((await run(ids)).claimed, 0);
  assert.deepEqual(await outside(ids), before);
});

test('VNX-05 unknown row IDs and envelope eventId never substitute other events', dbTest, async () => {
  const pending = await admit();
  const before = await outside([]);
  assert.equal((await run([randomUUID(), pending.event.eventId])).claimed, 0);
  assert.deepEqual(await outside([]), before);
});

test('VNX-05 invalid selections, inconsistent configuration, closed gates and key failures leave PostgreSQL unchanged', dbTest, async () => {
  const pending = await admit();
  const before = await outside([]);
  for (const overrides of [
    { VNX05_LEAD_INTAKE_INBOX_EVENT_IDS: '[]' },
    { VNX05_LEAD_INTAKE_INBOX_EVENT_IDS: '{}' },
    { VNX05_LEAD_INTAKE_INBOX_EVENT_IDS: JSON.stringify([pending.id, pending.id]) },
    { VNX05_LEAD_INTAKE_INBOX_EVENT_IDS: JSON.stringify(Array.from({ length: 101 }, () => randomUUID())) },
    { VNX05_LEAD_INTAKE_PILOT_ENABLED: '0' },
    { VNX05_LEAD_INTAKE_PILOT_ENABLED: 'true' },
    { WEBSITE_LEAD_MODE: 'legacy' },
    { LEAD_IDENTITY_KEY_FILE: join(keyRoot, 'does-not-exist.json') },
  ]) await assert.rejects(run([pending.id], overrides));
  assert.equal((await run([pending.id], { VNX01_LEAD_INTAKE_CONSUMER_ENABLED: '0' })).status, 'DISABLED');
  for (const queueKind of ['INBOX', 'OUTBOX'] as const) {
    await assert.rejects(claimBusinessQueueEvent(db, { queueKind, leaseOwnerId: randomUUID(), inboxEventIds: [] }));
    await assert.rejects(recoverExpiredBusinessQueueLeases(db, { queueKind, inboxEventIds: [] }));
  }
  const mismatch = join(keyRoot, `vnx05-mismatch-${process.pid}.json`);
  writeFileSync(mismatch, JSON.stringify({ version: N13_SYNTHETIC_KEY_VERSION + 1, secretBase64: N13_SYNTHETIC_KEY_SECRET.toString('base64') }), { mode: 0o600, flag: 'wx' });
  try { await assert.rejects(run([pending.id], { LEAD_IDENTITY_KEY_FILE: mismatch })); }
  finally { unlinkSync(mismatch); }
  assert.deepEqual(await outside([]), before);
});

test('VNX-05 overlapping and identical process selections have one claim/projection per event across replay', dbTest, async () => {
  const events = [];
  for (let i = 0; i < 5; i++) events.push(await admit());
  const ids = events.map((event) => event.id);
  const before = await outside(ids);
  const results = await Promise.all([child(ids.slice(0, 3)).result, child(ids.slice(2)).result, child(ids.slice(0, 3)).result]);
  assert.equal(results.map(completed).reduce((sum, result) => sum + result.projectedNew, 0), 5);
  assert.equal(await db.leadProjectionLedger.count({ where: { inboxEventId: { in: ids } } }), 5);
  const attempts = await db.businessQueueAttempt.findMany({ where: { inboxEventId: { in: ids } } });
  assert.equal(attempts.length, 5);
  assert.ok(attempts.every((attempt) => attempt.attemptSequence === 1 && attempt.outcome === 'PROCESSED'));
  assert.equal(completed(await child(ids).result).claimed, 0);
  assert.deepEqual(await outside(ids), before);
});

test('VNX-05 N13 considers existing Leads and retains duplicate review and privacy evidence', dbTest, async () => {
  const existing = await db.lead.create({ data: {
    firstName: 'SyntheticExisting', lastName: 'Vnx05Existing', email: 'existing@vnx05.invalid', source: 'VNX05_SYNTHETIC',
  } });
  assert.ok(existing.email);
  const existingEvent = await admit({ email: existing.email });
  const fresh = await admit({ email: 'duplicate-pair@vnx05.invalid' });
  const duplicate = await admit({ email: 'duplicate-pair@vnx05.invalid' });
  const ids = [existingEvent.id, fresh.id, duplicate.id];
  const before = await outside(ids);
  const summary = await run(ids);
  assert.equal(summary.projectedNew, 1);
  assert.equal(summary.reviewRequired, 2);
  assert.equal(summary.failed, 0);
  assert.deepEqual(await db.lead.findUniqueOrThrow({ where: { id: existing.id } }), existing);
  assert.equal(await db.leadDuplicateCandidate.count({ where: { leadId: existing.id } }), 1);
  assert.equal(await db.privacyEvidenceReceipt.count({ where: { businessInboxEventId: { in: ids } } }), 6);
  assert.equal(await db.commercialLeadInboxItem.count(), 0);
  assert.deepEqual(await outside(ids), before);
});

test('VNX-05 natural lease expiry, killed process, bounded recovery and stale fencing stay inside selection', { ...dbTest, timeout: 90_000 }, async () => {
  const foreign = await admit();
  const selected = await admit();
  const crashed = await admit();
  const foreignLease = await claimBusinessQueueEvent(db, { queueKind: 'INBOX', leaseOwnerId: randomUUID(), inboxEventIds: [foreign.id] });
  const stale = await claimBusinessQueueEvent(db, { queueKind: 'INBOX', leaseOwnerId: randomUUID(), inboxEventIds: [selected.id] });
  assert.ok(foreignLease && stale);
  assert.equal((await child([crashed.id], 'crash-after-claim').result).signal, 'SIGKILL');
  const crashedRow = await db.businessInboxEvent.findUniqueOrThrow({ where: { id: crashed.id } });
  assert.equal(crashedRow.state, 'LEASED');
  const ids = [selected.id, crashed.id];
  const before = await outside(ids);
  // Real N11 lease duration and backoff: no trigger changes, clock override or timeout extension.
  await delay(Math.max(0, crashedRow.leaseExpiresAt!.getTime() - Date.now()) + 100);
  const first = await run(ids, { VNX01_LEAD_INTAKE_RECOVERY_BATCH_SIZE: '1', VNX01_LEAD_INTAKE_BATCH_SIZE: '1' });
  assert.equal(first.recovered, 1);
  assert.equal(first.retried, 1);
  assert.equal(first.claimed, 0);
  const second = await run(ids, { VNX01_LEAD_INTAKE_RECOVERY_BATCH_SIZE: '1', VNX01_LEAD_INTAKE_BATCH_SIZE: '1' });
  assert.equal(second.recovered, 1);
  assert.equal(second.claimed, 0);
  await assert.rejects(heartbeatBusinessQueueLease(db, stale), BusinessEventBackboneError);
  const rows = await db.businessInboxEvent.findMany({ where: { id: { in: ids } } });
  await delay(Math.max(0, ...rows.map((row) => row.availableAt.getTime() - Date.now())) + 100);
  assert.equal(completed(await child(ids).result).projectedNew, 2);
  await assert.rejects(completeBusinessQueueEvent(db, stale), BusinessEventBackboneError);
  assert.equal((await run(ids)).claimed, 0);
  const attempts = await db.businessQueueAttempt.findMany({ where: { inboxEventId: { in: ids } } });
  assert.equal(attempts.filter((attempt) => attempt.outcome === 'LEASE_EXPIRED').length, 2);
  assert.equal(attempts.filter((attempt) => attempt.outcome === 'PROCESSED' && attempt.fencingToken === 2n).length, 2);
  assert.deepEqual(await outside(ids), before);
});

test('VNX-05 SIGTERM finishes the in-flight commit, reports it, stops new claims and resumes without duplication', dbTest, async () => {
  const first = await admit();
  const second = await admit();
  const ids = [first.id, second.id];
  const before = await outside(ids);
  let worker: ReturnType<typeof child> | undefined;
  await db.$transaction(async (tx) => {
    await acquireLeadIdentityWriteLock(tx);
    worker = child(ids);
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await db.businessInboxEvent.count({ where: { id: { in: ids }, state: 'LEASED' } }) === 1) {
        worker.process.kill('SIGTERM');
        return;
      }
      await delay(20);
    }
    worker.process.kill('SIGKILL');
    assert.fail('consumer did not reach the in-flight projection');
  }, { timeout: 5_000, maxWait: 2_000 });
  const summary = completed(await worker!.result);
  assert.equal(summary.status, 'STOPPED');
  assert.equal(summary.claimed, 1);
  assert.equal(summary.projectedNew, 1);
  assert.equal(completed(await child(ids).result).projectedNew, 1);
  assert.equal((await run(ids)).claimed, 0);
  assert.deepEqual(await outside(ids), before);
});

test('VNX-05 primitive freezes mutable selection before transactional work, with all schema triggers enabled', dbTest, async () => {
  const selected = await admit();
  const foreign = await admit();
  const ids = [selected.id];
  const before = await outside(ids);
  const promise = claimBusinessQueueEvent(db, { queueKind: 'INBOX', leaseOwnerId: randomUUID(), inboxEventIds: ids });
  ids[0] = foreign.id;
  const lease = await promise;
  assert.equal(lease?.eventRowId, selected.id);
  assert.deepEqual(await outside([selected.id]), before);
  const disabled = await db.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
    SELECT COUNT(*) AS count FROM pg_trigger
    WHERE tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace = ${schema}::regnamespace)
      AND NOT tgisinternal AND tgenabled = 'D'
  `);
  assert.equal(disabled[0].count, 0n);
});

test('VNX-05 packaged operational entrypoint rejects selectors with no pilot and honors the closed main gate', { skip: !enabled || !packaged }, async () => {
  const pending = await admit();
  const before = await outside([]);
  const rejected = await child([pending.id], 'normal', { VNX05_LEAD_INTAKE_PILOT_ENABLED: '0' }).result;
  assert.equal(rejected.code, 1);
  assert.deepEqual(rejected.rows, [{ event: 'VNX01_CONSUMER_REJECTED', status: 'REJECTED', failureCode: 'VNX05_PILOT_CONFIG_INVALID' }]);
  const closed = await child([pending.id], 'normal', { VNX01_LEAD_INTAKE_CONSUMER_ENABLED: '0' }).result;
  assert.equal(closed.code, 0);
  assert.deepEqual(closed.rows, [{ event: 'VNX01_CONSUMER_DISABLED', status: 'DISABLED' }]);
  assert.deepEqual(await outside([]), before);
});
