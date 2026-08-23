import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  OPERATIONAL_EVENT_CATALOG,
  OPERATIONAL_METRIC_CATALOG,
  OPERATIONAL_REDACTION_MARKER,
  OPERATIONAL_SLO_CATALOG,
  OPERATIONAL_SOURCE_INVENTORY,
  OPERATIONAL_TELEMETRY_MANIFEST,
  OperationalTelemetryContractError,
  classifyOperationalErrorV1,
  createOperationalCorrelationId,
  createOperationalEventV1,
  createOperationalMetricObservationV1,
  getOperationalTelemetryInvariantErrorsV1,
  isOperationalCorrelationId,
  operationalDurationBucket,
  operationalFreshnessBucket,
  redactOperationalPayload,
  redactOperationalText,
  type OperationalCorrelationId,
  type OperationalTelemetryErrorCode,
} from '../src/lib/operational-telemetry';

const correlationId = '018f47a2-4d12-4abc-8def-0123456789ab' as OperationalCorrelationId;

function expectContractError(code: OperationalTelemetryErrorCode, operation: () => unknown) {
  assert.throws(operation, (error: unknown) => (
    error instanceof OperationalTelemetryContractError
      && error.code === code
      && error.message === code
      && error.cause === undefined
      && !/secret|email|token|cookie|password/i.test(error.message)
  ));
}

test('N06 manifest is local-only, side-effect-free and permanently closed to exporters', () => {
  assert.deepEqual(OPERATIONAL_TELEMETRY_MANIFEST, {
    schemaVersion: 'n06-v1',
    catalogVersion: 'n06-v1',
    transport: 'NONE',
    persistence: 'NONE',
    exporterEnabled: false,
    networkEgressAllowed: false,
    externalEndpointAllowed: false,
    freeTextAllowed: false,
    rawPayloadAllowed: false,
    rawErrorAllowed: false,
    dataMode: 'MINIMIZED_OPERATIONAL_OR_SYNTHETIC',
  });
  const source = readFileSync('src/lib/operational-telemetry.ts', 'utf8');
  assert.doesNotMatch(source, /\bfetch\s*\(|https?:\/\/|process\.env|console\.|sendBeacon|WebSocket/);
  assert.doesNotMatch(source, /opentelemetry|prom-client|sentry|datadog|newrelic/i);
});

test('N06 module import performs no I/O and exits without handles or environment reads', () => {
  const moduleUrl = pathToFileURL(path.resolve('src/lib/operational-telemetry.ts')).href;
  const imported = spawnSync(process.execPath, [
    '--import', 'tsx', '--input-type=module', '--eval', `await import(${JSON.stringify(moduleUrl)})`,
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      ...process.env,
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://must-not-connect.invalid',
      SENTRY_DSN: 'https://must-not-connect.invalid',
    },
  });
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout, '');
  assert.equal(imported.stderr, '');
});

test('N06 correlation IDs are generated internally, canonical UUID v4 and bounded', () => {
  assert.equal(isOperationalCorrelationId(correlationId), true);
  assert.equal(isOperationalCorrelationId(correlationId.toUpperCase()), false);
  for (const invalid of [undefined, '', 'customer-42', '018f47a2-4d12-3abc-8def-0123456789ab', `${correlationId}x`]) {
    assert.equal(isOperationalCorrelationId(invalid), false);
  }
  assert.equal(createOperationalCorrelationId(() => correlationId), correlationId);
  expectContractError('TELEMETRY_CORRELATION_ID_INVALID', () => (
    createOperationalCorrelationId(() => 'privacy.person@n06.invalid')
  ));
});

