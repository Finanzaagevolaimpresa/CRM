import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { POST } from '../src/app/api/integrations/website/leads/v2/route';
import { canonicalJson } from '../src/lib/canonical-json';
import { classifyDataField } from '../src/lib/data-classification';
import {
  deriveSecureLeadGatewayTransactionBudget,
  readSecureLeadGatewayKeyring,
  SECURE_LEAD_GATEWAY_RUNTIME,
  SecureLeadGatewayError,
} from '../src/lib/secure-lead-gateway';
import {
  assertSecureLeadGatewayTimestamp,
  createSecureLeadGatewaySignature,
  createSecureLeadGatewaySignedBytes,
  digestSecureLeadGatewayKey,
  digestSecureLeadGatewayNonce,
  fingerprintSecureLeadGatewayRequest,
  parseCanonicalSecureLeadGatewayEnvelope,
  readSecureLeadGatewayHeaders,
  readSecureLeadGatewayRawBody,
  SECURE_LEAD_GATEWAY_PROTOCOL,
  secureLeadGatewayMode,
  SecureLeadGatewayDeadline,
  SecureLeadGatewayDeadlineError,
  SecureLeadGatewayProtocolError,
  verifySecureLeadGatewaySignature,
} from '../src/lib/secure-lead-gateway-protocol';
import { SYNTHETIC_LEAD_EVENT_V1 } from './fixtures/n10-lead-event-v1';
import {
  N12_SYNTHETIC_BODY,
  N12_SYNTHETIC_KEY_ID,
  N12_SYNTHETIC_NONCE,
  N12_SYNTHETIC_PRODUCER_CODE,
  N12_SYNTHETIC_SECRET,
  N12_SYNTHETIC_TIMESTAMP,
  syntheticSecureLeadGatewayRequest,
} from './fixtures/n12-secure-lead-gateway-v2';

function expectProtocolError(
  code: 'INVALID_REQUEST' | 'UNAUTHORIZED' | 'TEMPORARILY_UNAVAILABLE',
  status: 400 | 401 | 413 | 503,
  operation: () => unknown,
) {
  assert.throws(operation, (error: unknown) => (
    error instanceof SecureLeadGatewayProtocolError
    && error.code === code
    && error.status === status
    && error.message === code
  ));
}

test('N12 protocol is a bounded, versioned and dormant-by-configuration ingress boundary', () => {
  assert.equal(SECURE_LEAD_GATEWAY_PROTOCOL.path, '/api/integrations/website/leads/v2');
  assert.equal(SECURE_LEAD_GATEWAY_PROTOCOL.method, 'POST');
  assert.equal(
    SECURE_LEAD_GATEWAY_PROTOCOL.contentType,
    'application/vnd.fai.lead-event.v1+json',
  );
  assert.equal(SECURE_LEAD_GATEWAY_PROTOCOL.maximumBodyBytes, 16 * 1024);
  assert.equal(SECURE_LEAD_GATEWAY_PROTOCOL.timeoutMs, 5_000);
  assert.equal(SECURE_LEAD_GATEWAY_PROTOCOL.maximumClockSkewSeconds, 300);
  assert.equal(SECURE_LEAD_GATEWAY_PROTOCOL.replayRetentionSeconds, 86_400);
  assert.equal(Object.isFrozen(SECURE_LEAD_GATEWAY_PROTOCOL), true);
  for (const value of [undefined, '', 'ENFORCED', 'invalid', 'legacy']) {
    assert.equal(secureLeadGatewayMode(value), 'disabled');
  }
  assert.equal(secureLeadGatewayMode('disabled'), 'disabled');
  assert.equal(secureLeadGatewayMode('shadow'), 'shadow');
  assert.equal(secureLeadGatewayMode('enforced'), 'enforced');
});

