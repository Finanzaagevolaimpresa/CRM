import { canonicalJson, sha256 } from './canonical-json';
import { assertClassifiedFields } from './data-classification';
import {
  FAI_SERVICE_CATALOG,
  FAI_SERVICE_CATALOG_VERSION,
} from './service-catalog';

export const LEAD_EVENT_SCHEMA_VERSION = 'fai.lead-event.v1' as const;
export const LEAD_EVENT_TYPE = 'LEAD_SUBMITTED' as const;
export const LEAD_EVENT_VERSION = 1 as const;
export const LEAD_EVENT_CANONICALIZATION_VERSION = 1 as const;
export const MAX_LEAD_EVENT_BYTES = 16 * 1024;

export const LEAD_EVENT_CONTRACT_ERROR_CODES = Object.freeze([
  'LEAD_EVENT_ENVELOPE_INVALID',
  'LEAD_EVENT_SCHEMA_UNSUPPORTED',
  'LEAD_EVENT_TYPE_UNSUPPORTED',
  'LEAD_EVENT_VERSION_UNSUPPORTED',
  'LEAD_EVENT_FIELD_UNKNOWN',
  'LEAD_EVENT_FIELD_INVALID',
  'LEAD_EVENT_TOO_LARGE',
  'LEAD_EVENT_PRIVACY_INVALID',
  'LEAD_EVENT_CATALOG_REFERENCE_INVALID',
  'LEAD_EVENT_HASH_INVALID',
  'LEAD_EVENT_IDEMPOTENCY_CONFLICT',
  'LEAD_EVENT_INTERNAL_FAILURE',
] as const);

export type LeadEventContractErrorCode = typeof LEAD_EVENT_CONTRACT_ERROR_CODES[number];

export class LeadEventContractError extends Error {
  constructor(readonly code: LeadEventContractErrorCode) {
    super(code);
    this.name = 'LeadEventContractError';
  }
}

export interface LeadEventSourceV1 {
  readonly systemCode: string;
  readonly formCode: string;
  readonly formVersion: string;
  readonly submissionId: string;
}

export interface LeadEventPrivacyReferenceV1 {
  readonly noticeCode: string;
  readonly noticeVersion: string;
  readonly purposeCode: string;
  readonly legalBasisCode: string;
  readonly evidenceKind: string;
  readonly decision: string;
}

export interface LeadEventPrivacyV1 {
  readonly service: LeadEventPrivacyReferenceV1;
  readonly marketing: LeadEventPrivacyReferenceV1;
}

export interface LeadEventCatalogReferenceV1 {
  readonly catalogVersion: typeof FAI_SERVICE_CATALOG_VERSION;
  readonly serviceCode: string;
  readonly serviceVersion: 1;
}

export interface LeadEventRequestedAmountV1 {
  readonly currency: 'EUR';
  readonly minorUnits: number;
}

export interface LeadEventPayloadV1 {
  readonly firstName?: string;
  readonly lastName?: string;
  readonly companyName?: string;
  readonly email?: string;
  readonly phone?: string;
  readonly city?: string;
  readonly region?: string;
  readonly interestText?: string;
  readonly serviceInterestText?: string;
  readonly message?: string;
  readonly sourcePagePath?: string;
  readonly requestedAmount?: LeadEventRequestedAmountV1;
}

export interface LeadEventIdempotencyV1 {
  readonly canonicalizationVersion: typeof LEAD_EVENT_CANONICALIZATION_VERSION;
  readonly keyDigest: string;
  readonly payloadHash: string;
}

export interface LeadSubmittedEventV1 {
  readonly schemaVersion: typeof LEAD_EVENT_SCHEMA_VERSION;
  readonly eventType: typeof LEAD_EVENT_TYPE;
  readonly eventVersion: typeof LEAD_EVENT_VERSION;
  readonly eventId: string;
  readonly businessCorrelationId: string;
  readonly occurredAt: string;
  readonly source: LeadEventSourceV1;
  readonly privacy: LeadEventPrivacyV1;
  readonly catalogReference: LeadEventCatalogReferenceV1 | null;
  readonly payload: LeadEventPayloadV1;
  readonly idempotency: LeadEventIdempotencyV1;
}

