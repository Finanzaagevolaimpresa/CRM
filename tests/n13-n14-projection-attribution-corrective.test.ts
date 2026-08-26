import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { BUSINESS_EVENT_BACKBONE_MANIFEST } from '../src/lib/business-event-backbone';
import { LEAD_EVENT_SCHEMA_VERSION } from '../src/lib/lead-event-contract';

const historicalMigrationName = '20260823160000_commercial_lead_inbox_attribution_sla_v1';
const correctiveMigrationName = '20260826150000_n13_n14_projection_attribution_corrective_v1';
const historicalMigrationPath = `prisma/migrations/${historicalMigrationName}/migration.sql`;
const correctiveMigrationPath = `prisma/migrations/${correctiveMigrationName}/migration.sql`;
const historicalMigrationSha256 = 'fc94e1bf2c659b68baf708d38cf7f3aa4c6b9e653a89330be5ca754bcfeab7aa';

test('F1 reuses the canonical N10/N11 schema version in the N14 application query', () => {
  const service = readFileSync('src/lib/commercial-lead-inbox.ts', 'utf8');
  assert.equal(LEAD_EVENT_SCHEMA_VERSION, 'fai.lead-event.v1');
  assert.equal(BUSINESS_EVENT_BACKBONE_MANIFEST.schemaVersion, LEAD_EVENT_SCHEMA_VERSION);
  assert.match(service, /import \{ LEAD_EVENT_SCHEMA_VERSION \} from '\.\/lead-event-contract';/u);
  assert.match(service, /inbox\."schemaVersion" = \$\{LEAD_EVENT_SCHEMA_VERSION\}/u);
  assert.doesNotMatch(service, /fai\.lead-submitted\.v1/u);
  assert.doesNotMatch(service, /fai\.lead-event\.v1/u);
});

test('F2 aligns Prisma provenance widths to the published N10 120/120/80 limits', () => {
  const schema = readFileSync('prisma/schema.prisma', 'utf8');
  const model = schema.match(/model CommercialLeadInboxItem \{[\s\S]*?\n\}/u)?.[0];
  assert.ok(model);
  assert.match(model, /sourceSystem\s+String\s+@db\.VarChar\(120\)/u);
  assert.match(model, /formCode\s+String\s+@db\.VarChar\(120\)/u);
  assert.match(model, /formVersion\s+String\s+@db\.VarChar\(80\)/u);
  assert.doesNotMatch(model, /sourceSystem\s+String\s+@db\.VarChar\(80\)/u);
  assert.doesNotMatch(model, /formVersion\s+String\s+@db\.VarChar\(40\)/u);
});

