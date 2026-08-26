import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { Prisma, PrismaClient } from '@prisma/client';
import { canonicalSha256 } from '../../src/lib/canonical-json';
import { createWebsiteLeadPrivacyEvidence, PrivacyContractUnavailableError } from '../../src/lib/privacy-evidence';
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
const rootDb = runDbTests ? new PrismaClient() : null;
const schema = `n04_contract_${process.pid}`;
let schemaUrl = '';
let db: PrismaClient | null = null;

function rootClient() {
  if (!rootDb) throw new Error('DB tests disabled');
  return rootDb;
}

function client() {
  if (!db) throw new Error('N04 schema unavailable');
  return db;
}

function deploy(databaseUrl: string, schemaPath = 'prisma/schema.prisma') {
  execFileSync(resolve('node_modules/.bin/prisma'), ['migrate', 'deploy', '--schema', schemaPath], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });
}

test.before(async () => {
  if (!runDbTests) return;
  await assertAiOrchestratorEphemeralDatabaseIdentity(rootClient());
  const url = new URL(process.env.DATABASE_URL!);
  url.searchParams.set('schema', schema);
  schemaUrl = url.toString();
  await rootClient().$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  deploy(schemaUrl);
  db = new PrismaClient({ datasources: { db: { url: schemaUrl } } });
  await client().privacyNoticeVersion.createMany({ data: [
    {
      noticeCode: 'N04_TEST_PRIVACY', noticeVersion: 'n04-v1',
      purposeCode: 'SERVICE_REQUEST_FOLLOW_UP', legalBasisCode: 'PRE_CONTRACTUAL_MEASURES',
      evidenceKind: 'NOTICE_ACKNOWLEDGEMENT', contentHash: '1'.repeat(64),
    },
    {
      noticeCode: 'N04_TEST_MARKETING', noticeVersion: 'n04-v1',
      purposeCode: 'DIRECT_MARKETING', legalBasisCode: 'CONSENT',
      evidenceKind: 'CONSENT', contentHash: '2'.repeat(64),
    },
  ] });
  await client().privacyNoticeVersion.updateMany({
    where: { noticeCode: { in: ['N04_TEST_PRIVACY', 'N04_TEST_MARKETING'] }, status: 'DRAFT' },
    data: { status: 'ACTIVE', effectiveFrom: new Date('2026-01-01T00:00:00.000Z') },
  });
});

test.after(async () => {
  await db?.$disconnect();
  if (runDbTests) await rootClient().$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
  await rootDb?.$disconnect();
});

