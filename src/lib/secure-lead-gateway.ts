import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import {
  admitBusinessInboxEventInTransaction,
  BusinessEventBackboneError,
} from './business-event-backbone';
import { environmentFeatureGateEnabled } from './application-security-policy';
import { assertClassifiedFields } from './data-classification';
import type { LeadSubmittedEventV1 } from './lead-event-contract';
import {
  assertSecureLeadGatewayTimestamp,
  digestSecureLeadGatewayKey,
  digestSecureLeadGatewayNonce,
  fingerprintSecureLeadGatewayRequest,
  SECURE_LEAD_GATEWAY_PROTOCOL,
  type SecureLeadGatewayDeadline,
  type SecureLeadGatewayHeaders,
  verifySecureLeadGatewaySignature,
} from './secure-lead-gateway-protocol';

export const SECURE_LEAD_GATEWAY_RUNTIME = Object.freeze({
  dormant: true,
  activation: 'NONE' as const,
  rateEmissionIntervalMs: 1_000,
  rateBurst: 10,
  rateSustainedPerMinute: 60,
  rotationOverlapSeconds: 900,
  retentionClassReceipt: 'SECURE_LEAD_GATEWAY_RECEIPT' as const,
  retentionClassRequest: 'SECURE_LEAD_GATEWAY_REQUEST' as const,
  retentionPolicyVersion: 'N21_UNASSIGNED' as const,
  receiptVersion: 1,
  transactionAttempts: 3,
  transactionMaximumLockMs: 1_000,
  transactionMaximumStatementMs: 4_000,
});

export type SecureLeadGatewayErrorCode =
  | 'UNAUTHORIZED'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'TEMPORARILY_UNAVAILABLE';

export class SecureLeadGatewayError extends Error {
  constructor(
    readonly code: SecureLeadGatewayErrorCode,
    readonly status: 401 | 409 | 429 | 503,
    readonly retryAfter: number | null = null,
  ) {
    super(code);
    this.name = 'SecureLeadGatewayError';
  }
}

function fail(
  code: SecureLeadGatewayErrorCode,
  status: 401 | 409 | 429 | 503,
  retryAfter: number | null = null,
): never {
  throw new SecureLeadGatewayError(code, status, retryAfter);
}

function unavailable(): never {
  return fail('TEMPORARILY_UNAVAILABLE', 503);
}

const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,79}$/;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DUMMY_HMAC_SECRET = Buffer.alloc(SECURE_LEAD_GATEWAY_PROTOCOL.secretBytes, 0);
const RETRYABLE_SQL_STATES = new Set(['40001', '40P01', '55P03']);
const RETRY_DELAYS_MS = [10, 25] as const;

interface SecureLeadGatewayKeyring {
  readonly size: number;
  get(keyId: string): Buffer | undefined;
}

function exactRecord(value: unknown, fields: readonly string[]) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) unavailable();
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== fields.length || keys.some((key) => !fields.includes(key))) unavailable();
  return record;
}