export interface LeadSubmittedEventInputV1 {
  readonly eventId: string;
  readonly businessCorrelationId: string;
  readonly occurredAt: string;
  readonly source: LeadEventSourceV1;
  readonly privacy: LeadEventPrivacyV1;
  readonly catalogReference?: LeadEventCatalogReferenceV1 | null;
  readonly payload: LeadEventPayloadV1;
}

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONTRACT_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_.:-]*$/;
const CONTRACT_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
const SERVICE_CODE_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const RFC3339_MILLISECOND_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SOURCE_PAGE_DOT_SEGMENT_PATTERN = /^(?:\.|%2e){1,2}$/iu;
const FORBIDDEN_TEXT_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;
const SERVICE_CODES = new Set(FAI_SERVICE_CATALOG.map(({ code }) => code));

function fail(code: LeadEventContractErrorCode): never {
  throw new LeadEventContractError(code);
}

function readPlainRecord(value: unknown, invalidCode: LeadEventContractErrorCode) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(invalidCode);
  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch {
    return fail(invalidCode);
  }
  if (prototype !== Object.prototype && prototype !== null) fail(invalidCode);
  return value as Record<string, unknown>;
}

function readRequiredDataField(
  value: Record<string, unknown>,
  key: string,
  invalidCode: LeadEventContractErrorCode,
) {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    return fail(invalidCode);
  }
  if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
    fail(invalidCode);
  }
  return descriptor.value;
}

function readExactRecord(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
  invalidCode: LeadEventContractErrorCode,
) {
  const record = readPlainRecord(value, invalidCode);
  let keys: PropertyKey[];
  try {
    keys = Reflect.ownKeys(record);
  } catch {
    return fail(invalidCode);
  }
  const allowedKeys = new Set(allowed);
  const output: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof key !== 'string' || !allowedKeys.has(key)) {
      fail('LEAD_EVENT_FIELD_UNKNOWN');
    }
    output[key] = readRequiredDataField(record, key, invalidCode);
  }
  for (const key of required) {
    if (!Object.hasOwn(output, key)) fail(invalidCode);
  }
  return output;
}

function assertLeadEventDiscriminators(value: Record<string, unknown>) {
  const schemaVersion = readRequiredDataField(
    value,
    'schemaVersion',
    'LEAD_EVENT_ENVELOPE_INVALID',
  );
  if (schemaVersion !== LEAD_EVENT_SCHEMA_VERSION) {
    fail('LEAD_EVENT_SCHEMA_UNSUPPORTED');
  }
  const eventType = readRequiredDataField(
    value,
    'eventType',
    'LEAD_EVENT_ENVELOPE_INVALID',
  );
  if (eventType !== LEAD_EVENT_TYPE) fail('LEAD_EVENT_TYPE_UNSUPPORTED');
  const eventVersion = readRequiredDataField(
    value,
    'eventVersion',
    'LEAD_EVENT_ENVELOPE_INVALID',
  );
  if (eventVersion !== LEAD_EVENT_VERSION) fail('LEAD_EVENT_VERSION_UNSUPPORTED');
}

function normalizedText(value: unknown, maximum: number, allowEmpty = false) {
  if (typeof value !== 'string') fail('LEAD_EVENT_FIELD_INVALID');
  let normalized: string;
  try {
    normalized = value.normalize('NFC').trim();
  } catch {
    return fail('LEAD_EVENT_FIELD_INVALID');
  }
  if ((!allowEmpty && normalized.length === 0)
    || normalized.length > maximum
    || FORBIDDEN_TEXT_PATTERN.test(normalized)) {
    fail('LEAD_EVENT_FIELD_INVALID');
  }
  return normalized;
}

