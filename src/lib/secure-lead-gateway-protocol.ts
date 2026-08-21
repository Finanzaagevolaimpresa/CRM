import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { canonicalJson } from './canonical-json';
import {
  parseLeadSubmittedEventV1,
  type LeadSubmittedEventV1,
} from './lead-event-contract';

export const SECURE_LEAD_GATEWAY_PROTOCOL = Object.freeze({
  version: 1,
  method: 'POST' as const,
  path: '/api/integrations/website/leads/v2' as const,
  contentType: 'application/vnd.fai.lead-event.v1+json' as const,
  signaturePrefix: 'v1=' as const,
  hmacAlgorithm: 'sha256' as const,
  requestDomain: 'fai.secure-lead-gateway.request.v1' as const,
  keyDomain: 'fai.secure-lead-gateway.key.v1' as const,
  nonceDomain: 'fai.secure-lead-gateway.nonce.v1' as const,
  replayDomain: 'fai.secure-lead-gateway.replay.v1' as const,
  maximumBodyBytes: 16 * 1024,
  timeoutMs: 5_000,
  maximumClockSkewSeconds: 300,
  replayRetentionSeconds: 24 * 60 * 60,
  maximumKeyringBytes: 4 * 1024,
  maximumKeyringEntries: 4,
  secretBytes: 32,
});

export type SecureLeadGatewayMode = 'disabled' | 'shadow' | 'enforced';

export function secureLeadGatewayMode(
  value = process.env.SECURE_LEAD_GATEWAY_MODE,
): SecureLeadGatewayMode {
  return value === 'shadow' || value === 'enforced' || value === 'disabled'
    ? value
    : 'disabled';
}

export type SecureLeadGatewayProtocolErrorCode =
  | 'INVALID_REQUEST'
  | 'UNAUTHORIZED'
  | 'TEMPORARILY_UNAVAILABLE';

export class SecureLeadGatewayProtocolError extends Error {
  constructor(
    readonly code: SecureLeadGatewayProtocolErrorCode,
    readonly status: 400 | 401 | 413 | 503,
  ) {
    super(code);
    this.name = 'SecureLeadGatewayProtocolError';
  }
}

function invalid(status: 400 | 413 = 400): never {
  throw new SecureLeadGatewayProtocolError('INVALID_REQUEST', status);
}

function unauthorized(): never {
  throw new SecureLeadGatewayProtocolError('UNAUTHORIZED', 401);
}

export class SecureLeadGatewayDeadlineError extends SecureLeadGatewayProtocolError {
  constructor() {
    super('TEMPORARILY_UNAVAILABLE', 503);
    this.name = 'SecureLeadGatewayDeadlineError';
  }
}

export class SecureLeadGatewayDeadline {
  readonly expiresAt: number;

  constructor(
    startedAt = Date.now(),
    readonly now: () => number = Date.now,
  ) {
    this.expiresAt = startedAt + SECURE_LEAD_GATEWAY_PROTOCOL.timeoutMs;
  }

  remainingMs() {
    return Math.max(0, this.expiresAt - this.now());
  }

  assertRemaining() {
    if (this.remainingMs() <= 0) throw new SecureLeadGatewayDeadlineError();
  }
}

export interface SecureLeadGatewayHeaders {
  readonly keyId: string;
  readonly timestamp: string;
  readonly timestampSeconds: number;
  readonly nonce: string;
  readonly signature: string;
  readonly contentLength: number | null;
}

const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,79}$/;
const TIMESTAMP_PATTERN = /^\d{10}$/;
const NONCE_PATTERN = /^[0-9a-f]{32}$/;
const SIGNATURE_PATTERN = /^v1=[0-9a-f]{64}$/;
const CONTENT_LENGTH_PATTERN = /^(?:0|[1-9]\d*)$/;

function requiredSingleHeader(headers: Headers, name: string) {
  const value = headers.get(name);
  if (value === null || value.includes(',')) unauthorized();
  return value;
}

export function readSecureLeadGatewayHeaders(request: Request): SecureLeadGatewayHeaders {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return invalid();
  }
  if (
    request.method !== SECURE_LEAD_GATEWAY_PROTOCOL.method
    || url.pathname !== SECURE_LEAD_GATEWAY_PROTOCOL.path
    || url.search !== ''
    || request.headers.get('content-type') !== SECURE_LEAD_GATEWAY_PROTOCOL.contentType
    || request.headers.has('content-encoding')
  ) invalid();

  const keyId = requiredSingleHeader(request.headers, 'x-fai-key-id');
  const timestamp = requiredSingleHeader(request.headers, 'x-fai-timestamp');
  const nonce = requiredSingleHeader(request.headers, 'x-fai-nonce');
  const signature = requiredSingleHeader(request.headers, 'x-fai-signature');
  if (!KEY_ID_PATTERN.test(keyId)
    || !TIMESTAMP_PATTERN.test(timestamp)
    || !NONCE_PATTERN.test(nonce)
    || !SIGNATURE_PATTERN.test(signature)) unauthorized();

  const rawContentLength = request.headers.get('content-length');
  let contentLength: number | null = null;
  if (rawContentLength !== null) {
    if (rawContentLength.includes(',') || !CONTENT_LENGTH_PATTERN.test(rawContentLength)) invalid();
    contentLength = Number(rawContentLength);
    if (!Number.isSafeInteger(contentLength)) invalid();
    if (contentLength > SECURE_LEAD_GATEWAY_PROTOCOL.maximumBodyBytes) invalid(413);
  }
  return Object.freeze({
    keyId,
    timestamp,
    timestampSeconds: Number(timestamp),
    nonce,
    signature,
    contentLength,
  });
}