function parseKeyringJson(text: string): unknown {
  let cursor = 0;
  const maximumDepth = 8;
  const skipWhitespace = () => {
    while (cursor < text.length) {
      const code = text.charCodeAt(cursor);
      if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) break;
      cursor++;
    }
  };
  const parseString = () => {
    const start = cursor;
    if (text[cursor] !== '"') unavailable();
    cursor++;
    while (cursor < text.length) {
      const code = text.charCodeAt(cursor);
      if (code === 0x22) {
        cursor++;
        try {
          return JSON.parse(text.slice(start, cursor)) as string;
        } catch {
          return unavailable();
        }
      }
      if (code < 0x20) unavailable();
      if (code !== 0x5c) {
        cursor++;
        continue;
      }
      cursor++;
      const escape = text[cursor];
      if (escape === 'u') {
        cursor++;
        const hex = text.slice(cursor, cursor + 4);
        if (!/^[0-9a-fA-F]{4}$/u.test(hex)) unavailable();
        cursor += 4;
      } else {
        if (!escape || !'"\\/bfnrt'.includes(escape)) unavailable();
        cursor++;
      }
    }
    return unavailable();
  };
  const parseValue = (depth: number): unknown => {
    if (depth > maximumDepth) unavailable();
    skipWhitespace();
    const token = text[cursor];
    if (token === '"') return parseString();
    if (token === '{') {
      cursor++;
      skipWhitespace();
      const record = Object.create(null) as Record<string, unknown>;
      const fields = new Set<string>();
      if (text[cursor] === '}') {
        cursor++;
        return record;
      }
      while (cursor < text.length) {
        skipWhitespace();
        const field = parseString();
        if (fields.has(field)) unavailable();
        fields.add(field);
        skipWhitespace();
        if (text[cursor] !== ':') unavailable();
        cursor++;
        const value = parseValue(depth + 1);
        Object.defineProperty(record, field, {
          value,
          enumerable: true,
          configurable: false,
          writable: false,
        });
        skipWhitespace();
        if (text[cursor] === '}') {
          cursor++;
          return record;
        }
        if (text[cursor] !== ',') unavailable();
        cursor++;
      }
      return unavailable();
    }
    if (token === '[') {
      cursor++;
      skipWhitespace();
      const values: unknown[] = [];
      if (text[cursor] === ']') {
        cursor++;
        return values;
      }
      while (cursor < text.length) {
        values.push(parseValue(depth + 1));
        skipWhitespace();
        if (text[cursor] === ']') {
          cursor++;
          return values;
        }
        if (text[cursor] !== ',') unavailable();
        cursor++;
      }
      return unavailable();
    }
    for (const [literal, value] of [
      ['true', true],
      ['false', false],
      ['null', null],
    ] as const) {
      if (text.startsWith(literal, cursor)) {
        cursor += literal.length;
        return value;
      }
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(text.slice(cursor));
    if (!number) unavailable();
    cursor += number[0].length;
    return Number(number[0]);
  };
  const parsed = parseValue(0);
  skipWhitespace();
  if (cursor !== text.length) unavailable();
  return parsed;
}

export async function readSecureLeadGatewayKeyring(
  path = process.env.SECURE_LEAD_GATEWAY_KEYRING_FILE,
  options: { readonly allowedRoot?: string } = {},
): Promise<SecureLeadGatewayKeyring> {
  if (!path) unavailable();
  const allowedRoot = resolve(options.allowedRoot ?? '/run/secrets');
  const target = resolve(path);
  if (dirname(target) !== allowedRoot) unavailable();

  let handle;
  try {
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile()
      || stat.size < 1
      || stat.size > SECURE_LEAD_GATEWAY_PROTOCOL.maximumKeyringBytes
      || (stat.mode & 0o077) !== 0) unavailable();
    const raw = await handle.readFile();
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    } catch {
      return unavailable();
    }
    const parsed = parseKeyringJson(text);
    const root = exactRecord(parsed, ['version', 'keys']);
    if (root.version !== 1 || !Array.isArray(root.keys)
      || root.keys.length < 1
      || root.keys.length > SECURE_LEAD_GATEWAY_PROTOCOL.maximumKeyringEntries) unavailable();
    const secrets = new Map<string, Buffer>();
    for (const value of root.keys) {
      const entry = exactRecord(value, ['keyId', 'secretBase64']);
      if (typeof entry.keyId !== 'string'
        || !KEY_ID_PATTERN.test(entry.keyId)
        || typeof entry.secretBase64 !== 'string') unavailable();
      const secret = Buffer.from(entry.secretBase64, 'base64');
      if (secret.byteLength !== SECURE_LEAD_GATEWAY_PROTOCOL.secretBytes
        || secret.toString('base64') !== entry.secretBase64
        || secrets.has(entry.keyId)) unavailable();
      secrets.set(entry.keyId, secret);
    }
    return Object.freeze({
      size: secrets.size,
      get(keyId: string) {
        const secret = secrets.get(keyId);
        return secret ? Buffer.from(secret) : undefined;
      },
    });
  } catch (error) {
    if (error instanceof SecureLeadGatewayError) throw error;
    return unavailable();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function retryableDatabaseError(error: unknown) {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') return true;
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; meta?: { code?: unknown } };
  return (typeof candidate.code === 'string' && RETRYABLE_SQL_STATES.has(candidate.code))
    || (typeof candidate.meta?.code === 'string'
      && RETRYABLE_SQL_STATES.has(candidate.meta.code));
}

