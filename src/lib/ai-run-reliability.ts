import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { UserFacingActionError } from './action-errors';
import { prisma } from './prisma';

export const AI_RUN_RELIABILITY_VERSION = 1 as const;
export const AI_RUN_LEASE_DURATION_MS = 2 * 60 * 1000;
const DEFAULT_RECONCILE_BATCH_SIZE = 50;
const MAX_RECONCILE_BATCH_SIZE = 100;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const FAILURE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/;

function canonicalize(value: unknown, path: string): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`Valore numerico non JSON in ${path}.`);
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item, index) => canonicalize(item, `${path}[${index}]`)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`Oggetto non JSON in ${path}.`);
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => {
      const item = record[key];
      if (item === undefined) throw new TypeError(`Valore undefined non JSON in ${path}.${key}.`);
      return `${JSON.stringify(key)}:${canonicalize(item, `${path}.${key}`)}`;
    }).join(',')}}`;
  }
  throw new TypeError(`Valore non JSON in ${path}.`);
}

/** Stable JSON used only for hashes. Object keys are sorted; array order is preserved. */
export function canonicalJson(value: unknown) {
  return canonicalize(value, '$');
}

export function sha256(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function canonicalSha256(value: unknown) {
  return sha256(canonicalJson(value));
}

export function createAiRequestFingerprint(value: unknown) {
  return canonicalSha256(value);
}

export function assertSha256(value: string, label = 'Hash') {
  if (!HASH_PATTERN.test(value)) throw new TypeError(`${label} non valido.`);
  return value;
}

declare const aiRunLeaseBrand: unique symbol;
export type AiRunLease = { readonly [aiRunLeaseBrand]: true };

type AiRunLeaseClaims = {
  runId: string;
  secret: string;
  tokenHash: string;
  expiresAt: Date;
};

const activeAiRunLeases = new WeakMap<object, AiRunLeaseClaims>();

export type PreparedAiRunLease = {
  runId: string;
  lease: AiRunLease;
  leaseStartedAt: Date;
  leaseTokenHash: string;
  leaseExpiresAt: Date;
};

function createAiRunLease(options: { runId?: string; now?: Date; durationMs?: number } = {}): PreparedAiRunLease {
  const now = options.now ?? new Date();
  const durationMs = options.durationMs ?? AI_RUN_LEASE_DURATION_MS;
  if (!Number.isFinite(durationMs) || durationMs < 1_000 || durationMs > 15 * 60 * 1000) {
    throw new TypeError('Durata lease AI non valida.');
  }
  const runId = options.runId ?? randomUUID();
  const secret = randomBytes(32).toString('base64url');
  const tokenHash = sha256(secret);
  const expiresAt = new Date(now.getTime() + durationMs);
  const lease = Object.freeze({}) as AiRunLease;
  activeAiRunLeases.set(lease, { runId, secret, tokenHash, expiresAt });
  return {
    runId,
    lease,
    leaseStartedAt: new Date(now),
    leaseTokenHash: tokenHash,
    leaseExpiresAt: expiresAt,
  };
}

type AiRunClockDb = Pick<Prisma.TransactionClient, '$queryRaw'>;

/** Issue the lease from PostgreSQL's UTC clock so app/DB clock skew cannot alter its lifetime. */
export async function createAiRunLeaseWithDbClock(
  db: AiRunClockDb,
  options: { runId?: string; durationMs?: number } = {},
): Promise<PreparedAiRunLease> {
  const rows = await db.$queryRaw<Array<{ now: Date }>>(Prisma.sql`
    SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "now"
  `);
  const now = rows[0]?.now;
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new UserFacingActionError('Orologio database non disponibile per la lease AI.');
  }
  return createAiRunLease({ ...options, now });
}

export type AiRunLeaseBinding = {
  runId: string;
  leaseTokenHash: string;
  leaseExpiresAt: Date;
};

export function getAiRunLeaseBinding(lease: AiRunLease | null | undefined): AiRunLeaseBinding {
  if (!lease || typeof lease !== 'object') {
    throw new UserFacingActionError('Lease runtime AI assente o non valida.');
  }
  const claims = activeAiRunLeases.get(lease);
  if (!claims || sha256(claims.secret) !== claims.tokenHash) {
    throw new UserFacingActionError('Lease runtime AI assente o non valida.');
  }
  return {
    runId: claims.runId,
    leaseTokenHash: claims.tokenHash,
    leaseExpiresAt: new Date(claims.expiresAt),
  };
}

export function normalizeAiFailureCode(value: string) {
  const normalized = value.trim().toUpperCase();
  return FAILURE_CODE_PATTERN.test(normalized) ? normalized : 'AI_RUNTIME_FAILURE';
}

export type AiRunTerminalTelemetry = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  providerRequestId?: string;
};

type AiRunTerminalDb = Pick<Prisma.TransactionClient, '$queryRaw'>;

async function transitionAiRunWithLease(
  db: AiRunTerminalDb,
  lease: AiRunLease,
  options: {
    status: 'completed' | 'failed';
    failureCode: string | null;
    output?: Prisma.InputJsonValue | null;
    telemetry?: AiRunTerminalTelemetry;
  },
) {
  const binding = getAiRunLeaseBinding(lease);
  const failureCode = options.status === 'failed'
    ? normalizeAiFailureCode(options.failureCode ?? 'AI_RUNTIME_FAILURE')
    : null;
  const outputJson = JSON.stringify(options.output ?? null);
  const telemetry = options.telemetry ?? {};
  const rows = await db.$queryRaw<Array<{ id: string; finishedAt: Date }>>(Prisma.sql`
    UPDATE "AiRun"
    SET
      "status" = ${options.status},
      "finishedAt" = GREATEST(clock_timestamp() AT TIME ZONE 'UTC', "createdAt"),
      "failureCode" = ${failureCode},
      "leaseExpiresAt" = NULL,
      "leaseTokenHash" = NULL,
      "egressPermitHash" = NULL,
      "output" = CAST(${outputJson} AS jsonb),
      "inputTokens" = ${telemetry.inputTokens ?? null},
      "outputTokens" = ${telemetry.outputTokens ?? null},
      "totalTokens" = ${telemetry.totalTokens ?? null},
      "providerRequestId" = ${telemetry.providerRequestId ?? null}
    WHERE
      "id" = ${binding.runId}
      AND "reliabilityVersion" = ${AI_RUN_RELIABILITY_VERSION}
      AND "status" = 'running'
      AND "leaseTokenHash" = ${binding.leaseTokenHash}
      AND "leaseExpiresAt" = ${binding.leaseExpiresAt}
      AND "leaseExpiresAt" > (clock_timestamp() AT TIME ZONE 'UTC')
    RETURNING "id", "finishedAt"
  `);
  if (rows.length !== 1) {
    throw new UserFacingActionError('Lease del run AI scaduta o non più posseduta dal worker.');
  }
  return rows[0];
}

/** Terminal transition fenced against the database clock in the same SQL statement. */
export function completeAiRunWithLease(
  db: AiRunTerminalDb,
  lease: AiRunLease,
  options: { output?: Prisma.InputJsonValue | null; telemetry?: AiRunTerminalTelemetry } = {},
) {
  return transitionAiRunWithLease(db, lease, {
    status: 'completed',
    failureCode: null,
    ...options,
  });
}

/** Failure transition fenced against the database clock in the same SQL statement. */
export function failAiRunWithLease(
  db: AiRunTerminalDb,
  lease: AiRunLease,
  options: { failureCode: string; telemetry?: AiRunTerminalTelemetry },
) {
  return transitionAiRunWithLease(db, lease, {
    status: 'failed',
    failureCode: options.failureCode,
    telemetry: options.telemetry,
  });
}

export type ExistingReliableAiRun = {
  status: string;
  requestFingerprint: string | null;
};

/** A matching completed request may be reused; every other duplicate is fail-closed. */
export function resolveIdempotentAiRunState(
  existing: ExistingReliableAiRun,
  expectedFingerprint: string,
): 'completed' {
  assertSha256(expectedFingerprint, 'Fingerprint richiesta');
  if (existing.requestFingerprint !== expectedFingerprint) {
    throw new UserFacingActionError('Chiave richiesta AI già utilizzata per un contenuto differente. Ricarica la pagina.');
  }
  if (existing.status === 'completed') return 'completed';
  if (existing.status === 'running') {
    throw new UserFacingActionError('Questa esecuzione AI è già in corso. Attendi e ricarica la pagina.');
  }
  throw new UserFacingActionError('Questa richiesta AI è già terminata senza output. Ricarica la pagina per un nuovo tentativo.');
}

export async function reconcileExpiredAiRuns(options: {
  actorId?: string | null;
  batchSize?: number;
} = {}) {
  const requestedBatchSize = options.batchSize ?? DEFAULT_RECONCILE_BATCH_SIZE;
  const finiteBatchSize = Number.isFinite(requestedBatchSize)
    ? Math.trunc(requestedBatchSize)
    : DEFAULT_RECONCILE_BATCH_SIZE;
  const batchSize = Math.min(MAX_RECONCILE_BATCH_SIZE, Math.max(1, finiteBatchSize));

  return prisma.$transaction(async (tx) => {
    const expired = await tx.$queryRaw<Array<{
      id: string;
      provider: string;
      model: string | null;
      leaseExpiredAt: Date;
      egressStartedAt: Date | null;
      finishedAt: Date;
    }>>(Prisma.sql`
      WITH candidates AS (
        SELECT "id", "leaseExpiresAt"
        FROM "AiRun"
        WHERE
          "reliabilityVersion" = ${AI_RUN_RELIABILITY_VERSION}
          AND "status" = 'running'
          AND "leaseExpiresAt" IS NOT NULL
          AND "leaseTokenHash" IS NOT NULL
          AND "leaseExpiresAt" <= (clock_timestamp() AT TIME ZONE 'UTC')
        ORDER BY "leaseExpiresAt" ASC
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE "AiRun" AS run
      SET
        "status" = 'failed',
        "finishedAt" = GREATEST(clock_timestamp() AT TIME ZONE 'UTC', run."createdAt"),
        "failureCode" = 'AI_RUN_LEASE_EXPIRED',
        "leaseExpiresAt" = NULL,
        "leaseTokenHash" = NULL,
        "egressPermitHash" = NULL,
        "output" = NULL
      FROM candidates
      WHERE
        run."id" = candidates."id"
        AND run."reliabilityVersion" = ${AI_RUN_RELIABILITY_VERSION}
        AND run."status" = 'running'
      RETURNING
        run."id",
        run."provider",
        run."model",
        candidates."leaseExpiresAt" AS "leaseExpiredAt",
        run."egressStartedAt",
        run."finishedAt"
    `);
    if (expired.length) {
      await tx.auditLog.createMany({
        data: expired.map((run) => ({
          actorId: options.actorId ?? null,
          event: 'ai_run_lease_expired',
          entityType: 'AiRun',
          entityId: run.id,
          after: {
            aiRunId: run.id,
            status: 'failed',
            failureCode: 'AI_RUN_LEASE_EXPIRED',
            provider: run.provider,
            model: run.model,
            leaseExpiredAt: run.leaseExpiredAt.toISOString(),
            finishedAt: run.finishedAt.toISOString(),
            egressStartedAt: run.egressStartedAt?.toISOString() ?? null,
            externalEgressMayHaveStarted: Boolean(run.egressStartedAt),
          },
        })),
      });
    }
    return expired.length;
  }, { isolationLevel: 'ReadCommitted' });
}
