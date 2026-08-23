import { randomUUID } from 'node:crypto';
import type { DataClassification } from './data-classification';

export const OPERATIONAL_TELEMETRY_SCHEMA_VERSION = 'n06-v1' as const;
export const OPERATIONAL_TELEMETRY_CATALOG_VERSION = 'n06-v1' as const;

export const OPERATIONAL_TELEMETRY_LIMITS = Object.freeze({
  maxEnvelopeBytes: 2_048,
  maxMetadataFields: 8,
  maxMetricLabels: 3,
  maxTimestampMs: 253_402_300_799_999,
  maxDurationMs: 86_400_000,
  maxFreshnessSeconds: 604_800,
  maxRedactionDepth: 4,
  maxRedactionFields: 32,
} as const);

export const OPERATIONAL_TELEMETRY_MANIFEST = Object.freeze({
  schemaVersion: OPERATIONAL_TELEMETRY_SCHEMA_VERSION,
  catalogVersion: OPERATIONAL_TELEMETRY_CATALOG_VERSION,
  transport: 'NONE',
  persistence: 'NONE',
  exporterEnabled: false,
  networkEgressAllowed: false,
  externalEndpointAllowed: false,
  freeTextAllowed: false,
  rawPayloadAllowed: false,
  rawErrorAllowed: false,
  dataMode: 'MINIMIZED_OPERATIONAL_OR_SYNTHETIC',
} as const);

const SEVERITIES = Object.freeze(['INFO', 'WARN', 'ERROR'] as const);
const OUTCOMES = Object.freeze(['SUCCESS', 'FAILURE', 'REJECTED', 'DEGRADED'] as const);
const DURATION_BUCKETS = Object.freeze([
  'LT_100_MS',
  'LT_500_MS',
  'LT_1_S',
  'LT_5_S',
  'GTE_5_S',
] as const);
const FRESHNESS_BUCKETS = Object.freeze([
  'LT_60_S',
  'LT_5_M',
  'LT_15_M',
  'LT_1_H',
  'GTE_1_H',
] as const);

export const OPERATIONAL_EVENT_CATALOG = Object.freeze({
  APP_HEALTH_CHECK_COMPLETED: Object.freeze({
    componentCode: 'HEALTH',
    severity: 'INFO',
    outcomes: Object.freeze(['SUCCESS', 'DEGRADED'] as const),
    metadata: Object.freeze({
      databaseState: Object.freeze(['REACHABLE', 'UNREACHABLE'] as const),
    }),
  }),
  DATABASE_REACHABILITY_CHECK_COMPLETED: Object.freeze({
    componentCode: 'DATABASE',
    severity: 'INFO',
    outcomes: Object.freeze(['SUCCESS', 'FAILURE'] as const),
    metadata: Object.freeze({
      databaseState: Object.freeze(['REACHABLE', 'UNREACHABLE'] as const),
    }),
  }),
  CRITICAL_OPERATION_COMPLETED: Object.freeze({
    componentCode: 'APPLICATION',
    severity: 'INFO',
    outcomes: Object.freeze(['SUCCESS', 'FAILURE', 'REJECTED'] as const),
    metadata: Object.freeze({
      operationCode: Object.freeze([
        'WEBSITE_LEAD_INTAKE',
        'SESSION_VALIDATION',
        'AI_RECONCILE',
        'RELEASE_GATE',
      ] as const),
      durationBucket: DURATION_BUCKETS,
    }),
  }),
  COMMERCIAL_LEAD_INBOX_OPERATION_COMPLETED: Object.freeze({
    componentCode: 'COMMERCIAL_LEAD_INBOX',
    severity: 'INFO',
    outcomes: Object.freeze(['SUCCESS', 'FAILURE', 'REJECTED'] as const),
    metadata: Object.freeze({
      operationCode: Object.freeze([
        'INITIALIZE',
        'CLAIM',
        'ASSIGN',
        'UNASSIGN',
        'FIRST_RESPONSE',
        'CLOSE',
        'REOPEN',
      ] as const),
    }),
  }),
  FAIL_CLOSED_GATE_EVALUATED: Object.freeze({
    componentCode: 'SECURITY',
    severity: 'INFO',
    outcomes: Object.freeze(['SUCCESS', 'FAILURE'] as const),
    metadata: Object.freeze({
      gateCode: Object.freeze([
        'INTEGRATIONS',
        'CUSTOMER_PORTAL',
        'PAYMENTS',
        'AI_WORKER',
        'AI_DISPATCH',
        'AI_EGRESS',
        'INTERNAL_SESSION',
        'PRIVILEGED_ACCESS',
      ] as const),
      decision: Object.freeze(['ALLOWED', 'DENIED', 'INVALID'] as const),
    }),
  }),
  OPERATIONAL_TASK_FRESHNESS_EVALUATED: Object.freeze({
    componentCode: 'OPERATIONS',
    severity: 'INFO',
    outcomes: Object.freeze(['SUCCESS', 'DEGRADED'] as const),
    metadata: Object.freeze({
      taskCode: Object.freeze(['AI_RECONCILE', 'BACKUP_VERIFICATION'] as const),
      freshnessBucket: FRESHNESS_BUCKETS,
    }),
  }),
  INTERNAL_ERROR_MAPPED: Object.freeze({
    componentCode: 'APPLICATION',
    severity: 'ERROR',
    outcomes: Object.freeze(['FAILURE'] as const),
    metadata: Object.freeze({
      errorClass: Object.freeze([
        'DEPENDENCY_UNAVAILABLE',
        'CONCURRENCY_RETRYABLE',
        'CONTRACT_REJECTED',
        'INTERNAL_FAILURE',
      ] as const),
      retryability: Object.freeze(['RETRYABLE', 'NON_RETRYABLE'] as const),
    }),
  }),
} as const);

