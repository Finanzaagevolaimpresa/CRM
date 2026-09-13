import assert from 'node:assert/strict';
import test from 'node:test';
import { PrismaClient } from '@prisma/client';
import { prepareServiceCatalogV2, CatalogV2PreparationError } from '../src/lib/service-catalog-v2-persistence';
import { FAI_SERVICE_CATALOG, serviceCatalogRevisionHash } from '../src/lib/service-catalog';
import { FAI_SERVICE_CATALOG_V2, catalogV2RevisionHash } from '../src/lib/service-catalog-v2';
import { assertAiOrchestratorEphemeralDatabaseIdentity, assertAiOrchestratorEphemeralDbTestConfiguration } from './db/ai-orchestrator-db-test-guard';

const enabled = assertAiOrchestratorEphemeralDbTestConfiguration({ requested: process.env.RUN_DB_TESTS === '1', destructiveConfirmed: process.env.AI_ORCHESTRATOR_DB_TESTS_CONFIRMED === '1', databaseUrl: process.env.DATABASE_URL, sentinel: process.env.AI_ORCHESTRATOR_DB_TEST_SENTINEL, appEnvironment: process.env.APP_ENV, nodeEnvironment: process.env.NODE_ENV });
const db = new PrismaClient();

test.before(async () => { if (enabled) await assertAiOrchestratorEphemeralDatabaseIdentity(db); });
test.after(() => db.$disconnect());

test('PostgreSQL prepares v2 atomically and idempotently without changing v1 or an accepted engagement', { skip: !enabled }, async () => {
  const optimization = await db.serviceCatalog.findUniqueOrThrow({ where: { code: 'ottimizzazione_aziendale_ai' } });
  const legacyRevision = await db.serviceCatalogRevision.findUniqueOrThrow({ where: { serviceCatalogId_version: { serviceCatalogId: optimization.id, version: 1 } } });
  assert.equal(legacyRevision.contentHash, serviceCatalogRevisionHash(FAI_SERVICE_CATALOG.find(({ code }) => code === optimization.code)!));
  const client = await db.client.create({ data: { type: 'societa', displayName: 'Cliente sintetico catalogo v2' } });
  const contract = await db.contract.create({ data: { clientId: client.id, contractNumber: 'SYNTHETIC-CATALOG-V1', serviceName: optimization.name, serviceDescription: `2026-07-12-v1/${legacyRevision.contentHash}`, taxableAmount: 1490, vatAmount: 327.8, totalAmount: 1817.8, status: 'firmato' } });
  const engagement = await db.clientService.create({ data: { clientId: client.id, serviceCatalogId: optimization.id, contractId: contract.id, status: 'pagato' } });

  const fiscal = FAI_SERVICE_CATALOG_V2.find(({ code }) => code === 'consulenza_fiscale')!;
  const badCatalog = await db.serviceCatalog.create({ data: { code: fiscal.code, name: fiscal.name, description: fiscal.description, category: fiscal.category, active: true, displayOrder: fiscal.displayOrder } });
  const bad = await db.serviceCatalogRevision.create({ data: { serviceCatalogId: badCatalog.id, version: 1, publicName: fiscal.name, shortDescription: fiscal.description, priceMode: 'QUOTE_ONLY', netPrice: null, validFrom: new Date('2026-09-13T00:00:00Z'), termsVersion: 'TERMS-v2', operationalConditions: {}, checklist: {}, status: 'RETIRED', contentHash: 'a'.repeat(64) } });
  await assert.rejects(prepareServiceCatalogV2(db), (error: unknown) => error instanceof CatalogV2PreparationError && error.message === 'SERVICE_CATALOG_V2_CONFLICT');
  await db.serviceCatalogRevision.delete({ where: { id: bad.id } }); await db.serviceCatalog.delete({ where: { id: badCatalog.id } });

  await db.$executeRawUnsafe(`CREATE FUNCTION "synthetic_catalog_audit_fault"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event = 'service_catalog_v2_prepare' THEN RAISE EXCEPTION 'synthetic audit fault'; END IF; RETURN NEW; END $$`);
  await db.$executeRawUnsafe(`CREATE TRIGGER "synthetic_catalog_audit_fault" BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION "synthetic_catalog_audit_fault"()`);
  try { await assert.rejects(prepareServiceCatalogV2(db)); }
  finally { await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "synthetic_catalog_audit_fault" ON "AuditLog"`); await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "synthetic_catalog_audit_fault"()`); }
  assert.equal(await db.serviceCatalogRevision.count({ where: { termsVersion: 'TERMS-v2' } }), 0);
  assert.equal((await db.serviceCatalogRevision.findUniqueOrThrow({ where: { id: legacyRevision.id } })).status, 'PUBLISHED');

  assert.deepEqual(await prepareServiceCatalogV2(db), { created: 4, currentServices: 13 });
  assert.deepEqual(await prepareServiceCatalogV2(db), { created: 0, currentServices: 13 });
  const current = await db.serviceCatalogRevision.findMany({ where: { status: 'PUBLISHED' }, include: { serviceCatalog: true } });
  assert.equal(current.length, 13);
  const legacyCodes = new Set(FAI_SERVICE_CATALOG.map(({ code }) => code));
  for (const definition of FAI_SERVICE_CATALOG_V2.filter((service) => service.revisionVersion > 1 || !legacyCodes.has(service.code))) {
    const row = current.find(({ serviceCatalog }) => serviceCatalog.code === definition.code)!;
    assert.equal(row.contentHash, catalogV2RevisionHash(definition)); assert.equal(row.checkoutEnabled, false); assert.equal(row.autoClientDeliveryAllowed, false); assert.equal(row.autoExternalActionAllowed, false);
  }
  const unchangedContract = await db.contract.findUniqueOrThrow({ where: { id: contract.id } });
  assert.equal(Number(unchangedContract.taxableAmount), 1490); assert.equal(unchangedContract.serviceDescription, `2026-07-12-v1/${legacyRevision.contentHash}`);
  assert.equal((await db.clientService.findUniqueOrThrow({ where: { id: engagement.id } })).contractId, contract.id);
});