test('N12 accepts only the approved path, media type, absent encoding and bounded headers', () => {
  const headers = readSecureLeadGatewayHeaders(syntheticSecureLeadGatewayRequest());
  assert.equal(headers.keyId, N12_SYNTHETIC_KEY_ID);
  assert.equal(headers.timestamp, N12_SYNTHETIC_TIMESTAMP);
  assert.equal(headers.nonce, N12_SYNTHETIC_NONCE);
  assert.equal(headers.contentLength, N12_SYNTHETIC_BODY.byteLength);
  assert.equal(headers.authenticationHeadersValid, true);

  for (const request of [
    syntheticSecureLeadGatewayRequest({ path: `${SECURE_LEAD_GATEWAY_PROTOCOL.path}?x=1` }),
    syntheticSecureLeadGatewayRequest({ path: '/api/integrations/website/leads' }),
    syntheticSecureLeadGatewayRequest({ contentType: 'application/json' }),
    syntheticSecureLeadGatewayRequest({
      contentType: `${SECURE_LEAD_GATEWAY_PROTOCOL.contentType}; charset=utf-8`,
    }),
    syntheticSecureLeadGatewayRequest({ contentEncoding: 'gzip' }),
  ]) expectProtocolError('INVALID_REQUEST', 400, () => readSecureLeadGatewayHeaders(request));
});

test('N12 rejects missing, malformed, duplicate-like and noncanonical required headers', () => {
  for (const [name, value] of [
    ['x-fai-key-id', 'ab'],
    ['x-fai-key-id', 'synthetic key'],
    ['x-fai-timestamp', '17873136000'],
    ['x-fai-nonce', 'ABCDEF0123456789ABCDEF0123456789'],
    ['x-fai-nonce', '0'.repeat(31)],
    ['x-fai-signature', `V1=${'0'.repeat(64)}`],
    ['x-fai-signature', `v1=${'0'.repeat(63)}`],
  ] as const) {
    const request = syntheticSecureLeadGatewayRequest();
    request.headers.set(name, value);
    assert.equal(readSecureLeadGatewayHeaders(request).authenticationHeadersValid, false);
  }
  const oversizedKey = syntheticSecureLeadGatewayRequest();
  oversizedKey.headers.set('x-fai-key-id', `a${'b'.repeat(80)}`);
  expectProtocolError(
    'UNAUTHORIZED',
    401,
    () => readSecureLeadGatewayHeaders(oversizedKey),
  );
  for (const contentLength of ['01', '1, 1']) {
    const request = syntheticSecureLeadGatewayRequest();
    request.headers.set('content-length', contentLength);
    expectProtocolError(
      'INVALID_REQUEST',
      400,
      () => readSecureLeadGatewayHeaders(request),
    );
  }
  const missing = syntheticSecureLeadGatewayRequest();
  missing.headers.delete('x-fai-key-id');
  assert.equal(readSecureLeadGatewayHeaders(missing).authenticationHeadersValid, false);
  const comma = syntheticSecureLeadGatewayRequest();
  comma.headers.set('x-fai-nonce', `${N12_SYNTHETIC_NONCE},${N12_SYNTHETIC_NONCE}`);
  expectProtocolError(
    'UNAUTHORIZED',
    401,
    () => readSecureLeadGatewayHeaders(comma),
  );
  const over = syntheticSecureLeadGatewayRequest({ contentLength: '16385' });
  expectProtocolError('INVALID_REQUEST', 413, () => readSecureLeadGatewayHeaders(over));
});