test('migration 43 is one locked, fail-closed and business-empty forward transaction', () => {
  const sql = readFileSync(correctiveMigrationPath, 'utf8');
  const executableSql = sql.replace(/^--.*$/gmu, '');
  assert.equal((sql.match(/^BEGIN;$/gmu) ?? []).length, 1);
  assert.equal((sql.match(/^COMMIT;$/gmu) ?? []).length, 1);
  assert.equal((sql.match(/^LOCK TABLE ONLY "CommercialLeadInboxItem" IN ACCESS EXCLUSIVE MODE;$/gmu) ?? []).length, 1);
  assert.match(sql, /^SET LOCAL lock_timeout = '2s';$/mu);
  assert.match(sql, /^SET LOCAL statement_timeout = '30s';$/mu);
  assert.match(sql, /N13_N14_ATTRIBUTION_SOURCE_TYPE_DRIFT/u);
  assert.match(sql, /N13_N14_ATTRIBUTION_CONSTRAINT_DRIFT/u);
  assert.match(sql, /N13_N14_ATTRIBUTION_GUARD_DRIFT/u);
  assert.match(sql, /trigger_row\.tgnargs = 0/u);
  assert.match(sql, /trigger_row\.tgattr = ''::INT2VECTOR/u);
  assert.match(sql, /OCTET_LENGTH\(trigger_row\.tgargs\) = 0/u);
  assert.match(sql, /trigger_row\.tgqual IS NULL/u);
  assert.match(sql, /N13_N14_ATTRIBUTION_SOURCE_POSTCONDITION_FAILED/u);
  assert.match(sql, /N13_N14_ATTRIBUTION_CONSTRAINT_POSTCONDITION_FAILED/u);
  assert.match(sql, /N13_N14_ATTRIBUTION_GUARD_POSTCONDITION_FAILED/u);
  assert.match(sql, /ALTER COLUMN "sourceSystem" TYPE VARCHAR\(120\)/u);
  assert.match(sql, /ALTER COLUMN "formCode" TYPE VARCHAR\(120\)/u);
  assert.match(sql, /ALTER COLUMN "formVersion" TYPE VARCHAR\(80\)/u);
  assert.match(sql, /length\("sourceSystem"\) BETWEEN 1 AND 120/u);
  assert.match(sql, /length\("formCode"\) BETWEEN 1 AND 120/u);
  assert.match(sql, /length\("formVersion"\) BETWEEN 1 AND 80/u);
  assert.equal((sql.match(/^CREATE OR REPLACE FUNCTION "n14_guard_item"/gmu) ?? []).length, 1);
  assert.match(sql, /inbox\."schemaVersion" = 'fai\.lead-event\.v1'/u);
  assert.doesNotMatch(sql, /fai\.lead-submitted\.v1/u);
  assert.doesNotMatch(executableSql, /^\s*(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/imu);
  assert.doesNotMatch(executableSql, /\b(?:backfill|seed|activation|worker|dispatch|egress)\b/iu);
});

test('migration 42 remains byte-identical and is the only executable historical F1 literal', () => {
  const historicalSql = readFileSync(historicalMigrationPath, 'utf8');
  assert.equal(createHash('sha256').update(historicalSql).digest('hex'), historicalMigrationSha256);
  assert.match(historicalSql, /fai\.lead-submitted\.v1/u);

  const executableMatches: string[] = [];
  for (const name of readdirSync('prisma/migrations').filter((entry) => /^\d/u.test(entry)).sort()) {
    const path = `prisma/migrations/${name}/migration.sql`;
    if (/fai\.lead-submitted\.v1/u.test(readFileSync(path, 'utf8'))) executableMatches.push(path);
  }
  assert.deepEqual(executableMatches, [historicalMigrationPath]);
});

test('the corrective extends the current chain to 43 without rewriting Phase 1C history', () => {
  const migrations = readdirSync('prisma/migrations').filter((name) => /^\d/u.test(name)).sort();
  const adr = readFileSync(
    'docs/adr/ADR-0014-n15-communication-intent-dedicated-persistence-boundary-v1.md',
    'utf8',
  );
  const document = readFileSync('docs/n13-n14-projection-attribution-corrective-v1.md', 'utf8');
  assert.equal(migrations.length, 43);
  assert.equal(migrations.at(-1), correctiveMigrationName);
  assert.match(adr, /^N15_PHASE1C_CURRENT_MIGRATIONS=42$/mu);
  assert.match(adr, /Phase 1C non crea alcuna migration e lascia il catalogo a 42/u);
  for (const marker of [
    'N13_N14_ATTRIBUTION_CORRECTIVE_STATUS=SOURCE_IMPLEMENTED_DORMANT_NOT_DEPLOYED',
    'N13_N14_ATTRIBUTION_CORRECTIVE_SCOPE=F1_F2_ONLY',
    'N13_N14_ATTRIBUTION_CANONICAL_SCHEMA_VERSION=fai.lead-event.v1',
    'N13_N14_ATTRIBUTION_SOURCE_LIMITS=120_120_80',
    'N13_N14_ATTRIBUTION_CURRENT_MIGRATIONS=43',
    'N13_N14_ATTRIBUTION_DATA_CHANGE=NONE',
    'N13_N14_ATTRIBUTION_BACKFILL=NONE',
    'N13_N14_ATTRIBUTION_ACTIVATION=NONE',
    'N13_N14_ATTRIBUTION_DIRECT_SQL_PROVENANCE_BINDING=KNOWN_LIMITATION_OUT_OF_SCOPE',
    'N13_N14_ATTRIBUTION_F3=KNOWN_LIMITATION_OUT_OF_SCOPE',
  ]) assert.match(document, new RegExp(`^${marker}$`, 'mu'), marker);
  assert.match(document, /N13_N14_ATTRIBUTION_CORRECTIVE_SOURCE_COMPLETE/u);
});