export type OperationalEventCode = keyof typeof OPERATIONAL_EVENT_CATALOG;
export type OperationalSeverity = typeof SEVERITIES[number];
export type OperationalOutcome = typeof OUTCOMES[number];
export type OperationalDurationBucket = typeof DURATION_BUCKETS[number];
export type OperationalFreshnessBucket = typeof FRESHNESS_BUCKETS[number];
export type OperationalCorrelationId = string & { readonly __operationalCorrelationId: unique symbol };

export const OPERATIONAL_TELEMETRY_ERROR_CODES = Object.freeze([
  'TELEMETRY_EVENT_UNKNOWN',
  'TELEMETRY_OUTCOME_INVALID',
  'TELEMETRY_CORRELATION_ID_INVALID',
  'TELEMETRY_TIMESTAMP_INVALID',
  'TELEMETRY_METADATA_INVALID',
  'TELEMETRY_METADATA_UNKNOWN',
  'TELEMETRY_METADATA_VALUE_INVALID',
  'TELEMETRY_ENVELOPE_TOO_LARGE',
  'TELEMETRY_METRIC_UNKNOWN',
  'TELEMETRY_LABELS_INVALID',
  'TELEMETRY_LABEL_UNKNOWN',
  'TELEMETRY_LABEL_VALUE_INVALID',
  'TELEMETRY_METRIC_VALUE_INVALID',
] as const);

export type OperationalTelemetryErrorCode = typeof OPERATIONAL_TELEMETRY_ERROR_CODES[number];

export class OperationalTelemetryContractError extends Error {
  constructor(readonly code: OperationalTelemetryErrorCode) {
    super(code);
    this.name = 'OperationalTelemetryContractError';
  }
}

function fail(code: OperationalTelemetryErrorCode): never {
  throw new OperationalTelemetryContractError(code);
}

const correlationIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isOperationalCorrelationId(value: unknown): value is OperationalCorrelationId {
  return typeof value === 'string' && correlationIdPattern.test(value);
}

export function createOperationalCorrelationId(
  generate: () => string = randomUUID,
): OperationalCorrelationId {
  const value = generate();
  if (!isOperationalCorrelationId(value)) fail('TELEMETRY_CORRELATION_ID_INVALID');
  return value;
}

function canonicalTimestamp(nowMs: number) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0
    || nowMs > OPERATIONAL_TELEMETRY_LIMITS.maxTimestampMs) {
    fail('TELEMETRY_TIMESTAMP_INVALID');
  }
  try {
    return new Date(nowMs).toISOString();
  } catch {
    return fail('TELEMETRY_TIMESTAMP_INVALID');
  }
}

function plainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function ownDataEntries(value: Readonly<Record<string, unknown>>) {
  const entries: [string, unknown][] = [];
  let keys: readonly string[];
  try {
    keys = Object.keys(value);
  } catch {
    return null;
  }
  for (const key of keys) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      return null;
    }
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) continue;
    entries.push([key, descriptor.value]);
  }
  return entries;
}