function optionalText(value: unknown, maximum: number) {
  if (value === undefined) return undefined;
  const normalized = normalizedText(value, maximum, true);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizedContractCode(value: unknown) {
  const normalized = normalizedText(value, 120);
  if (!CONTRACT_CODE_PATTERN.test(normalized)) fail('LEAD_EVENT_FIELD_INVALID');
  return normalized;
}

function normalizedContractVersion(value: unknown) {
  const normalized = normalizedText(value, 80);
  if (!CONTRACT_VERSION_PATTERN.test(normalized)) fail('LEAD_EVENT_FIELD_INVALID');
  return normalized;
}

function normalizedUuid(value: unknown) {
  const normalized = normalizedText(value, 36).toLowerCase();
  if (!UUID_V4_PATTERN.test(normalized)) fail('LEAD_EVENT_FIELD_INVALID');
  return normalized;
}

function normalizedTimestamp(value: unknown) {
  const normalized = normalizedText(value, 29);
  const parts = RFC3339_MILLISECOND_PATTERN.exec(normalized);
  if (!parts) fail('LEAD_EVENT_FIELD_INVALID');
  const calendar = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(normalized);
  if (!calendar) fail('LEAD_EVENT_FIELD_INVALID');
  const [, rawYear, rawMonth, rawDay, rawHour, rawMinute, rawSecond] = calendar;
  const year = Number(rawYear);
  const month = Number(rawMonth);
  const day = Number(rawDay);
  const validDay = month >= 1 && month <= 12
    ? new Date(Date.UTC(year, month, 0)).getUTCDate()
    : 0;
  if (day < 1 || day > validDay
    || Number(rawHour) > 23
    || Number(rawMinute) > 59
    || Number(rawSecond) > 59) {
    fail('LEAD_EVENT_FIELD_INVALID');
  }
  const timestamp = Date.parse(normalized);
  if (!Number.isFinite(timestamp)) fail('LEAD_EVENT_FIELD_INVALID');
  try {
    return new Date(timestamp).toISOString();
  } catch {
    return fail('LEAD_EVENT_FIELD_INVALID');
  }
}

function normalizeSource(value: unknown): LeadEventSourceV1 {
  const source = readExactRecord(
    value,
    ['systemCode', 'formCode', 'formVersion', 'submissionId'],
    ['systemCode', 'formCode', 'formVersion', 'submissionId'],
    'LEAD_EVENT_FIELD_INVALID',
  );
  const submissionId = normalizedText(source.submissionId, 128);
  if (!CONTRACT_VERSION_PATTERN.test(submissionId)) fail('LEAD_EVENT_FIELD_INVALID');
  return {
    systemCode: normalizedContractCode(source.systemCode),
    formCode: normalizedContractCode(source.formCode),
    formVersion: normalizedContractVersion(source.formVersion),
    submissionId,
  };
}

function normalizePrivacyReference(value: unknown, kind: 'service' | 'marketing') {
  const privacy = readExactRecord(
    value,
    ['noticeCode', 'noticeVersion', 'purposeCode', 'legalBasisCode', 'evidenceKind', 'decision'],
    ['noticeCode', 'noticeVersion', 'purposeCode', 'legalBasisCode', 'evidenceKind', 'decision'],
    'LEAD_EVENT_PRIVACY_INVALID',
  );
  const normalized = {
    noticeCode: normalizedContractCode(privacy.noticeCode),
    noticeVersion: normalizedContractVersion(privacy.noticeVersion),
    purposeCode: normalizedContractCode(privacy.purposeCode),
    legalBasisCode: normalizedContractCode(privacy.legalBasisCode),
    evidenceKind: normalizedContractCode(privacy.evidenceKind),
    decision: normalizedContractCode(privacy.decision),
  };
  const valid = kind === 'service'
    ? normalized.purposeCode === 'SERVICE_REQUEST_FOLLOW_UP'
      && normalized.legalBasisCode === 'PRE_CONTRACTUAL_MEASURES'
      && normalized.evidenceKind === 'NOTICE_ACKNOWLEDGEMENT'
      && normalized.decision === 'ACKNOWLEDGED'
    : normalized.purposeCode === 'DIRECT_MARKETING'
      && normalized.legalBasisCode === 'CONSENT'
      && normalized.evidenceKind === 'CONSENT'
      && (normalized.decision === 'GRANTED' || normalized.decision === 'DENIED');
  if (!valid) fail('LEAD_EVENT_PRIVACY_INVALID');
  return normalized;
}

function normalizePrivacy(value: unknown): LeadEventPrivacyV1 {
  const privacy = readExactRecord(
    value,
    ['service', 'marketing'],
    ['service', 'marketing'],
    'LEAD_EVENT_PRIVACY_INVALID',
  );
  return {
    service: normalizePrivacyReference(privacy.service, 'service'),
    marketing: normalizePrivacyReference(privacy.marketing, 'marketing'),
  };
}

function normalizeCatalogReference(value: unknown): LeadEventCatalogReferenceV1 | null {
  if (value === undefined || value === null) return null;
  const reference = readExactRecord(
    value,
    ['catalogVersion', 'serviceCode', 'serviceVersion'],
    ['catalogVersion', 'serviceCode', 'serviceVersion'],
    'LEAD_EVENT_CATALOG_REFERENCE_INVALID',
  );
  if (reference.catalogVersion !== FAI_SERVICE_CATALOG_VERSION
    || reference.serviceVersion !== 1
    || typeof reference.serviceCode !== 'string'
    || !SERVICE_CODE_PATTERN.test(reference.serviceCode)
    || !SERVICE_CODES.has(reference.serviceCode)) {
    fail('LEAD_EVENT_CATALOG_REFERENCE_INVALID');
  }
  return {
    catalogVersion: FAI_SERVICE_CATALOG_VERSION,
    serviceCode: reference.serviceCode,
    serviceVersion: 1,
  };
}

function normalizeRequestedAmount(value: unknown): LeadEventRequestedAmountV1 | undefined {
  if (value === undefined) return undefined;
  const amount = readExactRecord(
    value,
    ['currency', 'minorUnits'],
    ['currency', 'minorUnits'],
    'LEAD_EVENT_FIELD_INVALID',
  );
  if (amount.currency !== 'EUR'
    || !Number.isSafeInteger(amount.minorUnits)
    || (amount.minorUnits as number) < 0) {
    fail('LEAD_EVENT_FIELD_INVALID');
  }
  return { currency: 'EUR', minorUnits: amount.minorUnits as number };
}

function normalizePayload(value: unknown): LeadEventPayloadV1 {
  const payload = readExactRecord(
    value,
    [
      'firstName', 'lastName', 'companyName', 'email', 'phone', 'city', 'region',
      'interestText', 'serviceInterestText', 'message', 'sourcePagePath', 'requestedAmount',
    ],
    [],
    'LEAD_EVENT_FIELD_INVALID',
  );
  const output: Record<string, unknown> = {};
  for (const [key, maximum] of [
    ['firstName', 1_000], ['lastName', 1_000], ['companyName', 1_000],
    ['city', 1_000], ['region', 1_000], ['interestText', 1_000],
    ['serviceInterestText', 1_000], ['message', 4_000],
  ] as const) {
    const normalized = optionalText(payload[key], maximum);
    if (normalized !== undefined) output[key] = normalized;
  }
  if (payload.email !== undefined) {
    const email = normalizedText(payload.email, 254).toLowerCase();
    if (email.length > 254 || !EMAIL_PATTERN.test(email)) fail('LEAD_EVENT_FIELD_INVALID');
    output.email = email;
  }
  if (payload.phone !== undefined) {
    const phone = normalizedText(payload.phone, 100).replace(/\s+/gu, '');
    if (phone.length === 0 || phone.length > 50) fail('LEAD_EVENT_FIELD_INVALID');
    output.phone = phone;
  }
  if (!output.email && !output.phone) fail('LEAD_EVENT_FIELD_INVALID');
  if (payload.sourcePagePath !== undefined) {
    const path = normalizedText(payload.sourcePagePath, 500);
    if (!path.startsWith('/') || path.startsWith('//') || /[\u0009\u000A\u000D?#\\]/u.test(path)) {
      fail('LEAD_EVENT_FIELD_INVALID');
    }
    if (path.split('/').some((segment) => SOURCE_PAGE_DOT_SEGMENT_PATTERN.test(segment))) {
      fail('LEAD_EVENT_FIELD_INVALID');
    }
    output.sourcePagePath = path;
  }
  const requestedAmount = normalizeRequestedAmount(payload.requestedAmount);
  if (requestedAmount) output.requestedAmount = requestedAmount;
  return output as LeadEventPayloadV1;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
  }
  return value;
}

function leadEventKeyDigest(source: LeadEventSourceV1) {
  return sha256(`fai.lead-event.idempotency.v1\n${canonicalJson(source)}`);
}

function leadEventPayloadHash(event: Omit<LeadSubmittedEventV1, 'idempotency'>) {
  return sha256(`fai.lead-event.payload.v1\n${canonicalJson(event)}`);
}

function buildEvent(input: Record<string, unknown>): LeadSubmittedEventV1 {
  const core = {
    schemaVersion: LEAD_EVENT_SCHEMA_VERSION,
    eventType: LEAD_EVENT_TYPE,
    eventVersion: LEAD_EVENT_VERSION,
    eventId: normalizedUuid(input.eventId),
    businessCorrelationId: normalizedUuid(input.businessCorrelationId),
    occurredAt: normalizedTimestamp(input.occurredAt),
    source: normalizeSource(input.source),
    privacy: normalizePrivacy(input.privacy),
    catalogReference: normalizeCatalogReference(input.catalogReference),
    payload: normalizePayload(input.payload),
  } as const;
  const event: LeadSubmittedEventV1 = {
    ...core,
    idempotency: {
      canonicalizationVersion: LEAD_EVENT_CANONICALIZATION_VERSION,
      keyDigest: leadEventKeyDigest(core.source),
      payloadHash: leadEventPayloadHash(core),
    },
  };
  try {
    assertClassifiedFields('lead_business_event_v1', event);
  } catch {
    return fail('LEAD_EVENT_FIELD_UNKNOWN');
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(event);
  } catch {
    return fail('LEAD_EVENT_ENVELOPE_INVALID');
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_LEAD_EVENT_BYTES) {
    fail('LEAD_EVENT_TOO_LARGE');
  }
  return deepFreeze(event);
}

export function createLeadSubmittedEventV1(input: unknown): LeadSubmittedEventV1 {
  const draft = readExactRecord(
    input,
    ['eventId', 'businessCorrelationId', 'occurredAt', 'source', 'privacy', 'catalogReference', 'payload'],
    ['eventId', 'businessCorrelationId', 'occurredAt', 'source', 'privacy', 'payload'],
    'LEAD_EVENT_ENVELOPE_INVALID',
  );
  return buildEvent(draft);
}

export function parseLeadSubmittedEventV1(value: unknown): LeadSubmittedEventV1 {
  const candidate = readPlainRecord(value, 'LEAD_EVENT_ENVELOPE_INVALID');
  assertLeadEventDiscriminators(candidate);
  const envelope = readExactRecord(
    candidate,
    [
      'schemaVersion', 'eventType', 'eventVersion', 'eventId', 'businessCorrelationId',
      'occurredAt', 'source', 'privacy', 'catalogReference', 'payload', 'idempotency',
    ],
    [
      'schemaVersion', 'eventType', 'eventVersion', 'eventId', 'businessCorrelationId',
      'occurredAt', 'source', 'privacy', 'catalogReference', 'payload', 'idempotency',
    ],
    'LEAD_EVENT_ENVELOPE_INVALID',
  );
  assertLeadEventDiscriminators(envelope);
  const supplied = readExactRecord(
    envelope.idempotency,
    ['canonicalizationVersion', 'keyDigest', 'payloadHash'],
    ['canonicalizationVersion', 'keyDigest', 'payloadHash'],
    'LEAD_EVENT_HASH_INVALID',
  );
  if (supplied.canonicalizationVersion !== LEAD_EVENT_CANONICALIZATION_VERSION
    || typeof supplied.keyDigest !== 'string'
    || typeof supplied.payloadHash !== 'string'
    || !SHA256_PATTERN.test(supplied.keyDigest)
    || !SHA256_PATTERN.test(supplied.payloadHash)) {
    fail('LEAD_EVENT_HASH_INVALID');
  }
  const normalized = buildEvent(envelope);
  if (normalized.idempotency.keyDigest !== supplied.keyDigest
    || normalized.idempotency.payloadHash !== supplied.payloadHash) {
    fail('LEAD_EVENT_HASH_INVALID');
  }
  return normalized;
}

export type LeadEventIdempotencyComparison = 'NEW' | 'REPLAY' | 'CONFLICT';

export function compareLeadEventIdempotencyV1(
  stored: Readonly<{ keyDigest: string; payloadHash: string }> | null,
  candidate: LeadSubmittedEventV1,
): LeadEventIdempotencyComparison {
  const normalizedCandidate = parseLeadSubmittedEventV1(candidate);
  if (!stored) return 'NEW';
  if (!SHA256_PATTERN.test(stored.keyDigest) || !SHA256_PATTERN.test(stored.payloadHash)) {
    fail('LEAD_EVENT_HASH_INVALID');
  }
  if (stored.keyDigest !== normalizedCandidate.idempotency.keyDigest) return 'NEW';
  return stored.payloadHash === normalizedCandidate.idempotency.payloadHash ? 'REPLAY' : 'CONFLICT';
}
