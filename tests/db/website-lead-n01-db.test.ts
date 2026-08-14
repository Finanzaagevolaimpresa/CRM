import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { after, before, beforeEach } from 'node:test';
import { NextRequest } from 'next/server';
import { Prisma, PrismaClient } from '@prisma/client';
import { POST } from '../../src/app/api/integrations/website/leads/route';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from './ai-orchestrator-db-test-guard';

const runDbTests = process.env.RUN_DB_TESTS === '1';
const db = new PrismaClient();
const syntheticDomain = 'n01-ci.invalid';
const secret = 'n01-ci-synthetic-secret';

function request(key: string, suffix = 'same', overrides: Record<string, unknown> = {}) {
  return new NextRequest('http://localhost/api/integrations/website/leads', {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', 'x-fai-webhook-secret': secret, 'idempotency-key': key },
    body: JSON.stringify({ firstName: 'Synthetic', lastName: 'Qualification', email: `${suffix}@${syntheticDomain}`, privacyAccepted: true, ...overrides }),
  });
}
async function counts() {
  const leadRows = await db.lead.findMany({ where: { email: { endsWith: `@${syntheticDomain}` } }, select: { id: true } });
  const [audits, receipts, buckets] = await Promise.all([
    db.auditLog.count({ where: { entityId: { in: leadRows.map(({ id }) => id) }, event: { in: ['website_lead_received', 'website_lead_duplicate_detected'] } } }),
    db.websiteLeadReceipt.count({ where: { namespace: 'website-lead:legacy:v1' } }),
    db.websiteLeadRateLimitBucket.count({ where: { namespace: 'website-lead:legacy:v1' } }),
  ]);
  return { leads: leadRows.length, audits, receipts, buckets };
}
async function clean() {
  const leadRows = await db.lead.findMany({ where: { email: { endsWith: `@${syntheticDomain}` } }, select: { id: true } });
  await db.websiteLeadRateLimitBucket.deleteMany({ where: { namespace: 'website-lead:legacy:v1' } });
  await db.websiteLeadReceipt.deleteMany({ where: { namespace: 'website-lead:legacy:v1' } });
  await db.auditLog.deleteMany({ where: { entityId: { in: leadRows.map(({ id }) => id) }, event: { in: ['website_lead_received', 'website_lead_duplicate_detected'] } } });
  await db.lead.deleteMany({ where: { email: { endsWith: `@${syntheticDomain}` } } });
}

before(async () => {
  if (!runDbTests) return;
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  process.env.WEBSITE_LEAD_MODE = 'legacy';
  process.env.WEBSITE_LEAD_WEBHOOK_SECRET = secret;
  process.env.WEBSITE_LEAD_RATE_LIMIT_REQUESTS = '1000';
  process.env.WEBSITE_LEAD_RATE_LIMIT_WINDOW_SECONDS = '60';
});
beforeEach(async () => { if (runDbTests) await clean(); });
after(async () => { if (runDbTests) await clean(); await db.$disconnect(); });

async function withMigrationSchema(upgrade: boolean) {
  const databaseUrl = process.env.DATABASE_URL!;
  const schema = `n01_${upgrade ? 'upgrade' : 'fresh'}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const root = mkdtempSync(join(tmpdir(), 'n01-migrations-'));
  const prismaDir = join(root, 'prisma'); const migrations = join(prismaDir, 'migrations');
  mkdirSync(migrations, { recursive: true });
  cpSync('prisma/schema.prisma', join(prismaDir, 'schema.prisma'));
  const names = readdirSync('prisma/migrations').filter((name) => /^\d/.test(name)).sort();
  const url = new URL(databaseUrl); url.searchParams.set('schema', schema);
  await db.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  const deploy = () => execFileSync(resolve('node_modules/.bin/prisma'), ['migrate', 'deploy', '--schema', join(prismaDir, 'schema.prisma')], { env: { ...process.env, DATABASE_URL: url.toString() }, stdio: 'pipe' });
  try {
    for (const name of upgrade ? names.slice(0, 31) : names) cpSync(join('prisma/migrations', name), join(migrations, name), { recursive: true });
    deploy();
    if (upgrade) { const name = names[31]; cpSync(join('prisma/migrations', name), join(migrations, name), { recursive: true }); deploy(); }
    const client = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    try {
      const applied = await client.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*)::bigint AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
      const catalog = await client.$queryRaw<Array<{ tables: bigint; indexes: bigint; constraints: bigint }>>(Prisma.sql`
        SELECT
          (COUNT(DISTINCT tablename) FILTER (WHERE tablename IN ('WebsiteLeadReceipt','WebsiteLeadRateLimitBucket')))::bigint AS tables,
          (COUNT(DISTINCT indexname) FILTER (WHERE indexname IN ('WebsiteLeadReceipt_namespace_keyDigest_key','WebsiteLeadReceipt_createdAt_idx')))::bigint AS indexes,
          (SELECT COUNT(*)::bigint FROM information_schema.table_constraints WHERE table_schema = ${schema} AND constraint_name IN ('WebsiteLeadReceipt_pkey','WebsiteLeadRateLimitBucket_pkey','WebsiteLeadReceipt_namespace_keyDigest_key')) AS constraints
        FROM pg_indexes WHERE schemaname = ${schema}`);
      return { applied: Number(applied[0]?.count), tables: Number(catalog[0]?.tables), indexes: Number(catalog[0]?.indexes), constraints: Number(catalog[0]?.constraints) };
    } finally { await client.$disconnect(); }
  } finally { await db.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`); rmSync(root, { recursive: true, force: true }); }
}