function boundedJson<T>(value: T): T {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return fail('TELEMETRY_ENVELOPE_TOO_LARGE');
  }
  if (Buffer.byteLength(serialized, 'utf8') > OPERATIONAL_TELEMETRY_LIMITS.maxEnvelopeBytes) {
    fail('TELEMETRY_ENVELOPE_TOO_LARGE');
  }
  return value;
}

function validateExactEnumRecord(
  value: unknown,
  rules: Readonly<Record<string, readonly string[]>>,
  invalidCode: OperationalTelemetryErrorCode,
  unknownCode: OperationalTelemetryErrorCode,
  valueCode: OperationalTelemetryErrorCode,
) {
  if (!plainRecord(value)) fail(invalidCode);
  const entries = ownDataEntries(value);
  if (!entries || entries.length !== Object.keys(rules).length) fail(invalidCode);
  if (entries.length > OPERATIONAL_TELEMETRY_LIMITS.maxMetadataFields) fail(invalidCode);
  const result: Record<string, string> = {};
  for (const [key, candidate] of entries) {
    if (!Object.hasOwn(rules, key)) fail(unknownCode);
    if (typeof candidate !== 'string' || !rules[key].includes(candidate)) fail(valueCode);
    result[key] = candidate;
  }
  for (const key of Object.keys(rules)) {
    if (!Object.hasOwn(result, key)) fail(invalidCode);
  }
  return Object.freeze(result);
}

export interface OperationalEventEnvelopeV1 {
  readonly schemaVersion: typeof OPERATIONAL_TELEMETRY_SCHEMA_VERSION;
  readonly timestamp: string;
  readonly severity: OperationalSeverity;
  readonly eventCode: OperationalEventCode;
  readonly componentCode: string;
  readonly outcome: OperationalOutcome;
  readonly correlationId: OperationalCorrelationId;
  readonly metadata: Readonly<Record<string, string>>;
}

export function createOperationalEventV1(input: {
  readonly eventCode: OperationalEventCode;
  readonly outcome: OperationalOutcome;
  readonly metadata: unknown;
  readonly correlationId?: OperationalCorrelationId;
  readonly nowMs?: number;
}): Readonly<OperationalEventEnvelopeV1> {
  if (!Object.hasOwn(OPERATIONAL_EVENT_CATALOG, input.eventCode)) fail('TELEMETRY_EVENT_UNKNOWN');
  const definition = OPERATIONAL_EVENT_CATALOG[input.eventCode];
  if (!(definition.outcomes as readonly string[]).includes(input.outcome)) {
    fail('TELEMETRY_OUTCOME_INVALID');
  }
  const correlationId = input.correlationId ?? createOperationalCorrelationId();
  if (!isOperationalCorrelationId(correlationId)) fail('TELEMETRY_CORRELATION_ID_INVALID');
  const metadata = validateExactEnumRecord(
    input.metadata,
    definition.metadata,
    'TELEMETRY_METADATA_INVALID',
    'TELEMETRY_METADATA_UNKNOWN',
    'TELEMETRY_METADATA_VALUE_INVALID',
  );
  return boundedJson(Object.freeze({
    schemaVersion: OPERATIONAL_TELEMETRY_SCHEMA_VERSION,
    timestamp: canonicalTimestamp(input.nowMs ?? Date.now()),
    severity: definition.severity,
    eventCode: input.eventCode,
    componentCode: definition.componentCode,
    outcome: input.outcome,
    correlationId,
    metadata,
  }));
}

export function operationalDurationBucket(durationMs: number): OperationalDurationBucket {
  if (!Number.isSafeInteger(durationMs) || durationMs < 0
    || durationMs > OPERATIONAL_TELEMETRY_LIMITS.maxDurationMs) {
    fail('TELEMETRY_METRIC_VALUE_INVALID');
  }
  if (durationMs < 100) return 'LT_100_MS';
  if (durationMs < 500) return 'LT_500_MS';
  if (durationMs < 1_000) return 'LT_1_S';
  if (durationMs < 5_000) return 'LT_5_S';
  return 'GTE_5_S';
}

