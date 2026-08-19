import { createHmac, timingSafeEqual } from 'node:crypto';
import { assertSha256, canonicalJson, sha256 } from './canonical-json';
import {
  FAI_SERVICE_CATALOG,
  FAI_SERVICE_CATALOG_VALID_FROM,
  FAI_SERVICE_CATALOG_VERSION,
  type ServiceCatalogDefinition,
  validateServiceCatalogDefinitions,
} from './service-catalog';

export const SERVICE_CATALOG_PUBLICATION_SCHEMA_VERSION = 1 as const;
export const SERVICE_CATALOG_SIGNATURE_VERSION = 'hmac-sha256-v1' as const;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
  }
  return value;
}

export function buildServiceCatalogPublicSnapshot(
  services: readonly ServiceCatalogDefinition[] = FAI_SERVICE_CATALOG,
) {
  validateServiceCatalogDefinitions(services);
  return deepFreeze({
    schemaVersion: SERVICE_CATALOG_PUBLICATION_SCHEMA_VERSION,
    catalogVersion: FAI_SERVICE_CATALOG_VERSION,
    validFrom: FAI_SERVICE_CATALOG_VALID_FROM,
    services: [...services]
      .sort((left, right) => left.displayOrder - right.displayOrder)
      .map((service) => ({
        code: service.code,
        version: 1,
        name: service.name,
        priceMode: service.priceMode,
        netPriceCents: service.netPriceCents,
        currency: service.currency,
        vatRateBps: service.vatRateBps,
        validFrom: service.validFrom,
        validUntil: null,
        termsVersion: service.termsVersion,
        checkoutEnabled: service.checkoutEnabled,
        operationalConditionCodes: [...service.operationalConditionCodes],
      })),
  });
}

export type ServiceCatalogPublicSnapshot = ReturnType<typeof buildServiceCatalogPublicSnapshot>;

export interface ServiceCatalogSignedPublication {
  readonly schemaVersion: typeof SERVICE_CATALOG_PUBLICATION_SCHEMA_VERSION;
  readonly catalogVersion: string;
  readonly signatureVersion: typeof SERVICE_CATALOG_SIGNATURE_VERSION;
  readonly keyVersion: number;
  readonly payload: ServiceCatalogPublicSnapshot;
  readonly payloadHash: string;
  readonly signature: string;
}

function normalizeSigningKey(key: Uint8Array | string) {
  const normalized = typeof key === 'string' ? Buffer.from(key, 'utf8') : Buffer.from(key);
  if (normalized.byteLength < 32) throw new TypeError('SERVICE_CATALOG_SIGNING_KEY_TOO_SHORT');
  return normalized;
}

function assertKeyVersion(keyVersion: number) {
  if (!Number.isSafeInteger(keyVersion) || keyVersion < 1) {
    throw new TypeError('SERVICE_CATALOG_KEY_VERSION_INVALID');
  }
  return keyVersion;
}

function signatureFor(payload: ServiceCatalogPublicSnapshot, key: Uint8Array | string) {
  return createHmac('sha256', normalizeSigningKey(key))
    .update(canonicalJson(payload), 'utf8')
    .digest('base64url');
}

export function signServiceCatalogSnapshot(input: {
  readonly snapshot: ServiceCatalogPublicSnapshot;
  readonly key: Uint8Array | string;
  readonly keyVersion: number;
}): ServiceCatalogSignedPublication {
  const keyVersion = assertKeyVersion(input.keyVersion);
  const payloadJson = canonicalJson(input.snapshot);
  return deepFreeze({
    schemaVersion: SERVICE_CATALOG_PUBLICATION_SCHEMA_VERSION,
    catalogVersion: input.snapshot.catalogVersion,
    signatureVersion: SERVICE_CATALOG_SIGNATURE_VERSION,
    keyVersion,
    payload: input.snapshot,
    payloadHash: sha256(payloadJson),
    signature: signatureFor(input.snapshot, input.key),
  });
}

export function verifyServiceCatalogPublication(
  publication: ServiceCatalogSignedPublication,
  key: Uint8Array | string,
) {
  if (publication.schemaVersion !== SERVICE_CATALOG_PUBLICATION_SCHEMA_VERSION
    || publication.signatureVersion !== SERVICE_CATALOG_SIGNATURE_VERSION) return false;
  try {
    assertKeyVersion(publication.keyVersion);
    assertSha256(publication.payloadHash, 'Service catalog payload hash');
  } catch {
    return false;
  }
  if (!SIGNATURE_PATTERN.test(publication.signature)) return false;
  const payloadJson = canonicalJson(publication.payload);
  if (sha256(payloadJson) !== publication.payloadHash
    || publication.catalogVersion !== publication.payload.catalogVersion) return false;
  const expected = signatureFor(publication.payload, key);
  const actualBuffer = Buffer.from(publication.signature, 'ascii');
  const expectedBuffer = Buffer.from(expected, 'ascii');
  return actualBuffer.byteLength === expectedBuffer.byteLength
    && timingSafeEqual(actualBuffer, expectedBuffer);
}