test('N12 raw-body reader is byte exact, length aware, bounded and abortable', async () => {
  const exactBody = Buffer.alloc(SECURE_LEAD_GATEWAY_PROTOCOL.maximumBodyBytes, 0x61);
  const exact = new Request('http://local', {
    method: 'POST',
    body: exactBody,
    duplex: 'half',
  } as RequestInit);
  assert.deepEqual(
    await readSecureLeadGatewayRawBody(
      exact,
      new AbortController().signal,
      exactBody.byteLength,
    ),
    exactBody,
  );
  const overBody = Buffer.alloc(SECURE_LEAD_GATEWAY_PROTOCOL.maximumBodyBytes + 1, 0x61);
  const over = new Request('http://local', {
    method: 'POST',
    body: overBody,
    duplex: 'half',
  } as RequestInit);
  await assert.rejects(
    () => readSecureLeadGatewayRawBody(over, new AbortController().signal, null),
    (error: unknown) => error instanceof SecureLeadGatewayProtocolError && error.status === 413,
  );
  const mismatch = new Request('http://local', {
    method: 'POST',
    body: 'abc',
    duplex: 'half',
  } as RequestInit);
  await assert.rejects(
    () => readSecureLeadGatewayRawBody(mismatch, new AbortController().signal, 2),
    (error: unknown) => error instanceof SecureLeadGatewayProtocolError && error.status === 400,
  );

  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const slow = new Request('http://local', {
    method: 'POST', body: stream, duplex: 'half',
  } as RequestInit);
  const controller = new AbortController();
  const pending = readSecureLeadGatewayRawBody(slow, controller.signal, null);
  controller.abort();
  await assert.rejects(pending, SecureLeadGatewayDeadlineError);
  assert.equal(cancelled, true);
});

test('N12 parses exactly the canonical N10 bytes and forbids reinterpretation', () => {
  assert.deepEqual(
    parseCanonicalSecureLeadGatewayEnvelope(N12_SYNTHETIC_BODY),
    SYNTHETIC_LEAD_EVENT_V1,
  );
  const noncanonical = Buffer.from(JSON.stringify(SYNTHETIC_LEAD_EVENT_V1), 'utf8');
  assert.notEqual(noncanonical.toString('utf8'), N12_SYNTHETIC_BODY.toString('utf8'));
  expectProtocolError(
    'INVALID_REQUEST',
    400,
    () => parseCanonicalSecureLeadGatewayEnvelope(noncanonical),
  );
  const duplicate = Buffer.from(
    N12_SYNTHETIC_BODY.toString('utf8').replace(
      '"eventType":',
      '"eventType":"LEAD_SUBMITTED","eventType":',
    ),
    'utf8',
  );
  expectProtocolError(
    'INVALID_REQUEST',
    400,
    () => parseCanonicalSecureLeadGatewayEnvelope(duplicate),
  );
  expectProtocolError(
    'INVALID_REQUEST',
    400,
    () => parseCanonicalSecureLeadGatewayEnvelope(new Uint8Array([0xc3, 0x28])),
  );
  const normalized = {
    ...SYNTHETIC_LEAD_EVENT_V1,
    payload: {
      ...SYNTHETIC_LEAD_EVENT_V1.payload,
      email: SYNTHETIC_LEAD_EVENT_V1.payload.email?.toUpperCase(),
    },
  };
  expectProtocolError(
    'INVALID_REQUEST',
    400,
    () => parseCanonicalSecureLeadGatewayEnvelope(Buffer.from(canonicalJson(normalized))),
  );
});

test('N12 signs the exact approved bytes with a stable HMAC-SHA-256 vector', () => {
  const signedBytes = createSecureLeadGatewaySignedBytes({
    keyId: N12_SYNTHETIC_KEY_ID,
    timestamp: N12_SYNTHETIC_TIMESTAMP,
    nonce: N12_SYNTHETIC_NONCE,
  }, N12_SYNTHETIC_BODY);
  const expectedPrefix = [
    'fai.secure-lead-gateway.request.v1',
    'POST',
    '/api/integrations/website/leads/v2',
    'application/vnd.fai.lead-event.v1+json',
    N12_SYNTHETIC_KEY_ID,
    N12_SYNTHETIC_TIMESTAMP,
    N12_SYNTHETIC_NONCE,
    String(N12_SYNTHETIC_BODY.byteLength),
    '',
  ].join('\n');
  assert.deepEqual(
    signedBytes,
    Buffer.concat([Buffer.from(expectedPrefix, 'ascii'), N12_SYNTHETIC_BODY]),
  );
  const signature = createSecureLeadGatewaySignature(N12_SYNTHETIC_SECRET, signedBytes);
  assert.equal(
    signature,
    'v1=ff851e17d5a11823e0a481fc4c8bf0b78be4ff70eebdb8ce1389c53f17e1791f',
  );
  assert.equal(
    verifySecureLeadGatewaySignature(N12_SYNTHETIC_SECRET, signedBytes, signature),
    true,
  );
  assert.equal(
    verifySecureLeadGatewaySignature(
      N12_SYNTHETIC_SECRET,
      Buffer.concat([signedBytes, Buffer.from('x')]),
      signature,
    ),
    false,
  );
  assert.equal(
    verifySecureLeadGatewaySignature(N12_SYNTHETIC_SECRET, signedBytes, `V1=${'0'.repeat(64)}`),
    false,
  );
  expectProtocolError(
    'UNAUTHORIZED',
    401,
    () => createSecureLeadGatewaySignature(Buffer.alloc(31), signedBytes),
  );
  assert.match(
    readFileSync('src/lib/secure-lead-gateway-protocol.ts', 'utf8'),
    /timingSafeEqual\(expected, supplied\)/,
  );
});