export function operationalFreshnessBucket(freshnessSeconds: number): OperationalFreshnessBucket {
  if (!Number.isSafeInteger(freshnessSeconds) || freshnessSeconds < 0
    || freshnessSeconds > OPERATIONAL_TELEMETRY_LIMITS.maxFreshnessSeconds) {
    fail('TELEMETRY_METRIC_VALUE_INVALID');
  }
  if (freshnessSeconds < 60) return 'LT_60_S';
  if (freshnessSeconds < 300) return 'LT_5_M';
  if (freshnessSeconds < 900) return 'LT_15_M';
  if (freshnessSeconds < 3_600) return 'LT_1_H';
  return 'GTE_1_H';
}

export const OPERATIONAL_METRIC_CATALOG = Object.freeze({
  APP_HEALTH_AVAILABILITY: Object.freeze({
    kind: 'GAUGE',
    labels: Object.freeze({ status: Object.freeze(['OK', 'DEGRADED'] as const) }),
    minimum: 0,
    maximum: 1,
  }),
  DATABASE_REACHABILITY: Object.freeze({
    kind: 'GAUGE',
    labels: Object.freeze({ state: Object.freeze(['REACHABLE', 'UNREACHABLE'] as const) }),
    minimum: 0,
    maximum: 1,
  }),
  CRITICAL_OPERATION_OUTCOME: Object.freeze({
    kind: 'COUNTER',
    labels: Object.freeze({
      operationCode: Object.freeze([
        'WEBSITE_LEAD_INTAKE',
        'SESSION_VALIDATION',
        'AI_RECONCILE',
        'RELEASE_GATE',
      ] as const),
      outcome: Object.freeze(['SUCCESS', 'FAILURE', 'REJECTED'] as const),
    }),
    minimum: 1,
    maximum: 1,
  }),
  CRITICAL_OPERATION_DURATION_MS: Object.freeze({
    kind: 'HISTOGRAM_OBSERVATION',
    labels: Object.freeze({
      operationCode: Object.freeze([
        'WEBSITE_LEAD_INTAKE',
        'SESSION_VALIDATION',
        'AI_RECONCILE',
        'RELEASE_GATE',
      ] as const),
      durationBucket: DURATION_BUCKETS,
    }),
    minimum: 0,
    maximum: OPERATIONAL_TELEMETRY_LIMITS.maxDurationMs,
  }),
  FAIL_CLOSED_GATE_DECISION: Object.freeze({
    kind: 'COUNTER',
    labels: Object.freeze({
      gateCode: Object.freeze([
        'INTEGRATIONS',
        'CUSTOMER_PORTAL',
        'PAYMENTS',
        'AI_WORKER',
        'AI_DISPATCH',
        'AI_EGRESS',
        'INTERNAL_SESSION',
        'PRIVILEGED_ACCESS',
      ] as const),
      decision: Object.freeze(['ALLOWED', 'DENIED', 'INVALID'] as const),
    }),
    minimum: 1,
    maximum: 1,
  }),
  OPERATIONAL_TASK_FRESHNESS_SECONDS: Object.freeze({
    kind: 'GAUGE',
    labels: Object.freeze({
      taskCode: Object.freeze(['AI_RECONCILE', 'BACKUP_VERIFICATION'] as const),
      freshnessBucket: FRESHNESS_BUCKETS,
    }),
    minimum: 0,
    maximum: OPERATIONAL_TELEMETRY_LIMITS.maxFreshnessSeconds,
  }),
} as const);

export type OperationalMetricCode = keyof typeof OPERATIONAL_METRIC_CATALOG;

export interface OperationalMetricObservationV1 {
  readonly schemaVersion: typeof OPERATIONAL_TELEMETRY_SCHEMA_VERSION;
  readonly metricCode: OperationalMetricCode;
  readonly kind: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly value: number;
}

export function createOperationalMetricObservationV1(input: {
  readonly metricCode: OperationalMetricCode;
  readonly labels: unknown;
  readonly value: number;
}): Readonly<OperationalMetricObservationV1> {
  if (!Object.hasOwn(OPERATIONAL_METRIC_CATALOG, input.metricCode)) fail('TELEMETRY_METRIC_UNKNOWN');
  const definition = OPERATIONAL_METRIC_CATALOG[input.metricCode];
  if (Object.keys(definition.labels).length > OPERATIONAL_TELEMETRY_LIMITS.maxMetricLabels) {
    fail('TELEMETRY_LABELS_INVALID');
  }
  const labels = validateExactEnumRecord(
    input.labels,
    definition.labels,
    'TELEMETRY_LABELS_INVALID',
    'TELEMETRY_LABEL_UNKNOWN',
    'TELEMETRY_LABEL_VALUE_INVALID',
  );
  if (!Number.isSafeInteger(input.value)
    || input.value < definition.minimum
    || input.value > definition.maximum) {
    fail('TELEMETRY_METRIC_VALUE_INVALID');
  }
  return boundedJson(Object.freeze({
    schemaVersion: OPERATIONAL_TELEMETRY_SCHEMA_VERSION,
    metricCode: input.metricCode,
    kind: definition.kind,
    labels,
    value: input.value,
  }));
}