async function migrationQualification(upgrade: boolean) {
  const qualificationSchema = `n04_${upgrade ? 'upgrade' : 'fresh'}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const root = mkdtempSync(join(tmpdir(), 'n04-migrations-'));
  const prismaDir = join(root, 'prisma');
  const migrationsDir = join(prismaDir, 'migrations');
  mkdirSync(migrationsDir, { recursive: true });
  cpSync('prisma/schema.prisma', join(prismaDir, 'schema.prisma'));
  const allNames = readdirSync('prisma/migrations').filter((name) => /^\d/.test(name)).sort();
  assert.equal(allNames.length, 43);
  const names = allNames.slice(0, 35);
  assert.equal(names[34], '20260817120000_privacy_consent_data_classification_foundation_v1');
  const url = new URL(process.env.DATABASE_URL!);
  url.searchParams.set('schema', qualificationSchema);
  await rootClient().$executeRawUnsafe(`CREATE SCHEMA "${qualificationSchema}"`);
  try {
    for (const name of upgrade ? names.slice(0, 34) : names) {
      cpSync(join('prisma/migrations', name), join(migrationsDir, name), { recursive: true });
    }
    deploy(url.toString(), join(prismaDir, 'schema.prisma'));
    if (upgrade) {
      const before = new PrismaClient({ datasources: { db: { url: url.toString() } } });
      try {
        const rows = await before.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*)::bigint AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
        assert.equal(Number(rows[0]?.count), 34);
      } finally { await before.$disconnect(); }
      cpSync(join('prisma/migrations', names[34]), join(migrationsDir, names[34]), { recursive: true });
      deploy(url.toString(), join(prismaDir, 'schema.prisma'));
    }
    const qualification = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    try {
      const [migrationRows, catalogRows] = await Promise.all([
        qualification.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*)::bigint AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`,
        qualification.$queryRaw<Array<{ tables: bigint; notices: bigint; evidence: bigint; triggers: bigint }>>(Prisma.sql`
          SELECT
            (SELECT COUNT(*)::bigint FROM information_schema.tables WHERE table_schema = ${qualificationSchema} AND table_name IN ('PrivacyNoticeVersion','PrivacyEvidenceReceipt')) AS tables,
            (SELECT COUNT(*)::bigint FROM ${Prisma.raw(`"${qualificationSchema}"."PrivacyNoticeVersion"`)}) AS notices,
            (SELECT COUNT(*)::bigint FROM ${Prisma.raw(`"${qualificationSchema}"."PrivacyEvidenceReceipt"`)}) AS evidence,
            (SELECT COUNT(DISTINCT trg.tgname)::bigint
              FROM pg_catalog.pg_trigger AS trg
              JOIN pg_catalog.pg_class AS relation ON relation.oid = trg.tgrelid
              JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
              WHERE namespace.nspname = ${qualificationSchema}
                AND NOT trg.tgisinternal
                AND trg.tgname IN ('PrivacyNoticeVersion_lifecycle_v1','PrivacyNoticeVersion_deny_truncate_v1','PrivacyEvidenceReceipt_validate_v1','PrivacyEvidenceReceipt_append_only_v1','PrivacyEvidenceReceipt_deny_truncate_v1','AuditLog_redaction_n04_v1')) AS triggers
        `),
      ]);
      return {
        migrations: Number(migrationRows[0]?.count),
        tables: Number(catalogRows[0]?.tables),
        notices: Number(catalogRows[0]?.notices),
        evidence: Number(catalogRows[0]?.evidence),
        triggers: Number(catalogRows[0]?.triggers),
      };
    } finally { await qualification.$disconnect(); }
  } finally {
    await rootClient().$executeRawUnsafe(`DROP SCHEMA "${qualificationSchema}" CASCADE`);
    rmSync(root, { recursive: true, force: true });
  }
}

test('N04 migration qualifies fresh 1-35 and upgrade 1-34 then 35', { skip: !runDbTests, timeout: 180_000 }, async () => {
  const expected = { migrations: 35, tables: 2, notices: 0, evidence: 0, triggers: 6 };
  assert.deepEqual(await migrationQualification(false), expected);
  assert.deepEqual(await migrationQualification(true), expected);
});

let sequence = 0;
async function createSource(marketingAccepted: boolean, suffix = `case-${++sequence}`) {
  const lead = await client().lead.create({
    data: { firstName: 'Synthetic', lastName: 'N04', email: `${suffix}@n04-db.invalid`, source: 'n04-db-test' },
  });
  const receipt = await client().websiteLeadReceipt.create({
    data: { namespace: 'n04-db-test', keyDigest: suffix.padEnd(64, '0').slice(0, 64), payloadHash: canonicalSha256({ suffix }), status: 'pending' },
  });
  return { lead, receipt, marketingAccepted };
}

function evidenceInput(source: Awaited<ReturnType<typeof createSource>>, overrides: Record<string, unknown> = {}) {
  return {
    leadId: source.lead.id,
    websiteLeadReceiptId: source.receipt.id,
    sourceEvidenceDigest: source.receipt.payloadHash,
    sourceSystem: 'N04_DB_TEST',
    formCode: 'SYNTHETIC_LEAD',
    formVersion: 'n04-v1',
    sourceSubmittedAt: new Date('2026-08-17T00:00:00.000Z'),
    privacyAccepted: true as const,
    privacyNoticeCode: 'N04_TEST_PRIVACY',
    privacyNoticeVersion: 'n04-v1',
    privacyPurposeCode: 'SERVICE_REQUEST_FOLLOW_UP' as const,
    privacyLegalBasisCode: 'PRE_CONTRACTUAL_MEASURES' as const,
    marketingAccepted: source.marketingAccepted,
    marketingNoticeCode: 'N04_TEST_MARKETING',
    marketingNoticeVersion: 'n04-v1',
    marketingPurposeCode: 'DIRECT_MARKETING' as const,
    marketingLegalBasisCode: 'CONSENT' as const,
    ...overrides,
  };
}