test('N06 event envelope is canonical, bounded and admits only catalog values', () => {
  const event = createOperationalEventV1({
    eventCode: 'CRITICAL_OPERATION_COMPLETED',
    outcome: 'SUCCESS',
    correlationId,
    nowMs: 1_700_000_000_000,
    metadata: { operationCode: 'WEBSITE_LEAD_INTAKE', durationBucket: 'LT_500_MS' },
  });
  assert.deepEqual(Object.keys(event), [
    'schemaVersion', 'timestamp', 'severity', 'eventCode', 'componentCode',
    'outcome', 'correlationId', 'metadata',
  ]);
  assert.deepEqual(event, {
    schemaVersion: 'n06-v1',
    timestamp: '2023-11-14T22:13:20.000Z',
    severity: 'INFO',
    eventCode: 'CRITICAL_OPERATION_COMPLETED',
    componentCode: 'APPLICATION',
    outcome: 'SUCCESS',
    correlationId,
    metadata: { operationCode: 'WEBSITE_LEAD_INTAKE', durationBucket: 'LT_500_MS' },
  });
  assert.equal(Object.isFrozen(event), true);
  assert.equal(Object.isFrozen(event.metadata), true);
  assert.ok(Buffer.byteLength(JSON.stringify(event), 'utf8') < 2_048);
  assert.deepEqual(redactOperationalPayload(event), event);
});

test('N06 event contract fails closed on unknown event, outcome, keys and values', () => {
  expectContractError('TELEMETRY_EVENT_UNKNOWN', () => createOperationalEventV1({
    eventCode: 'CUSTOMER_018F47A2' as never,
    outcome: 'SUCCESS',
    correlationId,
    metadata: {},
  }));
  expectContractError('TELEMETRY_OUTCOME_INVALID', () => createOperationalEventV1({
    eventCode: 'APP_HEALTH_CHECK_COMPLETED',
    outcome: 'REJECTED',
    correlationId,
    metadata: { databaseState: 'REACHABLE' },
  }));
  for (const metadata of [
    { databaseState: 'REACHABLE', email: 'privacy.person@n06.invalid' },
    { databaseState: 'REACHABLE', Authorization: 'Bearer synthetic-secret-value' },
    { databaseState: 'REACHABLE', 'ｃｏｏｋｉｅ': 'session=synthetic-secret-value' },
    { databaseState: 'REACHABLE', 'co\u200dookie': 'session=synthetic-secret-value' },
  ]) {
    expectContractError('TELEMETRY_METADATA_INVALID', () => createOperationalEventV1({
      eventCode: 'APP_HEALTH_CHECK_COMPLETED', outcome: 'SUCCESS', correlationId, metadata,
    }));
  }
  expectContractError('TELEMETRY_METADATA_VALUE_INVALID', () => createOperationalEventV1({
    eventCode: 'APP_HEALTH_CHECK_COMPLETED',
    outcome: 'SUCCESS',
    correlationId,
    metadata: { databaseState: 'privacy.person@n06.invalid' },
  }));
  expectContractError('TELEMETRY_METADATA_INVALID', () => createOperationalEventV1({
    eventCode: 'APP_HEALTH_CHECK_COMPLETED', outcome: 'SUCCESS', correlationId, metadata: {},
  }));
});

test('N06 timestamps and duration/freshness buckets reject malformed or unbounded values', () => {
  for (const nowMs of [-1, Number.NaN, Number.POSITIVE_INFINITY, 8_640_000_000_000_001]) {
    expectContractError('TELEMETRY_TIMESTAMP_INVALID', () => createOperationalEventV1({
      eventCode: 'APP_HEALTH_CHECK_COMPLETED',
      outcome: 'SUCCESS',
      correlationId,
      nowMs,
      metadata: { databaseState: 'REACHABLE' },
    }));
  }
  assert.deepEqual(
    [0, 99, 100, 499, 500, 999, 1_000, 4_999, 5_000].map(operationalDurationBucket),
    ['LT_100_MS', 'LT_100_MS', 'LT_500_MS', 'LT_500_MS', 'LT_1_S', 'LT_1_S', 'LT_5_S', 'LT_5_S', 'GTE_5_S'],
  );
  assert.deepEqual(
    [0, 59, 60, 299, 300, 899, 900, 3_599, 3_600].map(operationalFreshnessBucket),
    ['LT_60_S', 'LT_60_S', 'LT_5_M', 'LT_5_M', 'LT_15_M', 'LT_15_M', 'LT_1_H', 'LT_1_H', 'GTE_1_H'],
  );
  for (const invalid of [-1, 1.5, Number.NaN, 86_400_001]) {
    expectContractError('TELEMETRY_METRIC_VALUE_INVALID', () => operationalDurationBucket(invalid));
  }
  for (const invalid of [-1, 1.5, Number.NaN, 604_801]) {
    expectContractError('TELEMETRY_METRIC_VALUE_INVALID', () => operationalFreshnessBucket(invalid));
  }
});