export const OPERATIONAL_REDACTION_MARKER = '[REDACTED:FREE_TEXT]' as const;

export function redactOperationalText(value: unknown) {
  void value;
  return OPERATIONAL_REDACTION_MARKER;
}

const SAFE_STRING_FIELDS = Object.freeze({
  schemaVersion: new Set<string>([OPERATIONAL_TELEMETRY_SCHEMA_VERSION]),
  severity: new Set<string>(SEVERITIES),
  eventCode: new Set<string>(Object.keys(OPERATIONAL_EVENT_CATALOG)),
  metricCode: new Set<string>(Object.keys(OPERATIONAL_METRIC_CATALOG)),
  componentCode: new Set<string>(Object.values(OPERATIONAL_EVENT_CATALOG).map((row) => row.componentCode)),
  outcome: new Set<string>(OUTCOMES),
  kind: new Set<string>(['GAUGE', 'COUNTER', 'HISTOGRAM_OBSERVATION']),
  operationCode: new Set<string>(['WEBSITE_LEAD_INTAKE', 'SESSION_VALIDATION', 'AI_RECONCILE', 'RELEASE_GATE']),
  gateCode: new Set<string>([
    'INTEGRATIONS', 'CUSTOMER_PORTAL', 'PAYMENTS', 'AI_WORKER', 'AI_DISPATCH',
    'AI_EGRESS', 'INTERNAL_SESSION', 'PRIVILEGED_ACCESS',
  ]),
  taskCode: new Set<string>(['AI_RECONCILE', 'BACKUP_VERIFICATION']),
  durationBucket: new Set<string>(DURATION_BUCKETS),
  freshnessBucket: new Set<string>(FRESHNESS_BUCKETS),
  errorClass: new Set<string>([
    'DEPENDENCY_UNAVAILABLE', 'CONCURRENCY_RETRYABLE', 'CONTRACT_REJECTED', 'INTERNAL_FAILURE',
  ]),
  publicCode: new Set<string>(['INVALID_REQUEST', 'TEMPORARILY_UNAVAILABLE', 'INTERNAL_FAILURE']),
  retryability: new Set<string>(['RETRYABLE', 'NON_RETRYABLE']),
  databaseState: new Set<string>(['REACHABLE', 'UNREACHABLE']),
  decision: new Set<string>(['ALLOWED', 'DENIED', 'INVALID']),
  status: new Set<string>(['OK', 'DEGRADED']),
  state: new Set<string>(['REACHABLE', 'UNREACHABLE']),
} as const);
const SAFE_ERROR_CODES = new Set<string>([
  ...OPERATIONAL_TELEMETRY_ERROR_CODES,
  'INVALID_REQUEST',
  'TEMPORARILY_UNAVAILABLE',
  'INTERNAL_FAILURE',
]);
const SAFE_NUMERIC_FIELDS = new Set(['value', 'attempt', 'count', 'durationMs', 'freshnessSeconds']);
const SAFE_BOOLEAN_FIELDS = new Set(['retryable', 'ok', 'reachable']);
const SAFE_NESTED_FIELDS = new Set(['metadata', 'labels', 'error', 'database']);

function safeStringField(key: string, value: string) {
  if (key === 'timestamp') {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return undefined;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
      ? value
      : undefined;
  }
  if (key === 'correlationId') return isOperationalCorrelationId(value) ? value : undefined;
  if (key === 'errorCode') return SAFE_ERROR_CODES.has(value) ? value : undefined;
  const values = SAFE_STRING_FIELDS[key as keyof typeof SAFE_STRING_FIELDS];
  return values?.has(value) ? value : undefined;
}