test('N01 migration chain qualifies fresh and as 31 then 32 additive upgrade', { skip: !runDbTests }, async () => {
  assert.deepEqual(await withMigrationSchema(false), { applied: 32, tables: 2, indexes: 2, constraints: 3 });
  assert.deepEqual(await withMigrationSchema(true), { applied: 32, tables: 2, indexes: 2, constraints: 3 });
});

test('100 concurrent replays create one business effect and one receipt', { skip: !runDbTests }, async () => {
  const responses = await Promise.all(Array.from({ length: 100 }, () => POST(request('same-key'))));
  assert.equal(responses.filter((r) => r.status === 201).length, 1);
  assert.equal(responses.filter((r) => r.status === 200).length, 99);
  assert.deepEqual(await counts(), { leads: 1, audits: 1, receipts: 1, buckets: 1 });
  assert.equal(new Set(await Promise.all(responses.map(async (r) => (await r.json()).receipt))).size, 1);
});

test('100 keys with one normalized identity create one Lead without lost effects', { skip: !runDbTests }, async () => {
  const responses = await Promise.all(Array.from({ length: 100 }, (_, index) => POST(request(`contact-key-${index}`, 'NORMALIZED'))));
  assert.equal(responses.filter((r) => r.status === 201).length, 100);
  assert.deepEqual(await counts(), { leads: 1, audits: 100, receipts: 100, buckets: 1 });
});

test('rate threshold is atomic and returns Retry-After', { skip: !runDbTests }, async () => {
  process.env.WEBSITE_LEAD_RATE_LIMIT_REQUESTS = '30';
  try {
    const responses = await Promise.all(Array.from({ length: 31 }, (_, index) => POST(request(`rate-${index}`, `rate-${index}`))));
    assert.equal(responses.filter((r) => r.status === 201).length, 30);
    const limited = responses.filter((r) => r.status === 429); assert.equal(limited.length, 1); assert.ok(limited[0].headers.get('retry-after'));
    assert.deepEqual(await counts(), { leads: 30, audits: 30, receipts: 30, buckets: 1 });
  } finally { process.env.WEBSITE_LEAD_RATE_LIMIT_REQUESTS = '1000'; }
});

test('replay is stable and changed payload conflicts without extra effects', { skip: !runDbTests }, async () => {
  const created = await POST(request('conflict')); const replay = await POST(request('conflict')); const conflict = await POST(request('conflict', 'different'));
  assert.deepEqual([created.status, replay.status, conflict.status], [201, 200, 409]);
  assert.equal((await created.json()).receipt, (await replay.json()).receipt);
  assert.deepEqual(await counts(), { leads: 1, audits: 1, receipts: 1, buckets: 1 });
});

