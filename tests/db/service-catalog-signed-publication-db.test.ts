import assert from 'node:assert/strict';
import test from 'node:test';
import { PrismaClient } from '@prisma/client';
import { FAI_SERVICE_CATALOG, serviceCatalogRevisionHash } from '../../src/lib/service-catalog';
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
const prisma = runDbTests ? new PrismaClient() : null;

function db() {
  if (!prisma) throw new Error('DB tests disabled');
  return prisma;
}

test.before(async () => {
  if (runDbTests) await assertAiOrchestratorEphemeralDatabaseIdentity(db());
});

test.after(async () => {
  await prisma?.$disconnect();
});

test('PostgreSQL applies migration 37 and bootstraps the 11 immutable N09 revisions',
  { skip: !runDbTests }, async () => {
    const [migrations, rows, publications, keys] = await Promise.all([
      db().$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*)::bigint AS count
        FROM "_prisma_migrations"
        WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
      `,
      db().$queryRaw<Array<{
        code: string;
        version: number;
        priceMode: string;
        netPrice: string | null;
        currency: string;
        vatRateBps: number;
        checkoutEnabled: boolean;
        contentHash: string;
      }>>`
        SELECT
          catalog."code",
          revision."version",
          revision."priceMode"::TEXT AS "priceMode",
          revision."netPrice"::TEXT AS "netPrice",
          revision."currency",
          revision."vatRateBps",
          revision."checkoutEnabled",
          revision."contentHash"
        FROM "ServiceCatalogRevision" revision
        JOIN "ServiceCatalog" catalog ON catalog."id" = revision."serviceCatalogId"
        WHERE revision."status" = 'PUBLISHED'
        ORDER BY catalog."displayOrder"
      `,
      db().$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*)::bigint AS count FROM "ServiceCatalogPublication"
      `,
      db().$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*)::bigint AS count
        FROM "ApplicationKeyVersion"
        WHERE "purpose" = 'SERVICE_CATALOG_PUBLICATION'
      `,
    ]);
    assert.equal(Number(migrations[0]?.count), 40);
    assert.equal(rows.length, 11);
    assert.deepEqual(rows.map(({ code }) => code), FAI_SERVICE_CATALOG.map(({ code }) => code));
    assert.equal(rows.filter(({ priceMode }) => priceMode === 'FIXED').length, 8);
    assert.equal(rows.filter(({ priceMode }) => priceMode === 'QUOTE_ONLY').length, 3);
    for (const [index, row] of rows.entries()) {
      const definition = FAI_SERVICE_CATALOG[index]!;
      assert.equal(row.version, 1);
      assert.equal(row.currency, 'EUR');
      assert.equal(row.vatRateBps, 2_200);
      assert.equal(row.checkoutEnabled, false);
      assert.equal(row.contentHash, serviceCatalogRevisionHash(definition));
      assert.equal(row.netPrice === null ? null : Number(row.netPrice) * 100,
        definition.netPriceCents);
    }
    assert.equal(Number(publications[0]?.count), 0);
    assert.equal(Number(keys[0]?.count), 0);
  });

test('PostgreSQL rejects mutation of published revisions and published snapshots',
  { skip: !runDbTests }, async () => {
    await assert.rejects(
      db().$executeRawUnsafe(`
        UPDATE "ServiceCatalogRevision"
        SET "publicName" = 'tampered'
        WHERE "id" = '00000000-0000-4000-8000-000000000001'::UUID
      `),
      /FAI_SERVICE_CATALOG_PUBLISHED_REVISION_IMMUTABLE/,
    );
    await db().$executeRawUnsafe(`
      INSERT INTO "ServiceCatalogPublication" (
        "id", "catalogVersion", "schemaVersion", "signatureVersion", "keyVersion",
        "payload", "payloadHash", "signature", "publishedAt"
      ) VALUES (
        '10000000-0000-4000-8000-000000000001'::UUID,
        'n09-db-test-v1', 1, 'hmac-sha256-v1', 1,
        '{"schemaVersion":1,"catalogVersion":"n09-db-test-v1","services":[]}'::JSONB,
        repeat('a', 64), repeat('A', 43), CURRENT_TIMESTAMP
      )
      ON CONFLICT ("catalogVersion") DO NOTHING
    `);
    await assert.rejects(
      db().$executeRawUnsafe(`
        UPDATE "ServiceCatalogPublication"
        SET "payloadHash" = repeat('b', 64)
        WHERE "catalogVersion" = 'n09-db-test-v1'
      `),
      /FAI_SERVICE_CATALOG_PUBLICATION_APPEND_ONLY/,
    );
    await assert.rejects(
      db().$executeRawUnsafe(`
        DELETE FROM "ServiceCatalogPublication" WHERE "catalogVersion" = 'n09-db-test-v1'
      `),
      /FAI_SERVICE_CATALOG_PUBLICATION_APPEND_ONLY/,
    );
  });