test('N12 separates key, nonce and replay digest domains', () => {
  const signedBytes = createSecureLeadGatewaySignedBytes({
    keyId: N12_SYNTHETIC_KEY_ID,
    timestamp: N12_SYNTHETIC_TIMESTAMP,
    nonce: N12_SYNTHETIC_NONCE,
  }, N12_SYNTHETIC_BODY);
  const digests = [
    digestSecureLeadGatewayKey(N12_SYNTHETIC_SECRET),
    digestSecureLeadGatewayNonce(N12_SYNTHETIC_PRODUCER_CODE, N12_SYNTHETIC_NONCE),
    fingerprintSecureLeadGatewayRequest(signedBytes),
  ];
  for (const digest of digests) assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(new Set(digests).size, digests.length);
  assert.equal(digests.some((digest) => digest.includes(N12_SYNTHETIC_NONCE)), false);
});

test('N12 timestamp window is inclusive at plus/minus 300 seconds and DB-clock based', () => {
  const databaseNow = new Date('2026-08-21T12:00:00.999Z');
  const center = Math.trunc(databaseNow.getTime() / 1_000);
  assert.doesNotThrow(() => assertSecureLeadGatewayTimestamp(center - 300, databaseNow));
  assert.doesNotThrow(() => assertSecureLeadGatewayTimestamp(center + 300, databaseNow));
  expectProtocolError(
    'UNAUTHORIZED',
    401,
    () => assertSecureLeadGatewayTimestamp(center - 301, databaseNow),
  );
  expectProtocolError(
    'UNAUTHORIZED',
    401,
    () => assertSecureLeadGatewayTimestamp(center + 301, databaseNow),
  );
});

test('N12 deadline shares one exact five-second budget', () => {
  let now = 10_000;
  const deadline = new SecureLeadGatewayDeadline(now, () => now);
  assert.equal(deadline.remainingMs(), 5_000);
  now = 14_999;
  assert.equal(deadline.remainingMs(), 1);
  now = 15_000;
  assert.equal(deadline.remainingMs(), 0);
  assert.throws(() => deadline.assertRemaining(), SecureLeadGatewayDeadlineError);
});

test('N12 transaction acquisition and execution reserve one shared remaining budget', () => {
  assert.deepEqual(deriveSecureLeadGatewayTransactionBudget(5_000), {
    maxWait: 2_000,
    timeout: 3_000,
  });
  assert.deepEqual(deriveSecureLeadGatewayTransactionBudget(3), {
    maxWait: 1,
    timeout: 2,
  });
  for (const remaining of [2, 3, 999, 5_000]) {
    const budget = deriveSecureLeadGatewayTransactionBudget(remaining);
    assert.equal(budget.maxWait + budget.timeout, remaining);
    assert.ok(budget.maxWait >= 1 && budget.timeout >= 1);
  }
  assert.throws(
    () => deriveSecureLeadGatewayTransactionBudget(1),
    (error: unknown) => error instanceof SecureLeadGatewayError
      && error.code === 'TEMPORARILY_UNAVAILABLE',
  );
});