test('N06 metric catalog has finite label domains and rejects high-cardinality input', () => {
  for (const definition of Object.values(OPERATIONAL_METRIC_CATALOG)) {
    assert.ok(Object.keys(definition.labels).length <= 3);
    for (const values of Object.values(definition.labels)) {
      assert.ok(values.length > 0 && values.length <= 8);
      assert.equal(new Set(values).size, values.length);
    }
  }
  assert.deepEqual(createOperationalMetricObservationV1({
    metricCode: 'CRITICAL_OPERATION_OUTCOME',
    labels: { operationCode: 'WEBSITE_LEAD_INTAKE', outcome: 'SUCCESS' },
    value: 1,
  }), {
    schemaVersion: 'n06-v1',
    metricCode: 'CRITICAL_OPERATION_OUTCOME',
    kind: 'COUNTER',
    labels: { operationCode: 'WEBSITE_LEAD_INTAKE', outcome: 'SUCCESS' },
    value: 1,
  });
  const canonicalMetric = createOperationalMetricObservationV1({
    metricCode: 'CRITICAL_OPERATION_OUTCOME',
    labels: { operationCode: 'WEBSITE_LEAD_INTAKE', outcome: 'SUCCESS' },
    value: 1,
  });
  assert.deepEqual(redactOperationalPayload(canonicalMetric), canonicalMetric);
  for (const labels of [
    { operationCode: 'WEBSITE_LEAD_INTAKE', outcome: 'SUCCESS', clientId: correlationId },
    { operationCode: `CUSTOMER_${'A'.repeat(200)}`, outcome: 'SUCCESS' },
    { operationCode: 'WEBSITE_LEAD_INTAKE', outcome: 'privacy.person@n06.invalid' },
  ]) {
    const code = Object.keys(labels).length === 3
      ? 'TELEMETRY_LABELS_INVALID'
      : 'TELEMETRY_LABEL_VALUE_INVALID';
    expectContractError(code, () => createOperationalMetricObservationV1({
      metricCode: 'CRITICAL_OPERATION_OUTCOME', labels, value: 1,
    }));
  }
  expectContractError('TELEMETRY_METRIC_VALUE_INVALID', () => createOperationalMetricObservationV1({
    metricCode: 'CRITICAL_OPERATION_OUTCOME',
    labels: { operationCode: 'WEBSITE_LEAD_INTAKE', outcome: 'SUCCESS' },
    value: 2,
  }));
});