test('privacy acknowledgement and explicit marketing grant/denial are separate and minimized', { skip: !runDbTests }, async () => {
  for (const marketingAccepted of [false, true]) {
    const source = await createSource(marketingAccepted);
    const result = await client().$transaction((tx) => createWebsiteLeadPrivacyEvidence(tx, evidenceInput(source)));
    assert.equal(result.count, 2);
    const rows = await client().privacyEvidenceReceipt.findMany({ where: { websiteLeadReceiptId: source.receipt.id }, orderBy: { purposeCode: 'asc' } });
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map(({ purposeCode, evidenceKind, decision }) => ({ purposeCode, evidenceKind, decision })), [
      { purposeCode: 'DIRECT_MARKETING', evidenceKind: 'CONSENT', decision: marketingAccepted ? 'GRANTED' : 'DENIED' },
      { purposeCode: 'SERVICE_REQUEST_FOLLOW_UP', evidenceKind: 'NOTICE_ACKNOWLEDGEMENT', decision: 'ACKNOWLEDGED' },
    ]);
    const serialized = JSON.stringify(rows);
    assert.doesNotMatch(serialized, /@n04-db\.invalid|firstName|lastName|email|phone|message|ipAddress/);
  }
});

test('unregistered notice fails closed and rolls back the complete transaction', { skip: !runDbTests }, async () => {
  const suffix = `rollback-${++sequence}`;
  await assert.rejects(
    client().$transaction(async (tx) => {
      const lead = await tx.lead.create({ data: { firstName: 'Synthetic', lastName: 'Rollback', email: `${suffix}@n04-db.invalid` } });
      const receipt = await tx.websiteLeadReceipt.create({ data: { namespace: 'n04-db-test', keyDigest: 'b'.repeat(64), payloadHash: 'c'.repeat(64), status: 'pending' } });
      await createWebsiteLeadPrivacyEvidence(tx, evidenceInput({ lead, receipt, marketingAccepted: false }, { marketingNoticeVersion: 'unknown-v1' }));
    }),
    PrivacyContractUnavailableError,
  );
  assert.equal(await client().lead.count({ where: { email: `${suffix}@n04-db.invalid` } }), 0);
  assert.equal(await client().websiteLeadReceipt.count({ where: { keyDigest: 'b'.repeat(64) } }), 0);
});

test('database rejects forged evidence hashes even when the notice binding is valid', { skip: !runDbTests }, async () => {
  const source = await createSource(false, `forged-${++sequence}`);
  const notice = await client().privacyNoticeVersion.findUniqueOrThrow({
    where: { noticeCode_noticeVersion_purposeCode: { noticeCode: 'N04_TEST_PRIVACY', noticeVersion: 'n04-v1', purposeCode: 'SERVICE_REQUEST_FOLLOW_UP' } },
  });
  await assert.rejects(client().privacyEvidenceReceipt.create({ data: {
    leadId: source.lead.id,
    websiteLeadReceiptId: source.receipt.id,
    noticeVersionId: notice.id,
    catalogVersion: 'n04-v1',
    purposeCode: 'SERVICE_REQUEST_FOLLOW_UP',
    legalBasisCode: 'PRE_CONTRACTUAL_MEASURES',
    evidenceKind: 'NOTICE_ACKNOWLEDGEMENT',
    decision: 'ACKNOWLEDGED',
    sourceSystem: 'N04_DB_TEST',
    formCode: 'SYNTHETIC_LEAD',
    formVersion: 'n04-v1',
    sourceSubmittedAt: new Date('2026-08-17T00:00:00.000Z'),
    sourceEvidenceDigest: source.receipt.payloadHash,
    evidenceHash: '0'.repeat(64),
  } }), /hash mismatch/i);
  assert.equal(await client().privacyEvidenceReceipt.count({ where: { websiteLeadReceiptId: source.receipt.id } }), 0);
});