function wait(milliseconds: number) {
  return new Promise<void>((resolveWait) => setTimeout(resolveWait, milliseconds));
}

async function prepareTransaction(
  tx: Prisma.TransactionClient,
  deadline: SecureLeadGatewayDeadline,
) {
  deadline.assertRemaining();
  const remaining = deadline.remainingMs();
  const lockTimeout = Math.max(
    1,
    Math.min(remaining, SECURE_LEAD_GATEWAY_RUNTIME.transactionMaximumLockMs),
  );
  const statementTimeout = Math.max(
    1,
    Math.min(remaining, SECURE_LEAD_GATEWAY_RUNTIME.transactionMaximumStatementMs),
  );
  await tx.$executeRaw(Prisma.sql`
    SELECT set_config('lock_timeout', ${`${lockTimeout}ms`}, true),
      set_config('statement_timeout', ${`${statementTimeout}ms`}, true)
  `);
  deadline.assertRemaining();
}

export function deriveSecureLeadGatewayTransactionBudget(remainingMs: number) {
  if (!Number.isInteger(remainingMs) || remainingMs < 2) unavailable();
  const maxWait = Math.max(1, Math.min(2_000, Math.floor(remainingMs / 2)));
  return Object.freeze({ maxWait, timeout: remainingMs - maxWait });
}

async function runGatewayTransaction<T>(
  db: PrismaClient,
  deadline: SecureLeadGatewayDeadline,
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
) {
  for (let attempt = 0; attempt < SECURE_LEAD_GATEWAY_RUNTIME.transactionAttempts; attempt++) {
    deadline.assertRemaining();
    const budget = deriveSecureLeadGatewayTransactionBudget(deadline.remainingMs());
    try {
      return await db.$transaction(async (tx) => {
        await prepareTransaction(tx, deadline);
        return operation(tx);
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: budget.maxWait,
        timeout: budget.timeout,
      });
    } catch (error) {
      if (error instanceof SecureLeadGatewayError) throw error;
      if (error instanceof BusinessEventBackboneError) throw error;
      if (!retryableDatabaseError(error)) unavailable();
      if (attempt >= SECURE_LEAD_GATEWAY_RUNTIME.transactionAttempts - 1) unavailable();
      await wait(RETRY_DELAYS_MS[attempt]);
    }
  }
  return unavailable();
}

async function databaseNow(
  tx: Prisma.TransactionClient,
  precision: 'second' | 'milliseconds' = 'milliseconds',
) {
  const rows = await tx.$queryRaw<Array<{ now: Date }>>(Prisma.sql`
    SELECT DATE_TRUNC(${precision}, clock_timestamp()) AS "now"
  `);
  const now = rows[0]?.now;
  if (!now) unavailable();
  return now;
}

export async function isSecureLeadGatewayIntegrationEnabled(
  db: PrismaClient,
  deadline: SecureLeadGatewayDeadline,
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  if (!environmentFeatureGateEnabled('INTEGRATIONS', environment)) return false;
  return runGatewayTransaction(db, deadline, async (tx) => {
    const gate = await tx.applicationFeatureGate.findUnique({
      where: { code: 'INTEGRATIONS' },
      select: { enabled: true },
    });
    return gate?.enabled === true;
  });
}

