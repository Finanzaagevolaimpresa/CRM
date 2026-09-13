import { Prisma, type PrismaClient } from '@prisma/client';
import { FAI_SERVICE_CATALOG, serviceCatalogRevisionHash } from './service-catalog';
import { FAI_SERVICE_CATALOG_V2, FAI_SERVICE_CATALOG_V2_TERMS_VERSION, FAI_SERVICE_CATALOG_V2_VALID_FROM, catalogV2RevisionHash, type CatalogV2Revision } from './service-catalog-v2';

export class CatalogV2PreparationError extends Error {}
type Db = Pick<PrismaClient, '$transaction'>;

export async function prepareServiceCatalogV2(db: Db, actorId: string | null = null) {
  return db.$transaction(async (tx) => {
    const legacy = await tx.serviceCatalogRevision.findMany({ where: { version: 1 }, include: { serviceCatalog: { select: { code: true } } } });
    for (const definition of FAI_SERVICE_CATALOG) {
      const row = legacy.find(({ serviceCatalog }) => serviceCatalog.code === definition.code);
      if (!row || row.contentHash !== serviceCatalogRevisionHash(definition)) throw new CatalogV2PreparationError('SERVICE_CATALOG_V1_CONFLICT');
    }
    let created = 0;
    const legacyCodes = new Set(FAI_SERVICE_CATALOG.map(({ code }) => code));
    const changedDefinitions: readonly CatalogV2Revision[] = FAI_SERVICE_CATALOG_V2.filter((service) => service.revisionVersion > 1 || !legacyCodes.has(service.code));
    for (const definition of changedDefinitions) {
      let catalog = await tx.serviceCatalog.findUnique({ where: { code: definition.code } });
      if (!catalog) catalog = await tx.serviceCatalog.create({ data: { code: definition.code, name: definition.name, description: definition.description, category: definition.category, basePrice: null, active: true, displayOrder: definition.displayOrder } });
      else if (!legacyCodes.has(definition.code) && (catalog.name !== definition.name || catalog.description !== definition.description || catalog.category !== definition.category || catalog.basePrice !== null || catalog.active !== true || catalog.displayOrder !== definition.displayOrder)) throw new CatalogV2PreparationError('SERVICE_CATALOG_MASTER_CONFLICT');
      const expectedHash = catalogV2RevisionHash(definition);
      const existing = await tx.serviceCatalogRevision.findUnique({ where: { serviceCatalogId_version: { serviceCatalogId: catalog.id, version: definition.revisionVersion } } });
      if (existing) {
        if (existing.contentHash !== expectedHash || existing.status !== 'PUBLISHED') throw new CatalogV2PreparationError('SERVICE_CATALOG_V2_CONFLICT');
        continue;
      }
      const published = await tx.serviceCatalogRevision.findFirst({ where: { serviceCatalogId: catalog.id, status: 'PUBLISHED' } });
      if (published) await tx.serviceCatalogRevision.update({ where: { id: published.id }, data: { status: 'RETIRED', retiredAt: new Date() } });
      await tx.serviceCatalogRevision.create({ data: {
        serviceCatalogId: catalog.id, version: definition.revisionVersion, publicName: definition.name,
        shortDescription: definition.description, priceMode: definition.priceMode,
        netPrice: definition.netPriceCents === null ? null : new Prisma.Decimal(definition.netPriceCents).div(100), currency: 'EUR', vatRateBps: 2200,
        validFrom: new Date(FAI_SERVICE_CATALOG_V2_VALID_FROM), termsVersion: FAI_SERVICE_CATALOG_V2_TERMS_VERSION,
        checkoutEnabled: false, autoClientDeliveryAllowed: false, autoExternalActionAllowed: false,
        operationalConditions: { detail: definition.detail, catalogVersion: '2026-09-13-v2' }, checklist: { phaseDocuments: definition.detail.phaseDocuments },
        status: 'PUBLISHED', contentHash: expectedHash, publishedAt: new Date(FAI_SERVICE_CATALOG_V2_VALID_FROM),
      } });
      created += 1;
    }
    if (created) await tx.auditLog.create({ data: { actorId, event: 'service_catalog_v2_prepare', entityType: 'ServiceCatalogRevision', after: { catalogVersion: '2026-09-13-v2', createdRevisions: created } } });
    return { created, currentServices: FAI_SERVICE_CATALOG_V2.length };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