export async function readSecureLeadGatewayRawBody(
  request: Request,
  signal: AbortSignal,
  declaredLength: number | null,
) {
  if (!request.body) {
    if (declaredLength !== null && declaredLength !== 0) invalid();
    return Buffer.alloc(0);
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => void reader.cancel();
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new SecureLeadGatewayDeadlineError();
      const { done, value } = await reader.read();
      if (signal.aborted) throw new SecureLeadGatewayDeadlineError();
      if (done) break;
      size += value.byteLength;
      if (size > SECURE_LEAD_GATEWAY_PROTOCOL.maximumBodyBytes) {
        await reader.cancel();
        invalid(413);
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener('abort', abort);
  }
  if (declaredLength !== null && declaredLength !== size) invalid();
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), size);
}

export function parseCanonicalSecureLeadGatewayEnvelope(
  rawBody: Uint8Array,
): LeadSubmittedEventV1 {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(rawBody);
  } catch {
    return invalid();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return invalid();
  }
  let event: LeadSubmittedEventV1;
  try {
    event = parseLeadSubmittedEventV1(parsed);
  } catch {
    return invalid();
  }
  const canonical = Buffer.from(canonicalJson(event), 'utf8');
  const supplied = Buffer.from(rawBody);
  if (!canonical.equals(supplied)) invalid();
  return event;
}

export function createSecureLeadGatewaySignedBytes(
  headers: Pick<SecureLeadGatewayHeaders, 'keyId' | 'timestamp' | 'nonce'>,
  rawBody: Uint8Array,
) {
  const prefix = [
    SECURE_LEAD_GATEWAY_PROTOCOL.requestDomain,
    SECURE_LEAD_GATEWAY_PROTOCOL.method,
    SECURE_LEAD_GATEWAY_PROTOCOL.path,
    SECURE_LEAD_GATEWAY_PROTOCOL.contentType,
    headers.keyId,
    headers.timestamp,
    headers.nonce,
    String(rawBody.byteLength),
    '',
  ].join('\n');
  return Buffer.concat([Buffer.from(prefix, 'ascii'), Buffer.from(rawBody)]);
}

function requireSecret(secret: Uint8Array) {
  if (secret.byteLength !== SECURE_LEAD_GATEWAY_PROTOCOL.secretBytes) unauthorized();
  return Buffer.from(secret);
}

export function createSecureLeadGatewaySignature(
  secret: Uint8Array,
  signedBytes: Uint8Array,
) {
  return `${SECURE_LEAD_GATEWAY_PROTOCOL.signaturePrefix}${createHmac(
    SECURE_LEAD_GATEWAY_PROTOCOL.hmacAlgorithm,
    requireSecret(secret),
  ).update(signedBytes).digest('hex')}`;
}

export function verifySecureLeadGatewaySignature(
  secret: Uint8Array,
  signedBytes: Uint8Array,
  suppliedSignature: string,
) {
  const expected = createHmac(
    SECURE_LEAD_GATEWAY_PROTOCOL.hmacAlgorithm,
    requireSecret(secret),
  ).update(signedBytes).digest();
  const validFormat = SIGNATURE_PATTERN.test(suppliedSignature);
  const supplied = validFormat
    ? Buffer.from(suppliedSignature.slice(SECURE_LEAD_GATEWAY_PROTOCOL.signaturePrefix.length), 'hex')
    : Buffer.alloc(32);
  return validFormat && timingSafeEqual(expected, supplied);
}

function digest(domain: string, chunks: readonly Uint8Array[]) {
  const hash = createHash('sha256');
  hash.update(`${domain}\n`, 'ascii');
  for (const chunk of chunks) hash.update(chunk);
  return hash.digest('hex');
}

export function digestSecureLeadGatewayKey(secret: Uint8Array) {
  return digest(SECURE_LEAD_GATEWAY_PROTOCOL.keyDomain, [requireSecret(secret)]);
}

export function digestSecureLeadGatewayNonce(producerCode: string, nonce: string) {
  if (producerCode.length < 1 || producerCode.length > 80 || !NONCE_PATTERN.test(nonce)) {
    unauthorized();
  }
  return digest(SECURE_LEAD_GATEWAY_PROTOCOL.nonceDomain, [
    Buffer.from(`${producerCode}\n${nonce}`, 'ascii'),
  ]);
}

export function fingerprintSecureLeadGatewayRequest(signedBytes: Uint8Array) {
  return digest(SECURE_LEAD_GATEWAY_PROTOCOL.replayDomain, [signedBytes]);
}

export function assertSecureLeadGatewayTimestamp(
  timestampSeconds: number,
  databaseNow: Date,
) {
  const databaseSeconds = Math.trunc(databaseNow.getTime() / 1_000);
  if (!Number.isSafeInteger(timestampSeconds)
    || Math.abs(timestampSeconds - databaseSeconds)
      > SECURE_LEAD_GATEWAY_PROTOCOL.maximumClockSkewSeconds) unauthorized();
}