interface KeyVersionRow {
  readonly id: string;
  readonly producerCode: string;
  readonly keyId: string;
  readonly version: number;
  readonly secretDigest: string;
  readonly status: string;
  readonly acceptFrom: Date;
  readonly acceptUntil: Date | null;
  readonly revokedAt: Date | null;
  readonly retiredAt: Date | null;
}

function keyAcceptsRequests(row: KeyVersionRow, now: Date) {
  if (row.revokedAt !== null || row.retiredAt !== null
    || row.acceptFrom.getTime() > now.getTime()) return false;
  if (row.status === 'ACTIVE') return row.acceptUntil === null;
  return row.status === 'RETIRING'
    && row.acceptUntil !== null
    && row.acceptUntil.getTime() >= now.getTime();
}

export interface AuthenticatedSecureLeadGatewayKey {
  readonly id: string;
  readonly producerCode: string;
  readonly keyId: string;
  readonly version: number;
  readonly secretDigest: string;
}

export async function authenticateSecureLeadGatewayRequest(
  db: PrismaClient,
  headers: SecureLeadGatewayHeaders,
  signedBytes: Uint8Array,
  deadline: SecureLeadGatewayDeadline,
  options: { readonly keyringPath?: string; readonly allowedKeyringRoot?: string } = {},
): Promise<AuthenticatedSecureLeadGatewayKey> {
  deadline.assertRemaining();
  const keyring = await readSecureLeadGatewayKeyring(options.keyringPath, {
    allowedRoot: options.allowedKeyringRoot,
  });
  const lookup = await runGatewayTransaction(db, deadline, async (tx) => {
    const now = await databaseNow(tx, 'second');
    const rows = await tx.$queryRaw<KeyVersionRow[]>(Prisma.sql`
      SELECT "id", "producerCode", "keyId", "version", "secretDigest", "status",
        "acceptFrom", "acceptUntil", "revokedAt", "retiredAt"
      FROM "SecureLeadGatewayKeyVersion"
      WHERE "keyId" = ${headers.keyId}
      LIMIT 1
    `);
    return { now, row: rows[0] ?? null };
  });

  let timestampValid = true;
  try {
    assertSecureLeadGatewayTimestamp(headers.timestampSeconds, lookup.now);
  } catch {
    timestampValid = false;
  }
  const localSecret = keyring.get(headers.keyId);
  const databaseEligible = lookup.row !== null && keyAcceptsRequests(lookup.row, lookup.now);
  const keyConsensus = lookup.row !== null
    && localSecret !== undefined
    && digestSecureLeadGatewayKey(localSecret) === lookup.row.secretDigest;
  const signatureCompared = verifySecureLeadGatewaySignature(
    localSecret ?? DUMMY_HMAC_SECRET,
    signedBytes,
    headers.signature,
  );
  const signatureValid = localSecret !== undefined && signatureCompared;
  deadline.assertRemaining();
  if (!headers.authenticationHeadersValid
    || !timestampValid
    || !databaseEligible
    || !signatureValid
    || lookup.row === null) fail('UNAUTHORIZED', 401);
  if (!keyConsensus) unavailable();
  return Object.freeze({
    id: lookup.row.id,
    producerCode: lookup.row.producerCode,
    keyId: lookup.row.keyId,
    version: lookup.row.version,
    secretDigest: lookup.row.secretDigest,
  });
}

export interface SecureLeadGatewayRateResult {
  readonly allowed: boolean;
  readonly retryAfter: number | null;
}