test('database binds the evidence digest to the originating website receipt', { skip: !runDbTests }, async () => {
  const source = await createSource(false, `digest-binding-${++sequence}`);
  const notice = await client().privacyNoticeVersion.findUniqueOrThrow({
    where: { noticeCode_noticeVersion_purposeCode: { noticeCode: 'N04_TEST_PRIVACY', noticeVersion: 'n04-v1', purposeCode: 'SERVICE_REQUEST_FOLLOW_UP' } },
  });
  const data = {
    leadId: source.lead.id,
    websiteLeadReceiptId: source.receipt.id,
    noticeVersionId: notice.id,
    catalogVersion: 'n04-v1',
    purposeCode: 'SERVICE_REQUEST_FOLLOW_UP',
    legalBasisCode: 'PRE_CONTRACTUAL_MEASURES',
    evidenceKind: 'NOTICE_ACKNOWLEDGEMENT' as const,
    decision: 'ACKNOWLEDGED' as const,
    sourceSystem: 'N04_DB_TEST',
    formCode: 'SYNTHETIC_LEAD',
    formVersion: 'n04-v1',
    sourceSubmittedAt: new Date('2026-08-17T00:00:00.000Z'),
    sourceEvidenceDigest: 'f'.repeat(64),
  };
  const evidenceHash = canonicalSha256({
    catalogVersion: data.catalogVersion,
    decision: data.decision,
    evidenceKind: data.evidenceKind,
    formCode: data.formCode,
    formVersion: data.formVersion,
    leadId: data.leadId,
    legalBasisCode: data.legalBasisCode,
    noticeVersionId: data.noticeVersionId,
    purposeCode: data.purposeCode,
    sourceEvidenceDigest: data.sourceEvidenceDigest,
    sourceSubmittedAt: data.sourceSubmittedAt.toISOString(),
    sourceSystem: data.sourceSystem,
    websiteLeadReceiptId: data.websiteLeadReceiptId,
  });
  await assert.rejects(client().privacyEvidenceReceipt.create({ data: { ...data, evidenceHash } }), /source receipt binding denied/i);
  assert.equal(await client().privacyEvidenceReceipt.count({ where: { websiteLeadReceiptId: source.receipt.id } }), 0);
});