function sanitizeOperationalRecord(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): Readonly<Record<string, unknown>> {
  if (!plainRecord(value) || depth > OPERATIONAL_TELEMETRY_LIMITS.maxRedactionDepth) {
    return Object.freeze({});
  }
  if (seen.has(value)) return Object.freeze({});
  seen.add(value);
  const entries = ownDataEntries(value);
  if (!entries) return Object.freeze({});
  const output: Record<string, unknown> = {};
  for (const [key, candidate] of entries.slice(0, OPERATIONAL_TELEMETRY_LIMITS.maxRedactionFields)) {
    if (typeof candidate === 'string') {
      const safe = safeStringField(key, candidate);
      if (safe !== undefined) output[key] = safe;
      continue;
    }
    if (typeof candidate === 'number' && SAFE_NUMERIC_FIELDS.has(key)
      && Number.isSafeInteger(candidate) && candidate >= 0) {
      output[key] = candidate;
      continue;
    }
    if (typeof candidate === 'boolean' && SAFE_BOOLEAN_FIELDS.has(key)) {
      output[key] = candidate;
      continue;
    }
    if (SAFE_NESTED_FIELDS.has(key) && candidate !== null && typeof candidate === 'object') {
      output[key] = sanitizeOperationalRecord(candidate, depth + 1, seen);
    }
  }
  return Object.freeze(output);
}

export function redactOperationalPayload(value: unknown): Readonly<Record<string, unknown>> {
  return boundedJson(sanitizeOperationalRecord(value, 0, new WeakSet<object>()));
}

export type OperationalErrorClass =
  | 'DEPENDENCY_UNAVAILABLE'
  | 'CONCURRENCY_RETRYABLE'
  | 'CONTRACT_REJECTED'
  | 'INTERNAL_FAILURE';

export type PublicOperationalErrorCode =
  | 'INVALID_REQUEST'
  | 'TEMPORARILY_UNAVAILABLE'
  | 'INTERNAL_FAILURE';

export interface OperationalErrorDescriptorV1 {
  readonly schemaVersion: typeof OPERATIONAL_TELEMETRY_SCHEMA_VERSION;
  readonly errorClass: OperationalErrorClass;
  readonly publicCode: PublicOperationalErrorCode;
  readonly retryability: 'RETRYABLE' | 'NON_RETRYABLE';
}

const TRANSIENT_DEPENDENCY_CODES = new Set(['P1001', 'P1002', 'P2024']);
const TRANSIENT_CONCURRENCY_CODES = new Set(['P2034', '40001', '40P01']);

function ownString(value: unknown, key: string) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    return undefined;
  }
  return descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'string'
    ? descriptor.value
    : undefined;
}

export function classifyOperationalErrorV1(error: unknown): Readonly<OperationalErrorDescriptorV1> {
  if (error instanceof OperationalTelemetryContractError) {
    return Object.freeze({
      schemaVersion: OPERATIONAL_TELEMETRY_SCHEMA_VERSION,
      errorClass: 'CONTRACT_REJECTED',
      publicCode: 'INVALID_REQUEST',
      retryability: 'NON_RETRYABLE',
    });
  }
  const directCode = ownString(error, 'code');
  let meta: unknown;
  if (error !== null && typeof error === 'object') {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(error, 'meta');
      if (descriptor && Object.hasOwn(descriptor, 'value')) meta = descriptor.value;
    } catch {
      meta = undefined;
    }
  }
  const nestedCode = ownString(meta, 'code');
  const code = directCode ?? nestedCode;
  if (code && TRANSIENT_DEPENDENCY_CODES.has(code)) {
    return Object.freeze({
      schemaVersion: OPERATIONAL_TELEMETRY_SCHEMA_VERSION,
      errorClass: 'DEPENDENCY_UNAVAILABLE',
      publicCode: 'TEMPORARILY_UNAVAILABLE',
      retryability: 'RETRYABLE',
    });
  }
  if (code && TRANSIENT_CONCURRENCY_CODES.has(code)) {
    return Object.freeze({
      schemaVersion: OPERATIONAL_TELEMETRY_SCHEMA_VERSION,
      errorClass: 'CONCURRENCY_RETRYABLE',
      publicCode: 'TEMPORARILY_UNAVAILABLE',
      retryability: 'RETRYABLE',
    });
  }
  return Object.freeze({
    schemaVersion: OPERATIONAL_TELEMETRY_SCHEMA_VERSION,
    errorClass: 'INTERNAL_FAILURE',
    publicCode: 'INTERNAL_FAILURE',
    retryability: 'NON_RETRYABLE',
  });
}