export async function consumeSecureLeadGatewayRateLimit(
  db: PrismaClient,
  producerCode: string,
  deadline: SecureLeadGatewayDeadline,
): Promise<SecureLeadGatewayRateResult> {
  return runGatewayTransaction(db, deadline, async (tx) => {
    await tx.$executeRaw(Prisma.sql`
      SELECT pg_advisory_xact_lock(hashtextextended(
        ${`fai.secure-lead-gateway.rate.v1\n${producerCode}`}, 0
      ))
    `);
    const now = await databaseNow(tx);
    const rows = await tx.$queryRaw<Array<{ theoreticalArrivalAt: Date }>>(Prisma.sql`
      SELECT "theoreticalArrivalAt"
      FROM "SecureLeadGatewayRateLimitBucket"
      WHERE "producerCode" = ${producerCode}
      FOR UPDATE
    `);
    const current = rows[0]?.theoreticalArrivalAt ?? null;
    const toleranceMs = (SECURE_LEAD_GATEWAY_RUNTIME.rateBurst - 1)
      * SECURE_LEAD_GATEWAY_RUNTIME.rateEmissionIntervalMs;
    if (current && now.getTime() < current.getTime() - toleranceMs) {
      const retryAfter = Math.max(
        1,
        Math.min(60, Math.ceil((current.getTime() - toleranceMs - now.getTime()) / 1_000)),
      );
      return Object.freeze({ allowed: false, retryAfter });
    }
    const theoreticalArrivalAt = new Date(
      Math.max(current?.getTime() ?? 0, now.getTime())
        + SECURE_LEAD_GATEWAY_RUNTIME.rateEmissionIntervalMs,
    );
    assertClassifiedFields('secure_lead_gateway_security_state_v2', {
      producerCode,
      theoreticalArrivalAt,
    });
    if (current) {
      await tx.$executeRaw(Prisma.sql`
        UPDATE "SecureLeadGatewayRateLimitBucket"
        SET "theoreticalArrivalAt" = ${theoreticalArrivalAt}
        WHERE "producerCode" = ${producerCode}
      `);
    } else {
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "SecureLeadGatewayRateLimitBucket" (
          "producerCode", "theoreticalArrivalAt", "createdAt", "updatedAt"
        ) VALUES (${producerCode}, ${theoreticalArrivalAt}, ${now}, ${now})
      `);
    }
    return Object.freeze({ allowed: true, retryAfter: null });
  });
}

function publicReceipt(id: string) {
  if (!UUID_V4_PATTERN.test(id)) unavailable();
  return `slg2_${id.replaceAll('-', '')}`;
}

export async function admitSecureLeadGatewayEvent(
  db: PrismaClient,
  input: {
    readonly key: AuthenticatedSecureLeadGatewayKey;
    readonly headers: Pick<SecureLeadGatewayHeaders, 'nonce'>;
    readonly signedBytes: Uint8Array;
    readonly event: LeadSubmittedEventV1;
    readonly deadline: SecureLeadGatewayDeadline;
  },
) {
  const nonceDigest = digestSecureLeadGatewayNonce(
    input.key.producerCode,
    input.headers.nonce,
  );
  const requestFingerprint = fingerprintSecureLeadGatewayRequest(input.signedBytes);
  return runGatewayTransaction(db, input.deadline, async (tx) => {
    const keyRows = await tx.$queryRaw<KeyVersionRow[]>(Prisma.sql`
      SELECT "id", "producerCode", "keyId", "version", "secretDigest", "status",
        "acceptFrom", "acceptUntil", "revokedAt", "retiredAt"
      FROM "SecureLeadGatewayKeyVersion"
      WHERE "id" = ${input.key.id}::UUID
      FOR SHARE
    `);
    const key = keyRows[0];
    const keyNow = await databaseNow(tx);
    if (!key
      || key.id !== input.key.id
      || key.producerCode !== input.key.producerCode
      || key.keyId !== input.key.keyId
      || key.version !== input.key.version
      || key.secretDigest !== input.key.secretDigest
      || !keyAcceptsRequests(key, keyNow)) fail('UNAUTHORIZED', 401);

    await tx.$executeRaw(Prisma.sql`
      SELECT pg_advisory_xact_lock(hashtextextended(
        ${`fai.secure-lead-gateway.replay.v1\n${input.key.producerCode}\n${nonceDigest}`}, 0
      ))
    `);
    const existing = await tx.$queryRaw<Array<{
      requestFingerprint: string;
      receiptId: string;
    }>>(Prisma.sql`
      SELECT "requestFingerprint", "receiptId"
      FROM "SecureLeadGatewayRequest"
      WHERE "producerCode" = ${input.key.producerCode}
        AND "nonceDigest" = ${nonceDigest}
      FOR KEY SHARE
    `);
    if (existing[0]) {
      if (existing.length !== 1 || existing[0].requestFingerprint !== requestFingerprint) {
        fail('CONFLICT', 409);
      }
      return Object.freeze({ receipt: publicReceipt(existing[0].receiptId) });
    }

    let admission;
    try {
      admission = await admitBusinessInboxEventInTransaction(tx, input.event);
    } catch (error) {
      if (error instanceof BusinessEventBackboneError
        && error.code === 'BUSINESS_INBOX_IDEMPOTENCY_CONFLICT') fail('CONFLICT', 409);
      return unavailable();
    }
    const createdAt = await databaseNow(tx);
    const retentionEligibleAt = new Date(
      createdAt.getTime() + SECURE_LEAD_GATEWAY_PROTOCOL.replayRetentionSeconds * 1_000,
    );
    const candidateReceiptId = randomUUID();
    const insertedReceipt = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      INSERT INTO "SecureLeadGatewayReceipt" (
        "id", "inboxEventId", "receiptVersion", "retentionClass",
        "retentionPolicyVersion", "retentionEligibleAt", "createdAt"
      ) VALUES (
        ${candidateReceiptId}::UUID, ${admission.inboxEventId}::UUID,
        ${SECURE_LEAD_GATEWAY_RUNTIME.receiptVersion},
        ${SECURE_LEAD_GATEWAY_RUNTIME.retentionClassReceipt},
        ${SECURE_LEAD_GATEWAY_RUNTIME.retentionPolicyVersion},
        ${retentionEligibleAt}, ${createdAt}
      )
      ON CONFLICT ("inboxEventId") DO NOTHING
      RETURNING "id"
    `);
    const receiptRows = insertedReceipt[0]
      ? insertedReceipt
      : await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT "id" FROM "SecureLeadGatewayReceipt"
          WHERE "inboxEventId" = ${admission.inboxEventId}::UUID
          FOR KEY SHARE
        `);
    const receiptId = receiptRows[0]?.id;
    if (!receiptId || receiptRows.length !== 1) unavailable();
    const requestId = randomUUID();
    assertClassifiedFields('secure_lead_gateway_security_state_v2', {
      producerCode: input.key.producerCode,
      keyVersionId: input.key.id,
      nonceDigest,
      requestFingerprint,
      receiptId,
      inboxEventId: admission.inboxEventId,
      retentionClass: SECURE_LEAD_GATEWAY_RUNTIME.retentionClassRequest,
      retentionPolicyVersion: SECURE_LEAD_GATEWAY_RUNTIME.retentionPolicyVersion,
      retentionEligibleAt,
      createdAt,
    });
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "SecureLeadGatewayRequest" (
        "id", "producerCode", "keyVersionId", "nonceDigest", "requestFingerprint",
        "receiptId", "retentionClass", "retentionPolicyVersion", "retentionEligibleAt",
        "createdAt"
      ) VALUES (
        ${requestId}::UUID, ${input.key.producerCode}, ${input.key.id}::UUID,
        ${nonceDigest}, ${requestFingerprint}, ${receiptId}::UUID,
        ${SECURE_LEAD_GATEWAY_RUNTIME.retentionClassRequest},
        ${SECURE_LEAD_GATEWAY_RUNTIME.retentionPolicyVersion},
        ${retentionEligibleAt}, ${createdAt}
      )
    `);
    return Object.freeze({ receipt: publicReceipt(receiptId) });
  });
}
