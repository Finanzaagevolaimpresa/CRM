import assert from 'node:assert/strict';
import test from 'node:test';
import { PrismaClient } from '@prisma/client';
import { catalogRevisionIsSelectable, prepareServiceCatalogV2, CatalogV2PreparationError, storedRevisionMatches } from '../src/lib/service-catalog-v2-persistence';
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

  const before = await db.serviceCatalogRevision.findMany({ where: { status: 'PUBLISHED' }, include: { serviceCatalog: true } });
  assert.equal(FAI_SERVICE_CATALOG_V2.filter((definition) => before.some((row) => row.serviceCatalog.code === definition.code && storedRevisionMatches(definition, row))).length, 9);

  const fiscal = FAI_SERVICE_CATALOG_V2.find(({ code }) => code === 'consulenza_fiscale')!;
  const badCatalog = await db.serviceCatalog.create({ data: { code: fiscal.code, name: fiscal.name, description: fiscal.description, category: fiscal.category, active: true, displayOrder: fiscal.displayOrder } });
  const bad = await db.serviceCatalogRevision.create({ data: { serviceCatalogId: badCatalog.id, version: 1, publicName: fiscal.name, shortDescription: 'contenuto sintetico incompatibile', priceMode: 'QUOTE_ONLY', netPrice: null, validFrom: new Date(fiscal.validFrom), termsVersion: fiscal.termsVersion, operationalConditions: ['HUMAN_REVIEW_REQUIRED'], checklist: ['REQUEST_COMPLETE'], status: 'RETIRED', contentHash: catalogV2RevisionHash(fiscal) } });
  await assert.rejects(prepareServiceCatalogV2(db), (error: unknown) => error instanceof CatalogV2PreparationError && error.message === 'SERVICE_CATALOG_V2_CONFLICT');
  await db.serviceCatalogRevision.delete({ where: { id: bad.id } }); await db.serviceCatalog.delete({ where: { id: badCatalog.id } });

  await db.$executeRawUnsafe(`CREATE FUNCTION "synthetic_catalog_audit_fault"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event = 'service_catalog_v2_prepare' THEN RAISE EXCEPTION 'synthetic audit fault'; END IF; RETURN NEW; END $$`);
  await db.$executeRawUnsafe(`CREATE TRIGGER "synthetic_catalog_audit_fault" BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION "synthetic_catalog_audit_fault"()`);
  try { await assert.rejects(prepareServiceCatalogV2(db)); }
  finally { await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "synthetic_catalog_audit_fault" ON "AuditLog"`); await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "synthetic_catalog_audit_fault"()`); }
  assert.equal(await db.serviceCatalogRevision.count({ where: { termsVersion: 'TERMS-v2' } }), 0);
  assert.equal(await db.serviceCatalog.count({ where: { code: { in: ['consulenza_fiscale', 'pianificazione_ottimizzazione_fiscale'] } } }), 0);
  assert.equal((await db.serviceCatalogRevision.findUniqueOrThrow({ where: { id: legacyRevision.id } })).status, 'PUBLISHED');

  assert.deepEqual(await prepareServiceCatalogV2(db), { created: 4, currentServices: 13 });
  assert.deepEqual(await prepareServiceCatalogV2(db), { created: 0, currentServices: 13 });
  const current = await db.serviceCatalogRevision.findMany({ where: { status: 'PUBLISHED' }, include: { serviceCatalog: true } });
  assert.equal(current.length, 13);
  assert.equal(FAI_SERVICE_CATALOG_V2.filter((definition) => current.some((row) => row.serviceCatalog.code === definition.code && storedRevisionMatches(definition, row))).length, 13);
  const currentOptimization = current.find(({ serviceCatalog }) => serviceCatalog.code === 'ottimizzazione_aziendale_ai')!;
  const currentDefinition = FAI_SERVICE_CATALOG_V2.find(({ code }) => code === 'ottimizzazione_aziendale_ai')!;
  const atStart = new Date(currentDefinition.validFrom);
  assert.equal(catalogRevisionIsSelectable(currentDefinition, currentOptimization, atStart), true);
  assert.equal(catalogRevisionIsSelectable(currentDefinition, { ...currentOptimization, validUntil: atStart }, atStart), false);
  assert.equal(catalogRevisionIsSelectable(currentDefinition, { ...currentOptimization, validFrom: new Date(atStart.getTime() + 1) }, atStart), false);
  const legacyCodes = new Set(FAI_SERVICE_CATALOG.map(({ code }) => code));
  for (const definition of FAI_SERVICE_CATALOG_V2.filter((service) => service.revisionVersion > 1 || !legacyCodes.has(service.code))) {
    const row = current.find(({ serviceCatalog }) => serviceCatalog.code === definition.code)!;
    assert.equal(row.contentHash, catalogV2RevisionHash(definition)); assert.equal(row.checkoutEnabled, false); assert.equal(row.autoClientDeliveryAllowed, false); assert.equal(row.autoExternalActionAllowed, false);
  }
  const unchangedContract = await db.contract.findUniqueOrThrow({ where: { id: contract.id } });
  assert.equal(Number(unchangedContract.taxableAmount), 1490); assert.equal(unchangedContract.serviceDescription, `2026-07-12-v1/${legacyRevision.contentHash}`);
  assert.equal((await db.clientService.findUniqueOrThrow({ where: { id: engagement.id } })).contractId, contract.id);

  const future = await db.serviceCatalogRevision.create({ data: { serviceCatalogId: optimization.id, version: 3, publicName: 'Revisione futura sintetica', shortDescription: 'Non deve essere retrocessa.', priceMode: 'QUOTE_ONLY', netPrice: null, validFrom: new Date('2026-10-01T00:00:00Z'), termsVersion: 'TERMS-future', operationalConditions: ['HUMAN_REVIEW_REQUIRED'], checklist: ['REQUEST_COMPLETE'], status: 'RETIRED', contentHash: 'b'.repeat(64) } });
  const auditCount = await db.auditLog.count({ where: { event: 'service_catalog_v2_prepare' } });
  await assert.rejects(prepareServiceCatalogV2(db), (error: unknown) => error instanceof CatalogV2PreparationError && error.message === 'SERVICE_CATALOG_FUTURE_REVISION_CONFLICT');
  assert.equal((await db.serviceCatalogRevision.findUniqueOrThrow({ where: { id: future.id } })).status, 'RETIRED');
  assert.equal(await db.auditLog.count({ where: { event: 'service_catalog_v2_prepare' } }), auditCount);
  await db.serviceCatalogRevision.delete({ where: { id: future.id } });
});