test('concurrent evidence attempts produce one atomic pair for one receipt', { skip: !runDbTests }, async () => {
  const source = await createSource(false, `concurrent-${++sequence}`);
  const attempts = await Promise.allSettled(Array.from({ length: 20 }, () => client().$transaction((tx) => createWebsiteLeadPrivacyEvidence(tx, evidenceInput(source)))));
  assert.equal(attempts.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal(await client().privacyEvidenceReceipt.count({ where: { websiteLeadReceiptId: source.receipt.id } }), 2);
});

test('evidence is append-only and notice lifecycle cannot move backwards', { skip: !runDbTests }, async () => {
  await assert.rejects(client().privacyNoticeVersion.create({ data: {
    noticeCode: `N04_INVALID_ACTIVE_${++sequence}`, noticeVersion: 'n04-v1',
    purposeCode: 'SERVICE_REQUEST_FOLLOW_UP', legalBasisCode: 'PRE_CONTRACTUAL_MEASURES',
    evidenceKind: 'NOTICE_ACKNOWLEDGEMENT', contentHash: '3'.repeat(64),
    status: 'ACTIVE', effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
  } }), /must start as DRAFT/i);
  const source = await createSource(false, `immutable-${++sequence}`);
  await client().$transaction((tx) => createWebsiteLeadPrivacyEvidence(tx, evidenceInput(source)));
  const row = await client().privacyEvidenceReceipt.findFirstOrThrow({ where: { websiteLeadReceiptId: source.receipt.id } });
  await assert.rejects(client().privacyEvidenceReceipt.update({ where: { id: row.id }, data: { formVersion: 'changed-v2' } }), /append-only/i);
  await assert.rejects(client().privacyEvidenceReceipt.delete({ where: { id: row.id } }), /append-only/i);
  await assert.rejects(client().$executeRawUnsafe('TRUNCATE TABLE "PrivacyEvidenceReceipt"'), /cannot be truncated/i);
  await assert.rejects(client().privacyNoticeVersion.update({
    where: { noticeCode_noticeVersion_purposeCode: { noticeCode: 'N04_TEST_PRIVACY', noticeVersion: 'n04-v1', purposeCode: 'SERVICE_REQUEST_FOLLOW_UP' } },
    data: { status: 'DRAFT' },
  }), /monotonic/i);
  await assert.rejects(client().privacyNoticeVersion.update({
    where: { noticeCode_noticeVersion_purposeCode: { noticeCode: 'N04_TEST_PRIVACY', noticeVersion: 'n04-v1', purposeCode: 'SERVICE_REQUEST_FOLLOW_UP' } },
    data: { effectiveFrom: new Date('2026-02-01T00:00:00.000Z') },
  }), /immutable/i);
});

test('database audit trigger removes direct PII, credentials, prompts and IP', { skip: !runDbTests }, async () => {
  const row = await client().auditLog.create({ data: {
    event: 'n04_synthetic_redaction_test', entityType: 'N04Synthetic', ipAddress: '192.0.2.10',
    after: {
      email: 'privacy.person@n04.invalid', phone: '+390300000000', prompt: 'synthetic private prompt',
      token: 'synthetic-secret-token', catalogVersion: 'n04-v1', evidenceHash: 'd'.repeat(64),
      reason: 'privacy.person@n04.invalid +39 030 000 0000 333 123 4567 token=synthetic-secret prompt=synthetic private prompt',
      liquid: 'suffix-like unknown key',
    },
  } });
  const persisted = await client().auditLog.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(persisted.ipAddress, null);
  const serialized = JSON.stringify(persisted.after);
  for (const prohibited of ['privacy.person', '+39', '333 123', 'synthetic-secret', 'private prompt', 'suffix-like']) {
    assert.equal(serialized.toLowerCase().includes(prohibited.toLowerCase()), false, prohibited);
  }
  assert.match(serialized, /n04-v1/);
  assert.match(serialized, new RegExp('d'.repeat(64)));
});

test('exact PR90 application starts healthy on additive schema 35', { skip: !runDbTests, timeout: 180_000 }, async () => {
  const root = mkdtempSync(join(resolve('..'), 'n04-pr90-runtime-'));
  const archive = join(root, 'pr90.tar');
  const app = join(root, 'app');
  mkdirSync(app);
  writeFileSync(archive, execFileSync('git', ['archive', 'fc35c2c6feb0927f4170d0be3893d9c9ba6cbcd5'], { maxBuffer: 50 * 1024 * 1024 }));
  execFileSync('tar', ['-xf', archive, '-C', app]);
  execFileSync('cp', ['-al', resolve('node_modules'), join(app, 'node_modules')]);
  const next = join(app, 'node_modules/.bin/next');
  const port = 32_935;
  execFileSync(next, ['build'], {
    cwd: app, env: { ...process.env, DATABASE_URL: schemaUrl, NEXT_TELEMETRY_DISABLED: '1' },
    stdio: 'pipe', timeout: 120_000, maxBuffer: 20 * 1024 * 1024,
  });
  const server = spawn(next, ['start', '-p', String(port)], {
    cwd: app, env: { ...process.env, DATABASE_URL: schemaUrl, NEXT_TELEMETRY_DISABLED: '1' }, stdio: 'ignore',
  });
  try {
    let healthy = false;
    for (let attempt = 0; attempt < 60 && !healthy; attempt += 1) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`);
        healthy = response.status === 200 && (await response.json()).ok === true;
      } catch { /* startup */ }
    }
    assert.equal(healthy, true);
  } finally {
    if (server.exitCode === null && server.signalCode === null) {
      server.kill('SIGTERM');
      await new Promise<void>((resolveExit) => server.once('exit', () => resolveExit()));
    }
    rmSync(root, { recursive: true, force: true });
  }
});
