import assert from 'node:assert/strict';
import test from 'node:test';
import { Prisma } from '@prisma/client';
import { adminCatalogVersion, administrativeCatalogDefinition, definitionForStoredCatalogRevision, validateStoredCatalogSelection } from '../src/lib/admin-catalog-revision';
import { DIGITAL_PROJECT_TYPES, FAI_SERVICE_CATALOG_V2, catalogV2RevisionHash, catalogV2Storage, type CatalogV2Revision } from '../src/lib/service-catalog-v2';
import { selectableStoredCatalogRevision, availableStoredCatalogDefinitions } from '../src/lib/service-catalog-v2-persistence';

function fixture(code = 'synthetic_admin_service') {
  const definition: CatalogV2Revision = {
    code, name: 'Servizio sintetico', description: 'Solo prova isolata', category: 'catalogo_interno', displayOrder: 0,
    revisionVersion: 3, sourceCatalogVersion: adminCatalogVersion, validFrom: '2026-10-01T00:00:00.000Z',
    termsVersion: 'SYNTHETIC-v1', priceMode: 'FIXED', netPriceCents: 29,
    detail: { inclusions: ['Attività sintetica'], exclusions: ['Invii reali'], phaseDocuments: ['Documento sintetico'],
      timing: 'Da concordare', deliverables: ['Rapporto sintetico'], subsequentEngagements: ['Incarico distinto'],
      ...(code === 'progetti_digitali' ? { digitalProjectTypes: DIGITAL_PROJECT_TYPES } : {}) },
  };
  return stored(definition);
}
function stored(definition: CatalogV2Revision) {
  const storage = catalogV2Storage(definition);
  return { version: definition.revisionVersion, publicName: definition.name, shortDescription: definition.description,
    priceMode: definition.priceMode, netPrice: definition.netPriceCents === null ? null : new Prisma.Decimal(definition.netPriceCents).div(100),
    currency: 'EUR', vatRateBps: 2200, validFrom: new Date(definition.validFrom), validUntil: null,
    termsVersion: definition.termsVersion, checkoutEnabled: false, autoClientDeliveryAllowed: false, autoExternalActionAllowed: false,
    operationalConditions: storage.operationalConditions as Prisma.JsonValue, checklist: storage.checklist as Prisma.JsonValue,
    contentHash: catalogV2RevisionHash(definition), status: 'PUBLISHED', serviceCatalog: { code: definition.code, active: true } };
}
const now = new Date('2026-10-15T10:00:00.000Z');

test('administrative prices retain exact cents and reject fractional cents or contradictory quote prices', () => {
  const row = fixture();
  assert.equal(selectableStoredCatalogRevision(row, now)?.netPriceCents, 29);
  for (const netPrice of ['0.001', '-0.01', '90071992547409.92']) {
    assert.throws(() => administrativeCatalogDefinition(row.serviceCatalog.code, row.version, { ...row, netPrice }));
  }
  assert.throws(() => administrativeCatalogDefinition(row.serviceCatalog.code, row.version, { ...row, priceMode: 'QUOTE_ONLY' }));
  assert.throws(() => administrativeCatalogDefinition(row.serviceCatalog.code, row.version, { ...row, netPrice: null }));
});

test('new internal catalogue content cannot activate automation, bypass its hash or survive retirement and expiry', () => {
  const row = fixture();
  for (const patch of [{ checkoutEnabled: true }, { autoClientDeliveryAllowed: true }, { autoExternalActionAllowed: true },
    { contentHash: 'f'.repeat(64) }, { publicName: 'Alterato' }, { currency: 'USD' }, { vatRateBps: 0 },
    { status: 'RETIRED' }, { validUntil: now }, { serviceCatalog: { ...row.serviceCatalog, active: false } }]) {
    assert.equal(selectableStoredCatalogRevision({ ...row, ...patch }, now), null);
  }
  const expiry = new Date(now.getTime() + 1);
  assert.ok(selectableStoredCatalogRevision({ ...row, validUntil: expiry }, now));
  assert.equal(selectableStoredCatalogRevision(row, new Date(row.validFrom.getTime() - 1)), null);
  const incompatible = structuredClone(row.operationalConditions) as unknown[];
  incompatible[0] = 'NO_REVIEW';
  assert.equal(definitionForStoredCatalogRevision({ ...row, operationalConditions: incompatible as Prisma.JsonValue }), null);
  const unknown = structuredClone(row.operationalConditions) as unknown[];
  unknown[4] = { ...(unknown[4] as object), catalogVersion: 'UNREVIEWED_FORMAT' };
  assert.equal(definitionForStoredCatalogRevision({ ...row, operationalConditions: unknown as Prisma.JsonValue }), null);
});

test('digital classifications remain exact and incompatible selections cannot leak into another service', () => {
  const row = fixture('progetti_digitali'), definition = definitionForStoredCatalogRevision(row)!;
  for (const type of DIGITAL_PROJECT_TYPES) assert.equal(validateStoredCatalogSelection(definition, type.code).digitalProjectType?.code, type.code);
  assert.throws(() => validateStoredCatalogSelection(definition));
  assert.throws(() => validateStoredCatalogSelection(definition, 'inventato'));
  assert.throws(() => validateStoredCatalogSelection(definitionForStoredCatalogRevision(fixture())!, DIGITAL_PROJECT_TYPES[0].code));
  const altered = structuredClone(row.operationalConditions) as unknown[];
  const descriptor = altered[4] as { detail: Record<string,unknown> };
  descriptor.detail.digitalProjectTypes = [];
  assert.equal(definitionForStoredCatalogRevision({ ...row, operationalConditions: altered as Prisma.JsonValue }), null);
});

test('native catalogue hashes stay selectable while a valid newer internal revision supersedes only its service', () => {
  const legacy = FAI_SERVICE_CATALOG_V2.map(stored);
  assert.equal(availableStoredCatalogDefinitions(legacy, now).length, FAI_SERVICE_CATALOG_V2.length);
  for (const row of legacy) {
    assert.ok(selectableStoredCatalogRevision(row, now));
    assert.equal(selectableStoredCatalogRevision({ ...row, publicName: 'Nome alterato' }, now), null);
  }
  const next = fixture('progetti_digitali');
  const available = availableStoredCatalogDefinitions([...legacy, next], now);
  assert.equal(available.length, FAI_SERVICE_CATALOG_V2.length);
  assert.equal(available.find(row => row.code === 'progetti_digitali')?.revisionVersion, 3);
});