test('N12 reads only a protected, bounded and exact synthetic keyring file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'n12-keyring-'));
  const path = join(root, 'synthetic-keyring.json');
  const secretBase64 = N12_SYNTHETIC_SECRET.toString('base64');
  const validKeyring = JSON.stringify({
    version: 1,
    keys: [{ keyId: N12_SYNTHETIC_KEY_ID, secretBase64 }],
  });
  try {
    writeFileSync(path, validKeyring, { mode: 0o600 });
    const keyring = await readSecureLeadGatewayKeyring(path, { allowedRoot: root });
    assert.equal(keyring.size, 1);
    assert.deepEqual(keyring.get(N12_SYNTHETIC_KEY_ID), N12_SYNTHETIC_SECRET);
    const copy = keyring.get(N12_SYNTHETIC_KEY_ID);
    copy?.fill(0);
    assert.deepEqual(keyring.get(N12_SYNTHETIC_KEY_ID), N12_SYNTHETIC_SECRET);

    for (const duplicate of [
      `{"version":1,"version":1,"keys":[{"keyId":"${N12_SYNTHETIC_KEY_ID}","secretBase64":"${secretBase64}"}]}`,
      `{"version":1,"keys":[{"keyId":"${N12_SYNTHETIC_KEY_ID}","key\\u0049d":"${N12_SYNTHETIC_KEY_ID}","secretBase64":"${secretBase64}"}]}`,
      `{"version":1,"keys":[{"keyId":"${N12_SYNTHETIC_KEY_ID}","secretBase64":"${secretBase64}","secretBase64":"${secretBase64}"}]}`,
    ]) {
      writeFileSync(path, duplicate, { mode: 0o600 });
      await assert.rejects(
        () => readSecureLeadGatewayKeyring(path, { allowedRoot: root }),
        (error: unknown) => error instanceof SecureLeadGatewayError
          && error.code === 'TEMPORARILY_UNAVAILABLE',
      );
    }

    writeFileSync(path, validKeyring, { mode: 0o600 });
    chmodSync(path, 0o644);
    await assert.rejects(
      () => readSecureLeadGatewayKeyring(path, { allowedRoot: root }),
      (error: unknown) => error instanceof SecureLeadGatewayError
        && error.code === 'TEMPORARILY_UNAVAILABLE',
    );
    chmodSync(path, 0o600);
    const link = join(root, 'synthetic-link.json');
    symlinkSync(path, link);
    await assert.rejects(
      () => readSecureLeadGatewayKeyring(link, { allowedRoot: root }),
      (error: unknown) => error instanceof SecureLeadGatewayError
        && error.code === 'TEMPORARILY_UNAVAILABLE',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('N12 disabled and gate-OFF modes return uniform 503 before reading body or keyring', async () => {
  const previous = {
    mode: process.env.SECURE_LEAD_GATEWAY_MODE,
    feature: process.env.FEATURE_INTEGRATIONS_ENABLED,
    keyring: process.env.SECURE_LEAD_GATEWAY_KEYRING_FILE,
  };
  const request = () => ({
    method: 'POST',
    url: `http://local${SECURE_LEAD_GATEWAY_PROTOCOL.path}`,
    headers: new Headers(),
    get body(): never {
      throw new Error('N12_DISABLED_BODY_MUST_NOT_BE_READ');
    },
  }) as never;
  try {
    process.env.SECURE_LEAD_GATEWAY_MODE = 'disabled';
    process.env.FEATURE_INTEGRATIONS_ENABLED = 'true';
    process.env.SECURE_LEAD_GATEWAY_KEYRING_FILE = '/run/secrets/missing';
    const disabled = await POST(request());
    assert.equal(disabled.status, 503);
    assert.equal(disabled.headers.get('cache-control'), 'no-store');
    assert.equal(disabled.headers.get('pragma'), 'no-cache');
    assert.deepEqual(await disabled.json(), {
      ok: false,
      error: 'TEMPORARILY_UNAVAILABLE',
    });

    process.env.SECURE_LEAD_GATEWAY_MODE = 'shadow';
    process.env.FEATURE_INTEGRATIONS_ENABLED = 'false';
    const gateOff = await POST(request());
    assert.equal(gateOff.status, 503);
  } finally {
    if (previous.mode === undefined) delete process.env.SECURE_LEAD_GATEWAY_MODE;
    else process.env.SECURE_LEAD_GATEWAY_MODE = previous.mode;
    if (previous.feature === undefined) delete process.env.FEATURE_INTEGRATIONS_ENABLED;
    else process.env.FEATURE_INTEGRATIONS_ENABLED = previous.feature;
    if (previous.keyring === undefined) delete process.env.SECURE_LEAD_GATEWAY_KEYRING_FILE;
    else process.env.SECURE_LEAD_GATEWAY_KEYRING_FILE = previous.keyring;
  }
});

test('N12 classifies security state and forbids telemetry, egress and legacy reuse', () => {
  assert.equal(
    classifyDataField('secure_lead_gateway_security_state_v2', 'secretDigest').classification,
    'AUTHENTICATION_SECRET',
  );
  assert.equal(
    classifyDataField('secure_lead_gateway_security_state_v2', 'receiptId').classification,
    'PERSONAL',
  );
  assert.equal(SECURE_LEAD_GATEWAY_RUNTIME.dormant, true);
  assert.equal(SECURE_LEAD_GATEWAY_RUNTIME.activation, 'NONE');
  const implementation = [
    readFileSync('src/lib/secure-lead-gateway.ts', 'utf8'),
    readFileSync('src/app/api/integrations/website/leads/v2/route.ts', 'utf8'),
  ].join('\n');
  assert.doesNotMatch(implementation, /operational-telemetry|AuditLog|console\.|fetch\(/);
  assert.doesNotMatch(implementation, /WebsiteLeadReceipt|WebsiteLeadRateLimitBucket|ApplicationKeyVersion/);
  assert.doesNotMatch(implementation, /ip-address|user-agent|x-forwarded-for/i);
});

test('current release surfaces pin migration 43 and keeps every N12/N13/N14 mode disabled', () => {
  for (const path of ['.env.example', '.env.production.example', '.env.staging.example']) {
    const source = readFileSync(path, 'utf8');
    assert.match(source, /SECURE_LEAD_GATEWAY_MODE="disabled"/);
    assert.match(source, /SECURE_LEAD_GATEWAY_KEYRING_FILE=""/);
    assert.match(source, /LEAD_IDENTITY_KEY_FILE=""/);
    assert.match(source, /COMMERCIAL_LEAD_INBOX_MODE="disabled"/);
  }
  const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
  assert.match(ci, /Apply exactly 43 database migrations/);
  assert.match(ci, /SECURE_LEAD_GATEWAY_MODE: disabled/);
  assert.match(ci, /SECURE_LEAD_GATEWAY_KEYRING_FILE: ""/);
  assert.match(ci, /LEAD_IDENTITY_KEY_FILE: ""/);
  assert.match(ci, /COMMERCIAL_LEAD_INBOX_MODE: disabled/);
  const smoke = readFileSync('scripts/smoke-docker-prod.sh', 'utf8');
  assert.match(smoke, /EXPECTED_MIGRATION_COUNT=43/);
  assert.match(smoke, /SECURE_LEAD_GATEWAY_MODE=disabled/);
  assert.match(smoke, /COMMERCIAL_LEAD_INBOX_MODE=disabled/);
  assert.match(smoke, /4\|25\|9\|5\|0\|0\|0\|0/);
  assert.match(smoke, /0\|0\|0\|0/);
  assert.match(smoke, /SHOW server_encoding/);
  assert.match(smoke, /Lead_active_email_n13_nfc_idx/);
  assert.match(smoke, /privacy_evidence_receipt_validate_v1/);
  const restore = readFileSync('scripts/n05/restore-drill.sh', 'utf8');
  assert.match(restore, /EXPECTED_MIGRATION_COUNT:-43/);
  assert.match(restore, /SECURE_LEAD_GATEWAY_MODE=disabled/);
  assert.match(restore, /COMMERCIAL_LEAD_INBOX_MODE=disabled/);
});
