import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import {
  FAI_SERVICE_CATALOG,
  FAI_SERVICE_CATALOG_VERSION,
  serviceCatalogRevisionHash,
  validateServiceCatalogDefinitions,
} from '../src/lib/service-catalog';
import {
  buildServiceCatalogPublicSnapshot,
  signServiceCatalogSnapshot,
  verifyServiceCatalogPublication,
} from '../src/lib/service-catalog-publication';

const migrationPath = 'prisma/migrations/20260819120000_service_catalog_signed_publication_v1/migration.sql';
const migration = readFileSync(migrationPath, 'utf8');

test('N09 aligns exactly 11 stable services with the approved commercial register', () => {
  assert.equal(validateServiceCatalogDefinitions(), true);
  assert.equal(Object.isFrozen(FAI_SERVICE_CATALOG), true);
  assert.equal(FAI_SERVICE_CATALOG.length, 11);
  assert.equal(new Set(FAI_SERVICE_CATALOG.map(({ code }) => code)).size, 11);
  assert.deepEqual(FAI_SERVICE_CATALOG.map(({ displayOrder }) => displayOrder),
    Array.from({ length: 11 }, (_, index) => index + 1));
  assert.equal(FAI_SERVICE_CATALOG.filter(({ priceMode }) => priceMode === 'FIXED').length, 8);
  assert.equal(FAI_SERVICE_CATALOG.filter(({ priceMode }) => priceMode === 'QUOTE_ONLY').length, 3);
  assert.deepEqual(
    Object.fromEntries(FAI_SERVICE_CATALOG.map(({ code, netPriceCents }) => [code, netPriceCents])),
    {
      verifica_ai_essenziale: 19_000,
      audit_ai_bancabilita: 39_000,
      pre_analisi_ai_ammissibilita: 49_000,
      consulenza_strategica_60: 50_000,
      dossier_preanalisi: 89_000,
      ottimizzazione_ai_progetto: 125_000,
      business_plan_presentazione_bancaria: 169_000,
      ottimizzazione_aziendale_ai: 149_000,
      progetti_digitali: null,
      gestione_misure: null,
      rendicontazione: null,
    },
  );
  for (const service of FAI_SERVICE_CATALOG) {
    assert.equal(service.currency, 'EUR');
    assert.equal(service.vatRateBps, 2_200);
    assert.equal(service.termsVersion, 'TERMS-v1');
    assert.equal(service.checkoutEnabled, false);
    assert.equal(service.autoClientDeliveryAllowed, false);
    assert.equal(service.autoExternalActionAllowed, false);
    assert.match(serviceCatalogRevisionHash(service), /^[0-9a-f]{64}$/);
  }
});

test('N09 catalog validation fails closed on duplicate, pricing and activation drift', () => {
  const copy = FAI_SERVICE_CATALOG.map((service) => ({ ...service }));
  assert.throws(() => validateServiceCatalogDefinitions(copy.slice(0, 10)), /COUNT_INVALID/);
  assert.throws(() => validateServiceCatalogDefinitions([
    ...copy.slice(0, 10), { ...copy[10]!, code: copy[0]!.code },
  ]), /CODE_INVALID/);
  assert.throws(() => validateServiceCatalogDefinitions([
    { ...copy[0]!, priceMode: 'QUOTE_ONLY', netPriceCents: 1 }, ...copy.slice(1),
  ]), /QUOTE_PRICE_INVALID/);
  assert.throws(() => validateServiceCatalogDefinitions([
    { ...copy[0]!, checkoutEnabled: true as never }, ...copy.slice(1),
  ]), /DORMANT_SAFETY_INVALID/);
});

test('N09 signed snapshot is minimized, deterministic and tamper evident', () => {
  const snapshot = buildServiceCatalogPublicSnapshot();
  assert.equal(snapshot.catalogVersion, FAI_SERVICE_CATALOG_VERSION);
  assert.equal(snapshot.services.length, 11);
  assert.equal(Object.isFrozen(snapshot), true);
  const encoded = JSON.stringify(snapshot);
  for (const forbidden of ['description', 'checklist', 'client', 'seo', 'rawPayload']) {
    assert.equal(encoded.includes(forbidden), false);
  }
  const key = 'n09-deterministic-test-key-32-bytes-minimum';
  const first = signServiceCatalogSnapshot({ snapshot, key, keyVersion: 1 });
  const second = signServiceCatalogSnapshot({ snapshot, key, keyVersion: 1 });
  assert.deepEqual(first, second);
  assert.match(first.payloadHash, /^[0-9a-f]{64}$/);
  assert.match(first.signature, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(verifyServiceCatalogPublication(first, key), true);
  assert.equal(verifyServiceCatalogPublication(first, `${key}-wrong`), false);
  const tampered = {
    ...first,
    payload: {
      ...first.payload,
      services: first.payload.services.map((service, index) => index === 0
        ? { ...service, netPriceCents: 1 }
        : service),
    },
  };
  assert.equal(verifyServiceCatalogPublication(tampered, key), false);
  assert.throws(() => signServiceCatalogSnapshot({ snapshot, key: 'short', keyVersion: 1 }),
    /KEY_TOO_SHORT/);
});

test('N09 migration 37 is transactional, additive and dormant by construction', () => {
  const names = readdirSync('prisma/migrations').filter((name) => /^\d/.test(name)).sort();
  assert.equal(names.length, 42);
  assert.equal(names[36], '20260819120000_service_catalog_signed_publication_v1');
  assert.match(migration, /^BEGIN;/);
  assert.match(migration, /COMMIT;\s*$/);
  assert.match(migration, /CREATE TABLE "ServiceCatalogRevision"/);
  assert.match(migration, /CREATE TABLE "ServiceCatalogPublication"/);
  assert.match(migration, /ServiceCatalogRevision_immutable_trigger/);
  assert.match(migration, /ServiceCatalogPublication_append_only_trigger/);
  assert.match(migration, /ServiceCatalogRevision_dormant_checkout_check/);
  assert.match(migration, /WHERE "code" IN \('supporto_finanza_ordinaria', 'supporto_finanza_agevolata'\)/);
  assert.equal((migration.match(/00000000-0000-4000-8000-0000000000\d{2}/g) ?? []).length, 11);
  assert.doesNotMatch(migration, /^\s*(?:DROP|TRUNCATE|DELETE)\b/im);
  assert.doesNotMatch(migration, /INSERT INTO "ApplicationKeyVersion"/);
  assert.doesNotMatch(migration, /INSERT INTO "ServiceCatalogPublication"/);
});

test('N09 foundation contains no runtime publication, network, WordPress or checkout activation', () => {
  const source = [
    readFileSync('src/lib/service-catalog.ts', 'utf8'),
    readFileSync('src/lib/service-catalog-publication.ts', 'utf8'),
  ].join('\n');
  assert.doesNotMatch(source, /process\.env|fetch\(|https?:\/\/|stripe|wordpress/i);
  assert.doesNotMatch(source, /checkoutEnabled:\s*true/);
  const documentation = readFileSync('docs/n09-service-catalog-revision-signed-publication-v1.md', 'utf8');
  assert.match(documentation, /non pubblica nulla verso WordPress/);
  assert.match(documentation, /non abilita checkout o Stripe/);
  assert.match(documentation, /€1\.490 \+ IVA/);
});