test('N06 centralized redaction is deterministic, idempotent and default-deny', () => {
  const sensitive = {
    schemaVersion: 'n06-v1',
    timestamp: '2026-08-18T10:20:30.000Z',
    severity: 'ERROR',
    eventCode: 'INTERNAL_ERROR_MAPPED',
    componentCode: 'APPLICATION',
    outcome: 'FAILURE',
    correlationId,
    retryable: false,
    metadata: {
      errorClass: 'INTERNAL_FAILURE',
      retryability: 'NON_RETRYABLE',
      email: 'privacy.person@n06.invalid',
      phone: '+39 333 123 4567',
      password: 'synthetic-password',
      token: 'synthetic-token',
      Authorization: 'Bearer abcdefghijklmnopqrstuvwxyz012345',
      cookie: 'fai_crm_session=synthetic-session',
      databaseUrl: 'postgresql://user:password@database.example/fai',
      url: 'https://example.invalid/path?token=synthetic-token',
      prompt: 'private prompt body',
      output: 'private AI output',
      stack: '/srv/app/private.ts:42',
      sql: 'SELECT secret FROM customer',
      entropy: 'vN8$2zQm7!Lp4#Kx9@Rf6%Tc3&Hy5*Wd1',
      errorCode: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEF',
      'ｓｅｃｒｅｔ': 'fullwidth-bypass',
      'to\u200dken': 'format-bypass',
      nested: { email: 'nested@n06.invalid' },
      array: ['nested@n06.invalid', 'synthetic-token'],
    },
  };
  const sanitized = redactOperationalPayload(sensitive);
  const serialized = JSON.stringify(sanitized);
  assert.deepEqual(sanitized, {
    schemaVersion: 'n06-v1',
    timestamp: '2026-08-18T10:20:30.000Z',
    severity: 'ERROR',
    eventCode: 'INTERNAL_ERROR_MAPPED',
    componentCode: 'APPLICATION',
    outcome: 'FAILURE',
    correlationId,
    retryable: false,
    metadata: { errorClass: 'INTERNAL_FAILURE', retryability: 'NON_RETRYABLE' },
  });
  for (const prohibited of [
    'privacy.person', '+39', 'synthetic-password', 'synthetic-token', 'authorization',
    'postgresql', 'example.invalid', 'private prompt', 'private ai', '/srv/app', 'select secret',
    'vN8$2zQm7', 'fullwidth-bypass', 'format-bypass', 'nested@n06',
  ]) assert.equal(serialized.toLowerCase().includes(prohibited.toLowerCase()), false, prohibited);
  assert.deepEqual(redactOperationalPayload(sanitized), sanitized);
  assert.equal(redactOperationalText('privacy.person@n06.invalid'), OPERATIONAL_REDACTION_MARKER);
  assert.equal(redactOperationalText(OPERATIONAL_REDACTION_MARKER), OPERATIONAL_REDACTION_MARKER);
});

test('N06 redaction contains circular, accessor, oversized and control-character structures', () => {
  let getterCalled = false;
  const circular: Record<string, unknown> = {
    schemaVersion: 'n06-v1',
    severity: 'INFO',
    message: `line one\nline two\u0000privacy.person@n06.invalid`,
  };
  circular.metadata = circular;
  Object.defineProperty(circular, 'token', {
    enumerable: true,
    get() { getterCalled = true; return 'synthetic-secret'; },
  });
  for (let index = 0; index < 100; index += 1) circular[`unknown_${index}`] = 'x'.repeat(10_000);
  const sanitized = redactOperationalPayload(circular);
  assert.equal(getterCalled, false);
  assert.deepEqual(sanitized, { schemaVersion: 'n06-v1', severity: 'INFO', metadata: {} });
  assert.ok(Buffer.byteLength(JSON.stringify(sanitized), 'utf8') < 2_048);
});

test('N06 error mapping never exposes message, cause, stack, path, SQL or Prisma details', () => {
  const sensitive = Object.assign(new Error('privacy.person@n06.invalid token=synthetic-token'), {
    code: 'P1001',
    cause: new Error('postgresql://user:password@database.example/fai'),
    query: 'SELECT secret FROM customer',
    path: '/srv/app/private.ts',
  });
  const mapped = classifyOperationalErrorV1(sensitive);
  assert.deepEqual(mapped, {
    schemaVersion: 'n06-v1',
    errorClass: 'DEPENDENCY_UNAVAILABLE',
    publicCode: 'TEMPORARILY_UNAVAILABLE',
    retryability: 'RETRYABLE',
  });
  for (const [error, errorClass] of [
    [{ code: 'P2034' }, 'CONCURRENCY_RETRYABLE'],
    [{ meta: { code: '40001' } }, 'CONCURRENCY_RETRYABLE'],
    [{ meta: { code: '40P01' } }, 'CONCURRENCY_RETRYABLE'],
    [new OperationalTelemetryContractError('TELEMETRY_METADATA_UNKNOWN'), 'CONTRACT_REJECTED'],
    [{ code: 'P2002', message: 'privacy.person@n06.invalid' }, 'INTERNAL_FAILURE'],
  ] as const) assert.equal(classifyOperationalErrorV1(error).errorClass, errorClass);
  const serialized = JSON.stringify(mapped);
  assert.doesNotMatch(serialized, /privacy|synthetic|postgresql|select|srv|P1001/i);
});