test('database statement deadline rolls back slow business writes but preserves consumed quota', { skip: !runDbTests, timeout: 8_000 }, async () => {
  await db.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION n01_slow_lead() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(6); RETURN NEW; END $$`);
  await db.$executeRawUnsafe(`CREATE TRIGGER n01_slow_lead_trigger BEFORE INSERT ON "Lead" FOR EACH ROW EXECUTE FUNCTION n01_slow_lead()`);
  const started = Date.now();
  try {
    assert.equal((await POST(request('slow-database'))).status, 503);
  } finally {
    await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS n01_slow_lead_trigger ON "Lead"`);
    await db.$executeRawUnsafe('DROP FUNCTION IF EXISTS n01_slow_lead()');
  }
  assert.ok(Date.now() - started < 6_000);
  assert.deepEqual(await counts(), { leads: 0, audits: 0, receipts: 0, buckets: 1 });
});

async function installFault(table: 'Lead' | 'AuditLog' | 'WebsiteLeadReceipt', operation: 'INSERT' | 'UPDATE') {
  await db.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION n01_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'N01_SYNTHETIC_FAULT'; END $$`);
  await db.$executeRawUnsafe(`CREATE TRIGGER n01_fault_trigger BEFORE ${operation} ON "${table}" FOR EACH ROW EXECUTE FUNCTION n01_fault()`);
}
async function removeFault(table: string) {
  await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS n01_fault_trigger ON "${table}"`);
  await db.$executeRawUnsafe('DROP FUNCTION IF EXISTS n01_fault()');
}
for (const [label, table, operation] of [['before Lead','Lead','INSERT'], ['before AuditLog','AuditLog','INSERT'], ['before receipt finalization','WebsiteLeadReceipt','UPDATE']] as const) {
  test(`fault ${label} rolls back Lead, AuditLog and receipt`, { skip: !runDbTests }, async () => {
    await installFault(table, operation);
    try { assert.equal((await POST(request(`fault-${table}`))).status, 503); } finally { await removeFault(table); }
    assert.deepEqual(await counts(), { leads: 0, audits: 0, receipts: 0, buckets: 1 });
  });
}

test('persisted N01 audit metadata is minimized', { skip: !runDbTests }, async () => {
  assert.equal((await POST(request('privacy'))).status, 201);
  const lead = await db.lead.findFirstOrThrow({ where: { email: { endsWith: `@${syntheticDomain}` } }, select: { id: true } });
  const rows = await db.auditLog.findMany({ where: { entityId: lead.id, event: { in: ['website_lead_received','website_lead_duplicate_detected'] } }, select: { after: true, before: true, ipAddress: true } });
  assert.equal(rows.length, 1); assert.equal(rows[0].before, null); assert.equal(rows[0].ipAddress, null);
  assert.deepEqual(Object.keys(rows[0].after as object).sort(), ['contractVersion','mode','outcome','receipt']);
  assert.deepEqual(await counts(), { leads: 1, audits: 1, receipts: 1, buckets: 1 });
});

test('exact PR86 application starts healthy on schema 32 and leaves N01 tables inert', { skip: !runDbTests, timeout: 180_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'n01-pr86-runtime-'));
  const archive = join(root, 'pr86.tar'); const app = join(root, 'app'); mkdirSync(app);
  writeFileSync(archive, execFileSync('git', ['archive', '9697bd4e3fa69a7712ce7218da7237d909fa66de'], { maxBuffer: 50 * 1024 * 1024 }));
  execFileSync('tar', ['-xf', archive, '-C', app]);
  symlinkSync(resolve('node_modules'), join(app, 'node_modules'), 'dir');
  const port = 32_191;
  execFileSync(resolve('node_modules/.bin/next'), ['build', '--webpack'], { cwd: app, env: { ...process.env, NEXT_TELEMETRY_DISABLED:'1' }, stdio:'pipe', timeout:120_000, maxBuffer:20*1024*1024 });
  const server = spawn(resolve('node_modules/.bin/next'), ['start', '-p', String(port)], { cwd: app, env: { ...process.env, NEXT_TELEMETRY_DISABLED:'1' }, stdio:'ignore' });
  try {
    let healthy = false;
    for (let attempt = 0; attempt < 40 && !healthy; attempt++) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
      try { const result = await fetch(`http://127.0.0.1:${port}/api/health`); healthy = result.status === 200 && (await result.json()).ok === true; } catch { /* startup */ }
    }
    assert.equal(healthy, true);
    assert.deepEqual(await counts(), { leads: 0, audits: 0, receipts: 0, buckets: 0 });
  } finally {
    server.kill('SIGTERM'); await new Promise<void>((resolveExit) => server.once('exit', () => resolveExit())); rmSync(root, { recursive:true, force:true });
  }
});
