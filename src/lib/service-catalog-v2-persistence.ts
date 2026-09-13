import { Prisma, type PrismaClient } from '@prisma/client';
import { FAI_SERVICE_CATALOG, serviceCatalogRevisionHash } from './service-catalog';
import { FAI_SERVICE_CATALOG_V2, catalogV2RevisionHash, catalogV2Storage, type CatalogV2Revision } from './service-catalog-v2';

export class CatalogV2PreparationError extends Error {}
type Db = Pick<PrismaClient, '$transaction' | '$queryRaw'>;
const SENTINEL = 'FAI_CRM_EPHEMERAL_TEST_ONLY_V1';

function configurationIsSynthetic() {
  let url: URL;
  try { url = new URL(process.env.DATABASE_URL ?? ''); } catch { throw new CatalogV2PreparationError('SERVICE_CATALOG_SYNTHETIC_CONFIGURATION_DENIED'); }
  const environment = `${process.env.APP_ENV ?? ''}/${process.env.NODE_ENV ?? ''}`.toLowerCase();
  if (process.env.RUN_DB_TESTS !== '1' || process.env.AI_ORCHESTRATOR_DB_TESTS_CONFIRMED !== '1'
    || process.env.AI_ORCHESTRATOR_DB_TEST_SENTINEL !== SENTINEL || environment.includes('production')
    || !['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname.toLowerCase())
    || decodeURIComponent(url.pathname.slice(1)) !== 'fai_crm_test' || (url.searchParams.get('schema') ?? 'public') !== 'public') {
    throw new CatalogV2PreparationError('SERVICE_CATALOG_SYNTHETIC_CONFIGURATION_DENIED');
  }
}

export async function assertSyntheticCatalogDatabase(db: Db) {
  configurationIsSynthetic();
  const rows = await db.$queryRaw<Array<{ databaseName: string; schemaName: string | null; serverAddress: string | null; sentinel: string | null }>>(Prisma.sql`
    SELECT CURRENT_DATABASE() AS "databaseName", CURRENT_SCHEMA() AS "schemaName",
      INET_SERVER_ADDR()::TEXT AS "serverAddress", SHOBJ_DESCRIPTION(oid, 'pg_database') AS "sentinel"
    FROM pg_database WHERE datname = CURRENT_DATABASE()
  `);
  const row = rows[0];
  if (!row || row.databaseName !== 'fai_crm_test' || row.schemaName !== 'public' || !row.serverAddress || row.sentinel !== SENTINEL) {
    throw new CatalogV2PreparationError('SERVICE_CATALOG_SYNTHETIC_DATABASE_DENIED');
  }
}

type StoredRevision = { version: number; publicName: string; shortDescription: string; priceMode: string; netPrice: Prisma.Decimal | null; currency: string; vatRateBps: number; validFrom: Date; termsVersion: string; checkoutEnabled: boolean; autoClientDeliveryAllowed: boolean; autoExternalActionAllowed: boolean; operationalConditions: Prisma.JsonValue; checklist: Prisma.JsonValue; contentHash: string; status: string };
const sameJson = (left: Prisma.JsonValue, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
export function storedRevisionMatches(service: CatalogV2Revision, row: StoredRevision) {
  const storage = catalogV2Storage(service);
  return row.version === service.revisionVersion && row.publicName === service.name
    && row.shortDescription === service.description && row.priceMode === service.priceMode
    && (row.netPrice === null ? null : Number(row.netPrice) * 100) === service.netPriceCents
    && row.currency === 'EUR' && row.vatRateBps === 2200 && row.validFrom.toISOString() === service.validFrom
    && row.termsVersion === service.termsVersion && !row.checkoutEnabled && !row.autoClientDeliveryAllowed
    && !row.autoExternalActionAllowed && sameJson(row.operationalConditions, storage.operationalConditions)
    && sameJson(row.checklist, storage.checklist) && row.contentHash === catalogV2RevisionHash(service);
}

export async function prepareServiceCatalogV2(db: Db, actorId: string | null = null) {
  await assertSyntheticCatalogDatabase(db);
  return db.$transaction(async (tx) => {
    const legacy = await tx.serviceCatalogRevision.findMany({ where: { version: 1 }, include: { serviceCatalog: true } });
    for (const definition of FAI_SERVICE_CATALOG) {
      const row = legacy.find(({ serviceCatalog }) => serviceCatalog.code === definition.code);
      if (!row || row.contentHash !== serviceCatalogRevisionHash(definition)
        || row.publicName !== definition.name || row.shortDescription !== definition.description
        || row.priceMode !== definition.priceMode || (row.netPrice === null ? null : Number(row.netPrice) * 100) !== definition.netPriceCents
        || row.currency !== definition.currency || row.vatRateBps !== definition.vatRateBps
        || row.validFrom.toISOString() !== definition.validFrom || row.termsVersion !== definition.termsVersion
        || row.checkoutEnabled || row.autoClientDeliveryAllowed || row.autoExternalActionAllowed
        || !sameJson(row.operationalConditions, definition.operationalConditionCodes)
        || !sameJson(row.checklist, definition.checklistCodes)
        || row.serviceCatalog.name !== definition.name || row.serviceCatalog.description !== definition.description
        || row.serviceCatalog.category !== definition.category || (row.serviceCatalog.basePrice === null ? null : Number(row.serviceCatalog.basePrice) * 100) !== definition.netPriceCents) {
        throw new CatalogV2PreparationError('SERVICE_CATALOG_V1_CONFLICT');
      }
    }
    let created = 0;
    const legacyCodes = new Set(FAI_SERVICE_CATALOG.map(({ code }) => code));
    const changed = FAI_SERVICE_CATALOG_V2.filter((service) => service.sourceCatalogVersion === '2026-09-13-v2');
    for (const definition of changed) {
      let catalog = await tx.serviceCatalog.findUnique({ where: { code: definition.code }, include: { revisions: true } });
      if (!catalog) catalog = await tx.serviceCatalog.create({ data: { code: definition.code, name: definition.name, description: definition.description, category: definition.category, basePrice: null, active: true, displayOrder: definition.displayOrder }, include: { revisions: true } });
      else if (!legacyCodes.has(definition.code) && (catalog.name !== definition.name || catalog.description !== definition.description || catalog.category !== definition.category || catalog.basePrice !== null || !catalog.active || catalog.displayOrder !== definition.displayOrder)) throw new CatalogV2PreparationError('SERVICE_CATALOG_MASTER_CONFLICT');
      if (catalog.revisions.some(({ version }) => version !== 1 && version !== 2) || catalog.revisions.some(({ version }) => version > definition.revisionVersion)) throw new CatalogV2PreparationError('SERVICE_CATALOG_FUTURE_REVISION_CONFLICT');
      const existing = catalog.revisions.find(({ version }) => version === definition.revisionVersion);
      if (existing) {
        if (existing.status !== 'PUBLISHED' || !storedRevisionMatches(definition, existing)) throw new CatalogV2PreparationError('SERVICE_CATALOG_V2_CONFLICT');
        continue;
      }
      const expectedPrevious = legacyCodes.has(definition.code) ? catalog.revisions.find(({ version }) => version === 1) : undefined;
      if (legacyCodes.has(definition.code) && (!expectedPrevious || expectedPrevious.status !== 'PUBLISHED')) throw new CatalogV2PreparationError('SERVICE_CATALOG_PREVIOUS_REVISION_CONFLICT');
      if (catalog.revisions.some((revision) => revision.status === 'PUBLISHED' && revision.id !== expectedPrevious?.id)) throw new CatalogV2PreparationError('SERVICE_CATALOG_PUBLISHED_REVISION_CONFLICT');
      if (expectedPrevious) await tx.serviceCatalogRevision.update({ where: { id: expectedPrevious.id }, data: { status: 'RETIRED', retiredAt: new Date() } });
      const storage = catalogV2Storage(definition);
      await tx.serviceCatalogRevision.create({ data: { serviceCatalogId: catalog.id, version: definition.revisionVersion, publicName: definition.name, shortDescription: definition.description, priceMode: definition.priceMode, netPrice: definition.netPriceCents === null ? null : new Prisma.Decimal(definition.netPriceCents).div(100), currency: 'EUR', vatRateBps: 2200, validFrom: new Date(definition.validFrom), termsVersion: definition.termsVersion, checkoutEnabled: false, autoClientDeliveryAllowed: false, autoExternalActionAllowed: false, operationalConditions: storage.operationalConditions, checklist: storage.checklist, status: 'PUBLISHED', contentHash: catalogV2RevisionHash(definition), publishedAt: new Date(definition.validFrom) } });
      created += 1;
    }
    if (created) await tx.auditLog.create({ data: { actorId, event: 'service_catalog_v2_prepare', entityType: 'ServiceCatalogRevision', after: { catalogVersion: '2026-09-13-v2', createdRevisions: created } } });
    return { created, currentServices: FAI_SERVICE_CATALOG_V2.length };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