test('N06 error mapping does not invoke attacker-controlled accessors', () => {
  let getterCalled = false;
  const error = {};
  Object.defineProperty(error, 'code', {
    enumerable: true,
    get() { getterCalled = true; return 'P1001'; },
  });
  assert.equal(classifyOperationalErrorV1(error).errorClass, 'INTERNAL_FAILURE');
  assert.equal(getterCalled, false);
});

test('N06 source inventory binds every audited surface to classification, treatment and retention', () => {
  assert.equal(OPERATIONAL_SOURCE_INVENTORY.length, 8);
  const sources = OPERATIONAL_SOURCE_INVENTORY.map((entry) => entry.source).join('\n');
  for (const expected of [
    'api/health', 'system-readiness', 'middleware', 'website/leads', 'AuditLog',
    'dormant worker', 'backup, restore and release', 'Prisma, PostgreSQL',
  ]) assert.match(sources, new RegExp(expected, 'i'));
  for (const entry of OPERATIONAL_SOURCE_INVENTORY) {
    assert.ok(entry.data.length > 0);
    assert.ok(entry.classifications.length > 0);
    assert.ok(entry.treatment.length > 0);
    assert.ok(entry.retention.length > 0);
  }
});

test('N06 SLOs have explicit targets, windows, denominators, failures and exclusions', () => {
  assert.deepEqual(Object.keys(OPERATIONAL_SLO_CATALOG), [
    'APP_HEALTH_AVAILABILITY_30D',
    'DATABASE_REACHABILITY_30D',
    'CRITICAL_OPERATION_SUCCESS_30D',
    'CRITICAL_OPERATION_LATENCY_30D',
    'FAIL_CLOSED_GATE_RELIABILITY_30D',
    'OPERATIONAL_TASK_FRESHNESS_30D',
  ]);
  for (const definition of Object.values(OPERATIONAL_SLO_CATALOG)) {
    assert.ok(definition.targetBasisPoints > 0 && definition.targetBasisPoints <= 10_000);
    assert.equal(definition.rollingWindowSeconds, 30 * 24 * 60 * 60);
    assert.ok(definition.sli.length > 0);
    assert.ok(definition.denominator.length > 0);
    assert.ok(definition.failure.length > 0);
    assert.ok(Array.isArray(definition.exclusions));
  }
  assert.equal(OPERATIONAL_SLO_CATALOG.FAIL_CLOSED_GATE_RELIABILITY_30D.targetBasisPoints, 10_000);
});

test('N06 catalogs and invariants are complete and internally consistent', () => {
  assert.equal(Object.keys(OPERATIONAL_EVENT_CATALOG).length, 7);
  assert.equal(Object.keys(OPERATIONAL_METRIC_CATALOG).length, 6);
  assert.deepEqual(getOperationalTelemetryInvariantErrorsV1(), []);
});

test('N06 adds no migration, vendor dependency, exporter or production activation', () => {
  assert.equal(readdirSync('prisma/migrations').filter((name) => /^\d/.test(name)).length, 42);
  const packageJson = readFileSync('package.json', 'utf8');
  for (const prohibited of [
    '@opentelemetry', 'prom-client', '@sentry', 'datadog', 'newrelic', 'splunk', 'elastic-apm',
  ]) {
    assert.equal(packageJson.toLowerCase().includes(prohibited), false, prohibited);
  }
  const source = readFileSync('src/lib/operational-telemetry.ts', 'utf8');
  assert.doesNotMatch(source, /exporterEnabled:\s*true|networkEgressAllowed:\s*true|transport:\s*['"](?:HTTP|OTLP|PROMETHEUS)/);
});