export const OPERATIONAL_SLO_CATALOG = Object.freeze({
  APP_HEALTH_AVAILABILITY_30D: Object.freeze({
    sli: 'successful APP_HEALTH_CHECK_COMPLETED / all completed APP_HEALTH_CHECK_COMPLETED',
    targetBasisPoints: 9_990,
    rollingWindowSeconds: 2_592_000,
    denominator: 'every completed internal health probe',
    failure: 'DEGRADED response, timeout, malformed response or missing sample',
    exclusions: Object.freeze(['declared maintenance window before it starts']),
  }),
  DATABASE_REACHABILITY_30D: Object.freeze({
    sli: 'successful DATABASE_REACHABILITY_CHECK_COMPLETED / all completed database checks',
    targetBasisPoints: 9_990,
    rollingWindowSeconds: 2_592_000,
    denominator: 'every database check initiated by the health contract',
    failure: 'unreachable, timeout, invalid result or missing sample',
    exclusions: Object.freeze(['declared maintenance window before it starts']),
  }),
  CRITICAL_OPERATION_SUCCESS_30D: Object.freeze({
    sli: 'successful CRITICAL_OPERATION_COMPLETED / accepted critical-operation attempts',
    targetBasisPoints: 9_900,
    rollingWindowSeconds: 2_592_000,
    denominator: 'accepted attempts after authentication and syntactic validation',
    failure: 'server failure, deadline exhaustion or unknown terminal outcome',
    exclusions: Object.freeze(['client rejection before acceptance', 'authorized synthetic drill']),
  }),
  CRITICAL_OPERATION_LATENCY_30D: Object.freeze({
    sli: 'critical operations completed below the operation-specific duration threshold / completed critical operations',
    targetBasisPoints: 9_500,
    rollingWindowSeconds: 2_592_000,
    denominator: 'completed accepted operations with a valid duration bucket',
    failure: 'GTE_5_S, invalid duration or missing sample',
    exclusions: Object.freeze(['client rejection before acceptance', 'authorized synthetic drill']),
  }),
  FAIL_CLOSED_GATE_RELIABILITY_30D: Object.freeze({
    sli: 'correct fail-closed decisions / all gate evaluations',
    targetBasisPoints: 10_000,
    rollingWindowSeconds: 2_592_000,
    denominator: 'every gate evaluation, including invalid or unavailable configuration',
    failure: 'allow on missing/invalid prerequisite, ambiguous result or missing sample',
    exclusions: Object.freeze([] as const),
  }),
  OPERATIONAL_TASK_FRESHNESS_30D: Object.freeze({
    sli: 'task observations within the documented freshness threshold / all scheduled task observations',
    targetBasisPoints: 9_900,
    rollingWindowSeconds: 2_592_000,
    denominator: 'every scheduled AI_RECONCILE or BACKUP_VERIFICATION observation',
    failure: 'threshold exceeded, invalid timestamp or missing expected observation',
    exclusions: Object.freeze(['task explicitly disabled by the dormant production contract']),
  }),
} as const);

export type OperationalSloCode = keyof typeof OPERATIONAL_SLO_CATALOG;

