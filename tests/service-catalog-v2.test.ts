import assert from 'node:assert/strict';
import test from 'node:test';
import { FAI_SERVICE_CATALOG, serviceCatalogRevisionHash } from '../src/lib/service-catalog';
import { DIGITAL_PROJECT_TYPES, FAI_SERVICE_CATALOG_V2, buildCatalogV2Snapshot, catalogV2RevisionHash, validateCatalogSelection } from '../src/lib/service-catalog-v2';

const V1_HASHES = ['b65caabbfbe3254a3b9c1e6ec15fe46f0ac933ea0d5bdf04e5b6422a9b3162ba','3cc766f8e183f303c3a41de46c74b60476378b19c0a5b060aaff5ab0e1b80414','f24ef3716ea79137514aee77fd9c10b7b961ddf672c2fcac28db5f8370b4e421','5417a3d79118131b4ad48971aaa20ed9eadd6534dc8ff4c29e84a29311e6b48f','cca3176f5ce832bcc6c963fd9a5c562643ae1d75c82249240fea0f756c75f8a5','ca4e3ed7d3febf3fda7df6b9d60bd9de37cd8ebf1b5955f006df6d1cf1b2858f','48d041d1b5310147d4849fd87aed1adfb80808d04bf2813053610603ee91e73b','f14463d36dd6d383cf18c0a42d41e378158f38d65284303293511b513a1cbff8','bcef5084ed8eb1dadb81c675bffcd10a6532a913f3ef8df292418c7a78200343','ad5f581363adc8c32d375523f3a6fa9eacc519e6d5622d9681ad3a2c875d766d','7d681ccd1532cc7fa580f7cd273535d369eca884e2a1518b61859e864f8b1db1'];

test('v1 remains byte-characterized while v2 has 13 distinct current services', () => {
  assert.deepEqual(FAI_SERVICE_CATALOG.map(serviceCatalogRevisionHash), V1_HASHES);
  assert.equal(FAI_SERVICE_CATALOG.length, 11);
  assert.equal(FAI_SERVICE_CATALOG_V2.length, 13);
  assert.equal(new Set(FAI_SERVICE_CATALOG_V2.map(({ code }) => code)).size, 13);
  assert.equal(buildCatalogV2Snapshot().services.length, 13);
  for (const service of FAI_SERVICE_CATALOG_V2) assert.match(catalogV2RevisionHash(service), /^[0-9a-f]{64}$/u);
});

test('business optimization and two distinct fiscal services are quote-only without fake zero prices', () => {
  for (const code of ['ottimizzazione_aziendale_ai', 'consulenza_fiscale', 'pianificazione_ottimizzazione_fiscale']) {
    const service = validateCatalogSelection(code).service;
    assert.equal(service.priceMode, 'QUOTE_ONLY'); assert.equal(service.netPriceCents, null);
  }
  assert.notEqual(validateCatalogSelection('consulenza_fiscale').service.name, validateCatalogSelection('pianificazione_ottimizzazione_fiscale').service.name);
  assert.equal(JSON.stringify(FAI_SERVICE_CATALOG_V2).includes('149000'), false);
});

test('seven digital classifications validate only for Progetti Digitali', () => {
  assert.equal(DIGITAL_PROJECT_TYPES.length, 7);
  for (const type of DIGITAL_PROJECT_TYPES) assert.equal(validateCatalogSelection('progetti_digitali', type.code).digitalProjectType, type.code);
  assert.throws(() => validateCatalogSelection('progetti_digitali', 'sconosciuta'), /DIGITAL_TYPE_INCOMPATIBLE/u);
  assert.throws(() => validateCatalogSelection('consulenza_fiscale', DIGITAL_PROJECT_TYPES[0].code), /DIGITAL_TYPE_INCOMPATIBLE/u);
  assert.throws(() => validateCatalogSelection('sconosciuto'), /SELECTION_UNKNOWN/u);
});
