import { z } from 'zod';
import { Prisma, type ServiceCatalogRevision } from '@prisma/client';
import { DIGITAL_PROJECT_TYPES, FAI_SERVICE_CATALOG_V2, catalogV2RevisionHash, catalogV2Storage, type CatalogV2Revision } from './service-catalog-v2';
import { canonicalJson } from './canonical-json';

export const adminCatalogVersion = 'FAI_ADMIN_INTERNAL_V1';
const lines = z.array(z.string().trim().min(1).max(2000)).min(1).max(50);
export const adminCatalogDetailSchema = z.object({
  inclusions: lines, exclusions: lines, phaseDocuments: lines, timing: z.string().trim().min(1).max(2000),
  deliverables: lines, subsequentEngagements: lines, professionalAttribution: z.string().trim().max(2000).optional(),
  digitalProjectTypes: z.unknown().optional(),
}).strict();
type Stored = Pick<ServiceCatalogRevision, 'version' | 'publicName' | 'shortDescription' | 'netPrice' | 'currency' |
  'vatRateBps' | 'validFrom' | 'termsVersion' | 'checkoutEnabled' | 'autoClientDeliveryAllowed' | 'autoExternalActionAllowed' |
  'operationalConditions' | 'checklist' | 'contentHash'> & { priceMode: string; serviceCatalog: { code: string } };

/** Internal operational revisions have a typed, hashed content format. They
 * never create a signed external publication or enable automated operations. */
export function administrativeCatalogDefinition(code: string, version: number, values: {
  publicName: string; shortDescription: string; priceMode: string; netPrice: unknown; validFrom: Date;
  termsVersion: string; operationalConditions: unknown; checklist: unknown;
}): CatalogV2Revision {
  const conditions = z.array(z.unknown()).length(5).parse(values.operationalConditions);
  const descriptor = z.object({ catalogVersion: z.literal(adminCatalogVersion), detail: adminCatalogDetailSchema }).strict().parse(conditions[4]);
  const detail = descriptor.detail;
  if (code === 'progetti_digitali') {
    if (canonicalJson(detail.digitalProjectTypes) !== canonicalJson(DIGITAL_PROJECT_TYPES)) throw new Error('ADMIN_CATALOG_DIGITAL_TYPES');
  } else if (detail.digitalProjectTypes !== undefined) throw new Error('ADMIN_CATALOG_DIGITAL_TYPES');
  const netPriceCents = values.netPrice === null ? null : new Prisma.Decimal(String(values.netPrice)).mul(100).toNumber();
  if (!Number.isSafeInteger(version) || version < 1 || !/^[A-Za-z0-9_-]{1,120}$/.test(code)
    || !values.publicName.trim() || !values.shortDescription.trim() || !values.termsVersion.trim()
    || !['FIXED', 'QUOTE_ONLY'].includes(values.priceMode)
    || (values.priceMode === 'QUOTE_ONLY') !== (netPriceCents === null)
    || (netPriceCents !== null && (!Number.isSafeInteger(netPriceCents) || netPriceCents < 0))
    || !Number.isFinite(values.validFrom.getTime())) throw new Error('ADMIN_CATALOG_INVALID');
  const definition: CatalogV2Revision = {
    code, name: values.publicName, description: values.shortDescription, category: 'catalogo_interno', displayOrder: 0,
    revisionVersion: version, sourceCatalogVersion: adminCatalogVersion, validFrom: values.validFrom.toISOString(),
    termsVersion: values.termsVersion, priceMode: values.priceMode as 'FIXED' | 'QUOTE_ONLY', netPriceCents,
    detail: detail as CatalogV2Revision['detail'],
  };
  const storage = catalogV2Storage(definition);
  if (canonicalJson(storage.operationalConditions) !== canonicalJson(values.operationalConditions)
    || canonicalJson(storage.checklist) !== canonicalJson(values.checklist)) throw new Error('ADMIN_CATALOG_REQUIRED_CONDITIONS');
  return definition;
}

export function definitionForStoredCatalogRevision(row: Stored): CatalogV2Revision | null {
  const legacy = FAI_SERVICE_CATALOG_V2.find(item => item.code === row.serviceCatalog.code && item.revisionVersion === row.version);
  if (legacy) return legacy;
  try {
    const definition = administrativeCatalogDefinition(row.serviceCatalog.code, row.version, row);
    if (row.currency !== 'EUR' || row.vatRateBps !== 2200 || row.checkoutEnabled || row.autoClientDeliveryAllowed
      || row.autoExternalActionAllowed || row.contentHash !== catalogV2RevisionHash(definition)) return null;
    return definition;
  } catch { return null; }
}

export function validateStoredCatalogSelection(service: CatalogV2Revision, type?: string | null) {
  const digitalProjectType = type ? DIGITAL_PROJECT_TYPES.find(item => item.code === type) : undefined;
  if (service.code === 'progetti_digitali' ? !digitalProjectType : Boolean(type)) throw new Error('SERVICE_CATALOG_DIGITAL_TYPE_INCOMPATIBLE');
  return { service, digitalProjectType };
}