export const OPERATIONAL_SOURCE_INVENTORY = Object.freeze([
  Object.freeze({
    source: 'src/app/api/health/route.ts',
    data: Object.freeze(['status', 'database.reachable', 'timestamp']),
    classifications: Object.freeze(['INTERNAL'] as const satisfies readonly DataClassification[]),
    treatment: 'allowlisted health event; no configuration or connection details',
    retention: 'HTTP response only; N06 adds no persistence',
  }),
  Object.freeze({
    source: 'src/lib/system-readiness.ts',
    data: Object.freeze(['configuration presence', 'readiness status']),
    classifications: Object.freeze(['INTERNAL'] as const satisfies readonly DataClassification[]),
    treatment: 'presence/status only; secret values prohibited',
    retention: 'authenticated UI response only',
  }),
  Object.freeze({
    source: 'src/middleware.ts and session helpers',
    data: Object.freeze(['authentication outcome']),
    classifications: Object.freeze(['INTERNAL', 'AUTHENTICATION_SECRET'] as const satisfies readonly DataClassification[]),
    treatment: 'outcome code only; cookies and tokens never admitted',
    retention: 'not emitted by N06',
  }),
  Object.freeze({
    source: 'src/app/api/integrations/website/leads/route.ts',
    data: Object.freeze(['operation outcome', 'duration bucket']),
    classifications: Object.freeze(['INTERNAL', 'PERSONAL', 'FINANCIAL'] as const satisfies readonly DataClassification[]),
    treatment: 'operational codes only; body, headers, URL and identifiers prohibited',
    retention: 'not emitted by N06',
  }),
  Object.freeze({
    source: 'AuditLog and N04 redaction trigger',
    data: Object.freeze(['business audit metadata']),
    classifications: Object.freeze(['INTERNAL', 'CONFIDENTIAL', 'PERSONAL'] as const satisfies readonly DataClassification[]),
    treatment: 'existing N04 application and database redaction; not a telemetry transport',
    retention: 'existing database governance unchanged',
  }),
  Object.freeze({
    source: 'AI dormant worker JSONL heartbeat',
    data: Object.freeze(['build hash', 'state', 'sequence', 'timestamp', 'worker instance UUID']),
    classifications: Object.freeze(['INTERNAL'] as const satisfies readonly DataClassification[]),
    treatment: 'existing bounded heartbeat; instance UUID prohibited as a metric label',
    retention: 'existing process stdout policy unchanged',
  }),
  Object.freeze({
    source: 'N05 backup, restore and release scripts',
    data: Object.freeze(['phase codes', 'counts', 'image identity', 'result']),
    classifications: Object.freeze(['INTERNAL'] as const satisfies readonly DataClassification[]),
    treatment: 'operator codes and immutable identities only; secret/content output prohibited',
    retention: 'existing operator log policy unchanged',
  }),
  Object.freeze({
    source: 'Prisma, PostgreSQL and application errors',
    data: Object.freeze(['safe error class', 'retryability']),
    classifications: Object.freeze(['INTERNAL', 'AUTHENTICATION_SECRET', 'PERSONAL'] as const satisfies readonly DataClassification[]),
    treatment: 'allowlisted code mapping; message, stack, query, cause and path prohibited',
    retention: 'public safe descriptor or ephemeral event only',
  }),
] as const);

export function getOperationalTelemetryInvariantErrorsV1() {
  const errors: string[] = [];
  if (OPERATIONAL_TELEMETRY_MANIFEST.transport !== 'NONE'
    || OPERATIONAL_TELEMETRY_MANIFEST.persistence !== 'NONE'
    || OPERATIONAL_TELEMETRY_MANIFEST.exporterEnabled
    || OPERATIONAL_TELEMETRY_MANIFEST.networkEgressAllowed
    || OPERATIONAL_TELEMETRY_MANIFEST.externalEndpointAllowed) {
    errors.push('Telemetry transport boundary is not closed.');
  }
  for (const [code, definition] of Object.entries(OPERATIONAL_EVENT_CATALOG)) {
    if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(code)) errors.push('Event code is not canonical.');
    if (!SEVERITIES.includes(definition.severity)) errors.push('Event severity is not allowlisted.');
    if (definition.outcomes.some((outcome) => !OUTCOMES.includes(outcome))) {
      errors.push('Event outcome is not allowlisted.');
    }
    if (Object.keys(definition.metadata).length > OPERATIONAL_TELEMETRY_LIMITS.maxMetadataFields) {
      errors.push('Event metadata cardinality exceeds the contract.');
    }
  }
  for (const [code, definition] of Object.entries(OPERATIONAL_METRIC_CATALOG)) {
    if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(code)) errors.push('Metric code is not canonical.');
    if (Object.keys(definition.labels).length > OPERATIONAL_TELEMETRY_LIMITS.maxMetricLabels) {
      errors.push('Metric label cardinality exceeds the contract.');
    }
  }
  for (const definition of Object.values(OPERATIONAL_SLO_CATALOG)) {
    if (!Number.isInteger(definition.targetBasisPoints)
      || definition.targetBasisPoints < 1
      || definition.targetBasisPoints > 10_000
      || !Number.isSafeInteger(definition.rollingWindowSeconds)
      || definition.rollingWindowSeconds <= 0
      || !definition.denominator
      || !definition.failure) {
      errors.push('SLO definition is incomplete.');
    }
  }
  return errors;
}
