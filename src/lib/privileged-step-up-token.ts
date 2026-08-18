import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const PRIVILEGED_STEP_UP_TTL_SECONDS = 5 * 60;
const TOKEN_PATTERN = /^su1\.([A-Za-z0-9_-]{1,1400})\.([A-Za-z0-9_-]{43})$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export type PrivilegedStepUpKey = {
  version: number;
  secret: string;
};

type TokenPayload = {
  k: number;
  u: string;
  b: string;
  i: number;
  e: number;
  n: string;
};

function base64Url(value: Buffer | string) {
  return Buffer.from(value).toString('base64url');
}

function sign(payload: string, secret: string) {
  return createHmac('sha256', secret).update(`su1.${payload}`).digest('base64url');
}

export function privilegedStepUpKeyDigest(secret: string) {
  return createHash('sha256').update(secret).digest();
}

export function privilegedSessionBinding(sessionToken: string) {
  return createHash('sha256').update(sessionToken).digest('hex');
}

function validKey(key: PrivilegedStepUpKey) {
  return Number.isSafeInteger(key.version) && key.version > 0 && key.secret.length >= 32;
}

function parsePayload(encoded: string): TokenPayload | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const payload = value as Partial<TokenPayload>;
    if (Object.keys(payload).sort().join(',') !== 'b,e,i,k,n,u') return null;
    if (!Number.isSafeInteger(payload.k) || Number(payload.k) <= 0) return null;
    if (typeof payload.u !== 'string' || payload.u.length < 1 || payload.u.length > 191) return null;
    if (typeof payload.b !== 'string' || !DIGEST_PATTERN.test(payload.b)) return null;
    if (!Number.isSafeInteger(payload.i) || !Number.isSafeInteger(payload.e)) return null;
    if (typeof payload.n !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(payload.n)) return null;
    return payload as TokenPayload;
  } catch {
    return null;
  }
}

export function createPrivilegedStepUpToken(input: {
  key: PrivilegedStepUpKey;
  userId: string;
  sessionToken: string;
  nowSeconds?: number;
  ttlSeconds?: number;
}) {
  if (!validKey(input.key)) throw new TypeError('PRIVILEGED_STEP_UP_KEY_INVALID');
  if (!input.userId || input.userId.length > 191 || !input.sessionToken) {
    throw new TypeError('PRIVILEGED_STEP_UP_SUBJECT_INVALID');
  }
  const issuedAt = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const ttl = input.ttlSeconds ?? PRIVILEGED_STEP_UP_TTL_SECONDS;
  if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(ttl) || ttl < 1 || ttl > PRIVILEGED_STEP_UP_TTL_SECONDS) {
    throw new TypeError('PRIVILEGED_STEP_UP_TTL_INVALID');
  }
  const payload: TokenPayload = {
    k: input.key.version,
    u: input.userId,
    b: privilegedSessionBinding(input.sessionToken),
    i: issuedAt,
    e: issuedAt + ttl,
    n: randomBytes(16).toString('base64url'),
  };
  const encoded = base64Url(JSON.stringify(payload));
  return `su1.${encoded}.${sign(encoded, input.key.secret)}`;
}

export function verifyPrivilegedStepUpToken(input: {
  token: string | undefined;
  key: PrivilegedStepUpKey;
  expectedUserId: string;
  sessionToken: string;
  nowSeconds?: number;
}) {
  if (!input.token || input.token.length > 1600 || !validKey(input.key) || !input.sessionToken) return false;
  const match = TOKEN_PATTERN.exec(input.token);
  if (!match) return false;
  const [, encoded, receivedSignature] = match;
  const expectedSignature = sign(encoded, input.key.secret);
  const received = Buffer.from(receivedSignature, 'base64url');
  const expected = Buffer.from(expectedSignature, 'base64url');
  if (base64Url(received) !== receivedSignature) return false;
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return false;

  const payload = parsePayload(encoded);
  if (!payload || payload.k !== input.key.version || payload.u !== input.expectedUserId) return false;
  if (payload.b !== privilegedSessionBinding(input.sessionToken)) return false;
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(now) || payload.i > now + 5 || payload.e <= now) return false;
  return payload.e > payload.i && payload.e - payload.i <= PRIVILEGED_STEP_UP_TTL_SECONDS;
}
