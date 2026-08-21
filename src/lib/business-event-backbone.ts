import { randomBytes, randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { canonicalJson, sha256 } from './canonical-json';
import {
  LeadEventContractError,
  MAX_LEAD_EVENT_BYTES,
  parseLeadSubmittedEventV1,
  type LeadSubmittedEventV1,
} from './lead-event-contract';

export const BUSINESS_EVENT_BACKBONE_ERROR_CODES = Object.freeze([
  'BUSINESS_INBOX_EVENT_INVALID',
  'BUSINESS_INBOX_HASH_INVALID',
  'BUSINESS_INBOX_IDEMPOTENCY_CONFLICT',
  'BUSINESS_OUTBOX_SOURCE_INVALID',
  'BUSINESS_OUTBOX_IDEMPOTENCY_CONFLICT',
  'BUSINESS_QUEUE_STATE_CONFLICT',
  'BUSINESS_QUEUE_LEASE_STALE',
  'BUSINESS_QUEUE_RETRY_EXHAUSTED',
  'BUSINESS_QUEUE_DATABASE_CONFLICT',
  'BUSINESS_QUEUE_INTEGRITY_FAILURE',
  'BUSINESS_QUEUE_INTERNAL_FAILURE',
] as const);

export type BusinessEventBackboneErrorCode =
  typeof BUSINESS_EVENT_BACKBONE_ERROR_CODES[number];

export class BusinessEventBackboneError extends Error {
  constructor(readonly code: BusinessEventBackboneErrorCode) {
    super(code);
    this.name = 'BusinessEventBackboneError';
  }
}

export const BUSINESS_EVENT_BACKBONE_MANIFEST = Object.freeze({
  version: 1,
  dormant: true,
  runtimeProducers: Object.freeze([] as string[]),
  runtimeConsumers: Object.freeze([] as string[]),
  activation: 'NONE' as const,
  schemaVersion: 'fai.lead-event.v1' as const,
  eventType: 'LEAD_SUBMITTED' as const,
  eventVersion: 1 as const,
  canonicalizationVersion: 1 as const,
  classificationCatalogVersion: 'n04-v1' as const,
  classificationContractCode: 'lead_business_event_v1' as const,
  retentionClass: 'LEAD_BUSINESS_EVENT' as const,
  retentionPolicyVersion: 'N21_UNASSIGNED' as const,
  maxEnvelopeBytes: MAX_LEAD_EVENT_BYTES,
  maxAttempts: 5,
  initialLeaseSeconds: 60,
  maximumLeaseSeconds: 300,
  maximumRecoveryBatch: 100,
  transactionAttempts: 3,
  transactionTimeoutMs: 5_000,
  transactionMaxWaitMs: 2_000,
  lockTimeoutMs: 1_000,
  statementTimeoutMs: 4_000,
  retryDelaysSeconds: Object.freeze([5, 30, 300, 1_800] as const),
  hashDomains: Object.freeze({
    inboxRecord: 'fai.business-inbox.record.v1',
    outboxRecord: 'fai.business-outbox.record.v1',
    leaseToken: 'fai.business-queue.lease-token.v1',
    attempt: 'fai.business-queue.attempt.v1',
    completion: 'fai.business-queue.attempt-completion.v1',
  }),
});

export type BusinessQueueKind = 'INBOX' | 'OUTBOX';
export type BusinessInboxState = 'AVAILABLE' | 'LEASED' | 'PROCESSED' | 'DEAD_LETTER';
export type BusinessOutboxState = 'AVAILABLE' | 'LEASED' | 'PUBLISHED' | 'DEAD_LETTER';
export type BusinessQueueOutcome =
  | 'PROCESSED'
  | 'PUBLISHED'
  | 'RETRY_SCHEDULED'
  | 'DEAD_LETTER'
  | 'LEASE_EXPIRED';
export type BusinessIdempotencyOutcome = 'NEW' | 'REPLAY' | 'CONFLICT';

type Tx = Prisma.TransactionClient;

interface ContractRow {
  readonly id: string;
  readonly schemaVersion: string;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly canonicalizationVersion: number;
  readonly eventId: string;
  readonly businessCorrelationId: string;
  readonly occurredAt: string;
  readonly keyDigest: string;
  readonly payloadHash: string;
  readonly envelopeJson: string;
  readonly recordHash: string;
  readonly classificationCatalogVersion: string;
  readonly classificationContractCode: string;
  readonly state: string;
  readonly availableAt: Date;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly fencingToken: bigint;
  readonly leaseOwnerId: string | null;
  readonly leaseTokenHash: string | null;
  readonly leaseClaimedAt: Date | null;
  readonly leaseExpiresAt: Date | null;
  readonly leaseMaxExpiresAt: Date | null;
  readonly terminalAt: Date | null;
  readonly terminalReasonCode: string | null;
  readonly lastFailureCode: string | null;
  readonly retentionClass: string;
  readonly retentionPolicyVersion: string;
  readonly retentionEligibleAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

type InboxRow = ContractRow;

interface OutboxRow extends ContractRow {
  readonly sourceInboxEventId: string;
  readonly producerCode: string;
  readonly destinationCode: string;
}

interface AttemptRow {
  readonly id: string;
  readonly queueKind: string;
  readonly inboxEventId: string | null;
  readonly outboxEventId: string | null;
  readonly attemptSequence: number;
  readonly fencingToken: bigint;
  readonly leaseOwnerId: string;
  readonly leaseTokenHash: string;
  readonly claimedAt: Date;
  readonly leaseExpiresAt: Date;
  readonly leaseMaxExpiresAt: Date;
  readonly attemptHash: string;
  readonly finishedAt: Date | null;
  readonly outcome: string | null;
  readonly failureCode: string | null;
  readonly retryable: boolean | null;
  readonly nextAvailableAt: Date | null;
  readonly completionHash: string | null;
  readonly createdAt: Date;
}

interface VerifiedEnvelope {
  readonly event: LeadSubmittedEventV1;
  readonly envelopeJson: string;
}

export interface BusinessInboxAdmissionResult {
  readonly outcome: Exclude<BusinessIdempotencyOutcome, 'CONFLICT'>;
  readonly inboxEventId: string;
}

export interface BusinessOutboxEnqueueResult {
  readonly outcome: Exclude<BusinessIdempotencyOutcome, 'CONFLICT'>;
  readonly outboxEventId: string;
}

export interface BusinessQueueLease {
  readonly queueKind: BusinessQueueKind;
  readonly eventRowId: string;
  readonly attemptId: string;
  readonly attemptSequence: number;
  readonly fencingToken: bigint;
  readonly leaseOwnerId: string;
  readonly leaseToken: string;
  readonly leaseExpiresAt: Date;
  readonly leaseMaxExpiresAt: Date;
  readonly envelope: LeadSubmittedEventV1;
}

export interface BusinessQueueLeaseIdentity {
  readonly queueKind: BusinessQueueKind;
  readonly eventRowId: string;
  readonly attemptId: string;
  readonly fencingToken: bigint;
  readonly leaseOwnerId: string;
  readonly leaseToken: string;
}

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BUSINESS_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_.:-]{0,79}$/;
const FAILURE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const RAW_LEASE_TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const RETRYABLE_SQL_STATES = new Set(['40001', '40P01', '55P03']);
const RETRY_DELAYS_MS = [10, 25] as const;

function fail(code: BusinessEventBackboneErrorCode): never {
  throw new BusinessEventBackboneError(code);
}

function normalizeUuid(value: unknown) {
  if (typeof value !== 'string') fail('BUSINESS_QUEUE_STATE_CONFLICT');
  const normalized = value.toLowerCase();
  if (!UUID_V4_PATTERN.test(normalized)) fail('BUSINESS_QUEUE_STATE_CONFLICT');
  return normalized;
}

export function normalizeBusinessQueueCode(value: unknown) {
  if (typeof value !== 'string') fail('BUSINESS_QUEUE_STATE_CONFLICT');
  const normalized = value.trim();
  if (!BUSINESS_CODE_PATTERN.test(normalized)) fail('BUSINESS_QUEUE_STATE_CONFLICT');
  return normalized;
}

export function normalizeBusinessQueueFailureCode(value: unknown) {
  if (typeof value !== 'string') fail('BUSINESS_QUEUE_STATE_CONFLICT');
  const normalized = value.trim();
  if (!FAILURE_CODE_PATTERN.test(normalized)) fail('BUSINESS_QUEUE_STATE_CONFLICT');
  return normalized;
}

function parseEnvelope(value: unknown): VerifiedEnvelope {
  try {
    const event = parseLeadSubmittedEventV1(value);
    const envelopeJson = canonicalJson(event);
    if (Buffer.byteLength(envelopeJson, 'utf8') > MAX_LEAD_EVENT_BYTES) {
      fail('BUSINESS_INBOX_EVENT_INVALID');
    }
    return { event, envelopeJson };
  } catch (error) {
    if (error instanceof BusinessEventBackboneError) throw error;
    if (error instanceof LeadEventContractError && error.code === 'LEAD_EVENT_HASH_INVALID') {
      fail('BUSINESS_INBOX_HASH_INVALID');
    }
    fail('BUSINESS_INBOX_EVENT_INVALID');
  }
}

function immutableContractHashInput(
  id: string,
  verified: VerifiedEnvelope,
  createdAt: Date,
) {
  const { event, envelopeJson } = verified;
  return {
    id,
    schemaVersion: event.schemaVersion,
    eventType: event.eventType,
    eventVersion: event.eventVersion,
    canonicalizationVersion: event.idempotency.canonicalizationVersion,
    eventId: event.eventId,
    businessCorrelationId: event.businessCorrelationId,
    occurredAt: event.occurredAt,
    keyDigest: event.idempotency.keyDigest,
    payloadHash: event.idempotency.payloadHash,
    envelopeJson,
    classificationCatalogVersion: BUSINESS_EVENT_BACKBONE_MANIFEST.classificationCatalogVersion,
    classificationContractCode: BUSINESS_EVENT_BACKBONE_MANIFEST.classificationContractCode,
    maxAttempts: BUSINESS_EVENT_BACKBONE_MANIFEST.maxAttempts,
    retentionClass: BUSINESS_EVENT_BACKBONE_MANIFEST.retentionClass,
    retentionPolicyVersion: BUSINESS_EVENT_BACKBONE_MANIFEST.retentionPolicyVersion,
    retentionEligibleAt: null,
    createdAt: createdAt.toISOString(),
  };
}

export function calculateBusinessInboxRecordHash(
  id: string,
  event: unknown,
  createdAt: Date,
) {
  const verified = parseEnvelope(event);
  return sha256(
    `${BUSINESS_EVENT_BACKBONE_MANIFEST.hashDomains.inboxRecord}\n${canonicalJson(
      immutableContractHashInput(normalizeUuid(id), verified, createdAt),
    )}`,
  );
}

function calculateInboxHashFromVerified(
  id: string,
  verified: VerifiedEnvelope,
  createdAt: Date,
) {
  return sha256(
    `${BUSINESS_EVENT_BACKBONE_MANIFEST.hashDomains.inboxRecord}\n${canonicalJson(
      immutableContractHashInput(id, verified, createdAt),
    )}`,
  );
}

export function calculateBusinessOutboxRecordHash(input: {
  readonly id: string;
  readonly sourceInboxEventId: string;
  readonly producerCode: string;
  readonly destinationCode: string;
  readonly event: unknown;
  readonly createdAt: Date;
}) {
  const verified = parseEnvelope(input.event);
  return calculateOutboxHashFromVerified({
    id: normalizeUuid(input.id),
    sourceInboxEventId: normalizeUuid(input.sourceInboxEventId),
    producerCode: normalizeBusinessQueueCode(input.producerCode),
    destinationCode: normalizeBusinessQueueCode(input.destinationCode),
    verified,
    createdAt: input.createdAt,
  });
}

function calculateOutboxHashFromVerified(input: {
  readonly id: string;
  readonly sourceInboxEventId: string;
  readonly producerCode: string;
  readonly destinationCode: string;
  readonly verified: VerifiedEnvelope;
  readonly createdAt: Date;
}) {
  return sha256(
    `${BUSINESS_EVENT_BACKBONE_MANIFEST.hashDomains.outboxRecord}\n${canonicalJson({
      sourceInboxEventId: input.sourceInboxEventId,
      producerCode: input.producerCode,
      destinationCode: input.destinationCode,
      ...immutableContractHashInput(input.id, input.verified, input.createdAt),
    })}`,
  );
}

export function createBusinessQueueLeaseToken() {
  return randomBytes(32).toString('hex');
}

export function hashBusinessQueueLeaseToken(rawToken: unknown) {
  if (typeof rawToken !== 'string' || !RAW_LEASE_TOKEN_PATTERN.test(rawToken)) {
    fail('BUSINESS_QUEUE_LEASE_STALE');
  }
  return sha256(
    `${BUSINESS_EVENT_BACKBONE_MANIFEST.hashDomains.leaseToken}\n${rawToken}`,
  );
}

export function getBusinessQueueRetryDelaySeconds(attemptCount: number) {
  if (!Number.isInteger(attemptCount) || attemptCount < 1 || attemptCount >= 5) {
    fail('BUSINESS_QUEUE_RETRY_EXHAUSTED');
  }
  return BUSINESS_EVENT_BACKBONE_MANIFEST.retryDelaysSeconds[attemptCount - 1];
}

export function calculateBusinessQueueAttemptHash(input: {
  readonly attemptId: string;
  readonly queueKind: BusinessQueueKind;
  readonly eventRowId: string;
  readonly attemptSequence: number;
  readonly fencingToken: bigint;
  readonly leaseOwnerId: string;
  readonly leaseTokenHash: string;
  readonly claimedAt: Date;
  readonly leaseExpiresAt: Date;
  readonly leaseMaxExpiresAt: Date;
}) {
  return sha256(
    `${BUSINESS_EVENT_BACKBONE_MANIFEST.hashDomains.attempt}\n${canonicalJson({
      attemptId: normalizeUuid(input.attemptId),
      queueKind: input.queueKind,
      eventRowId: normalizeUuid(input.eventRowId),
      attemptSequence: input.attemptSequence,
      fencingToken: input.fencingToken.toString(),
      leaseOwnerId: normalizeUuid(input.leaseOwnerId),
      leaseTokenHash: input.leaseTokenHash,
      claimedAt: input.claimedAt.toISOString(),
      leaseExpiresAt: input.leaseExpiresAt.toISOString(),
      leaseMaxExpiresAt: input.leaseMaxExpiresAt.toISOString(),
    })}`,
  );
}

export function calculateBusinessQueueCompletionHash(input: {
  readonly attemptHash: string;
  readonly finishedAt: Date;
  readonly outcome: BusinessQueueOutcome;
  readonly failureCode: string | null;
  readonly retryable: boolean | null;
  readonly nextAvailableAt: Date | null;
}) {
  if (!SHA256_PATTERN.test(input.attemptHash)) fail('BUSINESS_QUEUE_INTEGRITY_FAILURE');
  return sha256(
    `${BUSINESS_EVENT_BACKBONE_MANIFEST.hashDomains.completion}\n${canonicalJson({
      attemptHash: input.attemptHash,
      finishedAt: input.finishedAt.toISOString(),
      outcome: input.outcome,
      failureCode: input.failureCode,
      retryable: input.retryable,
      nextAvailableAt: input.nextAvailableAt?.toISOString() ?? null,
    })}`,
  );
}

export function isBusinessQueueTransitionAllowed(
  queueKind: BusinessQueueKind,
  from: string,
  to: string,
) {
  if (from === 'AVAILABLE' && to === 'LEASED') return true;
  if (from !== 'LEASED') return false;
  if (to === 'LEASED' || to === 'AVAILABLE' || to === 'DEAD_LETTER') return true;
  return queueKind === 'INBOX' ? to === 'PROCESSED' : to === 'PUBLISHED';
}

export function compareBusinessInboxIdentity(input: {
  readonly stored: null | {
    readonly keyDigest: string;
    readonly eventId: string;
    readonly payloadHash: string;
    readonly envelopeJson: string;
  };
  readonly candidate: unknown;
}): BusinessIdempotencyOutcome {
  const verified = parseEnvelope(input.candidate);
  if (!input.stored) return 'NEW';
  if (
    input.stored.keyDigest !== verified.event.idempotency.keyDigest
    && input.stored.eventId !== verified.event.eventId
  ) return 'NEW';
  return input.stored.keyDigest === verified.event.idempotency.keyDigest
    && input.stored.eventId === verified.event.eventId
    && input.stored.payloadHash === verified.event.idempotency.payloadHash
    && input.stored.envelopeJson === verified.envelopeJson
    ? 'REPLAY'
    : 'CONFLICT';
}

function rowEnvelope(row: ContractRow) {
  let raw: unknown;
  try {
    raw = JSON.parse(row.envelopeJson) as unknown;
  } catch {
    fail('BUSINESS_QUEUE_INTEGRITY_FAILURE');
  }
  let verified: VerifiedEnvelope;
  try {
    verified = parseEnvelope(raw);
  } catch {
    fail('BUSINESS_QUEUE_INTEGRITY_FAILURE');
  }
  const { event } = verified;
  if (
    verified.envelopeJson !== row.envelopeJson
    || row.schemaVersion !== event.schemaVersion
    || row.eventType !== event.eventType
    || row.eventVersion !== event.eventVersion
    || row.canonicalizationVersion !== event.idempotency.canonicalizationVersion
    || row.eventId !== event.eventId
    || row.businessCorrelationId !== event.businessCorrelationId
    || row.occurredAt !== event.occurredAt
    || row.keyDigest !== event.idempotency.keyDigest
    || row.payloadHash !== event.idempotency.payloadHash
    || row.classificationCatalogVersion
      !== BUSINESS_EVENT_BACKBONE_MANIFEST.classificationCatalogVersion
    || row.classificationContractCode
      !== BUSINESS_EVENT_BACKBONE_MANIFEST.classificationContractCode
    || row.maxAttempts !== BUSINESS_EVENT_BACKBONE_MANIFEST.maxAttempts
    || row.retentionClass !== BUSINESS_EVENT_BACKBONE_MANIFEST.retentionClass
    || row.retentionPolicyVersion !== BUSINESS_EVENT_BACKBONE_MANIFEST.retentionPolicyVersion
    || row.retentionEligibleAt !== null
  ) fail('BUSINESS_QUEUE_INTEGRITY_FAILURE');
  return verified;
}

function verifyInboxRow(row: InboxRow) {
  const verified = rowEnvelope(row);
  if (row.recordHash !== calculateInboxHashFromVerified(row.id, verified, row.createdAt)) {
    fail('BUSINESS_QUEUE_INTEGRITY_FAILURE');
  }
  return verified;
}

function verifyOutboxRow(row: OutboxRow) {
  const verified = rowEnvelope(row);
  const expected = calculateOutboxHashFromVerified({
    id: row.id,
    sourceInboxEventId: row.sourceInboxEventId,
    producerCode: row.producerCode,
    destinationCode: row.destinationCode,
    verified,
    createdAt: row.createdAt,
  });
  if (row.recordHash !== expected) fail('BUSINESS_QUEUE_INTEGRITY_FAILURE');
  return verified;
}

function retryableDatabaseCode(error: unknown) {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') return true;
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; meta?: { code?: unknown } };
  return (typeof candidate.code === 'string' && RETRYABLE_SQL_STATES.has(candidate.code))
    || (typeof candidate.meta?.code === 'string'
      && RETRYABLE_SQL_STATES.has(candidate.meta.code));
}

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function withBusinessTransaction<T>(
  prisma: PrismaClient,
  operation: (tx: Tx) => Promise<T>,
) {
  for (let attempt = 0; attempt < BUSINESS_EVENT_BACKBONE_MANIFEST.transactionAttempts; attempt++) {
    try {
      return await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '1000ms'");
        await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '4000ms'");
        return operation(tx);
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: BUSINESS_EVENT_BACKBONE_MANIFEST.transactionMaxWaitMs,
        timeout: BUSINESS_EVENT_BACKBONE_MANIFEST.transactionTimeoutMs,
      });
    } catch (error) {
      if (error instanceof BusinessEventBackboneError) throw error;
      if (!retryableDatabaseCode(error)) fail('BUSINESS_QUEUE_INTERNAL_FAILURE');
      if (attempt >= BUSINESS_EVENT_BACKBONE_MANIFEST.transactionAttempts - 1) {
        fail('BUSINESS_QUEUE_DATABASE_CONFLICT');
      }
      await wait(RETRY_DELAYS_MS[attempt]);
    }
  }
  return fail('BUSINESS_QUEUE_DATABASE_CONFLICT');
}

async function databaseNow(tx: Tx) {
  const rows = await tx.$queryRaw<Array<{ now: Date }>>(Prisma.sql`
    SELECT DATE_TRUNC('milliseconds', clock_timestamp()) AS "now"
  `);
  const now = rows[0]?.now;
  if (!now) fail('BUSINESS_QUEUE_INTERNAL_FAILURE');
  return now;
}

export async function admitBusinessInboxEvent(
  prisma: PrismaClient,
  input: unknown,
): Promise<BusinessInboxAdmissionResult> {
  const verified = parseEnvelope(input);
  return withBusinessTransaction(prisma, async (tx) => {
    const id = randomUUID();
    const createdAt = await databaseNow(tx);
    const recordHash = calculateInboxHashFromVerified(id, verified, createdAt);
    const { event, envelopeJson } = verified;
    const inserted = await tx.$queryRaw<InboxRow[]>(Prisma.sql`
      INSERT INTO "BusinessInboxEvent" (
        "id", "schemaVersion", "eventType", "eventVersion", "canonicalizationVersion",
        "eventId", "businessCorrelationId", "occurredAt", "keyDigest", "payloadHash",
        "envelopeJson", "recordHash", "classificationCatalogVersion",
        "classificationContractCode", "state", "availableAt", "attemptCount", "maxAttempts",
        "fencingToken", "retentionClass", "retentionPolicyVersion", "createdAt", "updatedAt"
      ) VALUES (
        ${id}::UUID, ${event.schemaVersion}, ${event.eventType}, ${event.eventVersion},
        ${event.idempotency.canonicalizationVersion}, ${event.eventId}::UUID,
        ${event.businessCorrelationId}::UUID, ${event.occurredAt},
        ${event.idempotency.keyDigest}, ${event.idempotency.payloadHash}, ${envelopeJson},
        ${recordHash}, ${BUSINESS_EVENT_BACKBONE_MANIFEST.classificationCatalogVersion},
        ${BUSINESS_EVENT_BACKBONE_MANIFEST.classificationContractCode}, 'AVAILABLE',
        ${createdAt}, 0, ${BUSINESS_EVENT_BACKBONE_MANIFEST.maxAttempts}, 0,
        ${BUSINESS_EVENT_BACKBONE_MANIFEST.retentionClass},
        ${BUSINESS_EVENT_BACKBONE_MANIFEST.retentionPolicyVersion}, ${createdAt}, ${createdAt}
      )
      ON CONFLICT DO NOTHING
      RETURNING *
    `);
    if (inserted[0]) {
      verifyInboxRow(inserted[0]);
      return { outcome: 'NEW', inboxEventId: inserted[0].id };
    }
    const existing = await tx.$queryRaw<InboxRow[]>(Prisma.sql`
      SELECT * FROM "BusinessInboxEvent"
      WHERE "keyDigest" = ${event.idempotency.keyDigest}
         OR "eventId" = ${event.eventId}::UUID
      ORDER BY "createdAt", "id"
      FOR KEY SHARE
    `);
    for (const row of existing) verifyInboxRow(row);
    if (
      existing.length === 1
      && compareBusinessInboxIdentity({ stored: existing[0], candidate: event }) === 'REPLAY'
    ) return { outcome: 'REPLAY', inboxEventId: existing[0].id };
    fail('BUSINESS_INBOX_IDEMPOTENCY_CONFLICT');
  });
}

export async function enqueueBusinessOutboxEvent(
  tx: Tx,
  input: {
    readonly sourceInboxEventId: string;
    readonly producerCode: string;
    readonly destinationCode: string;
  },
): Promise<BusinessOutboxEnqueueResult> {
  const sourceInboxEventId = normalizeUuid(input.sourceInboxEventId);
  const producerCode = normalizeBusinessQueueCode(input.producerCode);
  const destinationCode = normalizeBusinessQueueCode(input.destinationCode);
  const parents = await tx.$queryRaw<InboxRow[]>(Prisma.sql`
    SELECT * FROM "BusinessInboxEvent"
    WHERE "id" = ${sourceInboxEventId}::UUID
    FOR KEY SHARE
  `);
  const parent = parents[0];
  if (!parent) fail('BUSINESS_OUTBOX_SOURCE_INVALID');
  let verified: VerifiedEnvelope;
  try {
    verified = verifyInboxRow(parent);
  } catch {
    fail('BUSINESS_OUTBOX_SOURCE_INVALID');
  }
  const id = randomUUID();
  const createdAt = await databaseNow(tx);
  const recordHash = calculateOutboxHashFromVerified({
    id,
    sourceInboxEventId,
    producerCode,
    destinationCode,
    verified,
    createdAt,
  });
  const { event, envelopeJson } = verified;
  const inserted = await tx.$queryRaw<OutboxRow[]>(Prisma.sql`
    INSERT INTO "BusinessOutboxEvent" (
      "id", "sourceInboxEventId", "producerCode", "destinationCode", "schemaVersion",
      "eventType", "eventVersion", "canonicalizationVersion", "eventId",
      "businessCorrelationId", "occurredAt", "keyDigest", "payloadHash", "envelopeJson",
      "recordHash", "classificationCatalogVersion", "classificationContractCode", "state",
      "availableAt", "attemptCount", "maxAttempts", "fencingToken", "retentionClass",
      "retentionPolicyVersion", "createdAt", "updatedAt"
    ) VALUES (
      ${id}::UUID, ${sourceInboxEventId}::UUID, ${producerCode}, ${destinationCode},
      ${event.schemaVersion}, ${event.eventType}, ${event.eventVersion},
      ${event.idempotency.canonicalizationVersion}, ${event.eventId}::UUID,
      ${event.businessCorrelationId}::UUID, ${event.occurredAt},
      ${event.idempotency.keyDigest}, ${event.idempotency.payloadHash}, ${envelopeJson},
      ${recordHash}, ${BUSINESS_EVENT_BACKBONE_MANIFEST.classificationCatalogVersion},
      ${BUSINESS_EVENT_BACKBONE_MANIFEST.classificationContractCode}, 'AVAILABLE', ${createdAt},
      0, ${BUSINESS_EVENT_BACKBONE_MANIFEST.maxAttempts}, 0,
      ${BUSINESS_EVENT_BACKBONE_MANIFEST.retentionClass},
      ${BUSINESS_EVENT_BACKBONE_MANIFEST.retentionPolicyVersion}, ${createdAt}, ${createdAt}
    )
    ON CONFLICT DO NOTHING
    RETURNING *
  `);
  if (inserted[0]) {
    verifyOutboxRow(inserted[0]);
    return { outcome: 'NEW', outboxEventId: inserted[0].id };
  }
  const existing = await tx.$queryRaw<OutboxRow[]>(Prisma.sql`
    SELECT * FROM "BusinessOutboxEvent"
    WHERE "producerCode" = ${producerCode}
      AND "destinationCode" = ${destinationCode}
      AND "keyDigest" = ${event.idempotency.keyDigest}
    FOR KEY SHARE
  `);
  const row = existing[0];
  if (!row) fail('BUSINESS_OUTBOX_IDEMPOTENCY_CONFLICT');
  verifyOutboxRow(row);
  if (
    row.sourceInboxEventId !== sourceInboxEventId
    || row.payloadHash !== event.idempotency.payloadHash
    || row.eventId !== event.eventId
    || row.envelopeJson !== envelopeJson
  ) fail('BUSINESS_OUTBOX_IDEMPOTENCY_CONFLICT');
  return { outcome: 'REPLAY', outboxEventId: row.id };
}

async function selectClaimCandidate(tx: Tx, queueKind: BusinessQueueKind) {
  if (queueKind === 'INBOX') {
    return (await tx.$queryRaw<InboxRow[]>(Prisma.sql`
      SELECT * FROM "BusinessInboxEvent"
      WHERE "state" = 'AVAILABLE' AND "availableAt" <= clock_timestamp()
      ORDER BY "availableAt", "id"
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `))[0] ?? null;
  }
  return (await tx.$queryRaw<OutboxRow[]>(Prisma.sql`
    SELECT * FROM "BusinessOutboxEvent"
    WHERE "state" = 'AVAILABLE' AND "availableAt" <= clock_timestamp()
    ORDER BY "availableAt", "id"
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  `))[0] ?? null;
}

async function updateClaimedQueue(
  tx: Tx,
  queueKind: BusinessQueueKind,
  row: ContractRow,
  leaseOwnerId: string,
  leaseTokenHash: string,
  claimedAt: Date,
  leaseExpiresAt: Date,
  leaseMaxExpiresAt: Date,
) {
  const values = Prisma.sql`
    "state" = 'LEASED',
    "attemptCount" = "attemptCount" + 1,
    "fencingToken" = "fencingToken" + 1,
    "leaseOwnerId" = ${leaseOwnerId}::UUID,
    "leaseTokenHash" = ${leaseTokenHash},
    "leaseClaimedAt" = ${claimedAt},
    "leaseExpiresAt" = ${leaseExpiresAt},
    "leaseMaxExpiresAt" = ${leaseMaxExpiresAt}
  `;
  if (queueKind === 'INBOX') {
    return (await tx.$queryRaw<InboxRow[]>(Prisma.sql`
      UPDATE "BusinessInboxEvent" SET ${values}
      WHERE "id" = ${row.id}::UUID AND "state" = 'AVAILABLE'
      RETURNING *
    `))[0] ?? null;
  }
  return (await tx.$queryRaw<OutboxRow[]>(Prisma.sql`
    UPDATE "BusinessOutboxEvent" SET ${values}
    WHERE "id" = ${row.id}::UUID AND "state" = 'AVAILABLE'
    RETURNING *
  `))[0] ?? null;
}

export async function claimBusinessQueueEvent(
  prisma: PrismaClient,
  input: { readonly queueKind: BusinessQueueKind; readonly leaseOwnerId: string },
): Promise<BusinessQueueLease | null> {
  const queueKind = input.queueKind;
  if (queueKind !== 'INBOX' && queueKind !== 'OUTBOX') {
    fail('BUSINESS_QUEUE_STATE_CONFLICT');
  }
  const leaseOwnerId = normalizeUuid(input.leaseOwnerId);
  return withBusinessTransaction(prisma, async (tx) => {
    const row = await selectClaimCandidate(tx, queueKind);
    if (!row) return null;
    const verified = queueKind === 'INBOX'
      ? verifyInboxRow(row as InboxRow)
      : verifyOutboxRow(row as OutboxRow);
    if (row.attemptCount >= row.maxAttempts) fail('BUSINESS_QUEUE_RETRY_EXHAUSTED');
    const claimedAt = await databaseNow(tx);
    const leaseExpiresAt = new Date(
      claimedAt.getTime() + BUSINESS_EVENT_BACKBONE_MANIFEST.initialLeaseSeconds * 1_000,
    );
    const leaseMaxExpiresAt = new Date(
      claimedAt.getTime() + BUSINESS_EVENT_BACKBONE_MANIFEST.maximumLeaseSeconds * 1_000,
    );
    const leaseToken = createBusinessQueueLeaseToken();
    const leaseTokenHash = hashBusinessQueueLeaseToken(leaseToken);
    const attemptId = randomUUID();
    const attemptSequence = row.attemptCount + 1;
    const fencingToken = row.fencingToken + 1n;
    const attemptHash = calculateBusinessQueueAttemptHash({
      attemptId,
      queueKind,
      eventRowId: row.id,
      attemptSequence,
      fencingToken,
      leaseOwnerId,
      leaseTokenHash,
      claimedAt,
      leaseExpiresAt,
      leaseMaxExpiresAt,
    });
    const claimed = await updateClaimedQueue(
      tx,
      queueKind,
      row,
      leaseOwnerId,
      leaseTokenHash,
      claimedAt,
      leaseExpiresAt,
      leaseMaxExpiresAt,
    );
    if (!claimed) fail('BUSINESS_QUEUE_STATE_CONFLICT');
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "BusinessQueueAttempt" (
        "id", "queueKind", "inboxEventId", "outboxEventId", "attemptSequence",
        "fencingToken", "leaseOwnerId", "leaseTokenHash", "claimedAt", "leaseExpiresAt",
        "leaseMaxExpiresAt", "attemptHash", "createdAt"
      ) VALUES (
        ${attemptId}::UUID, ${queueKind},
        ${queueKind === 'INBOX' ? row.id : null}::UUID,
        ${queueKind === 'OUTBOX' ? row.id : null}::UUID,
        ${attemptSequence}, ${fencingToken}, ${leaseOwnerId}::UUID, ${leaseTokenHash},
        ${claimedAt}, ${leaseExpiresAt}, ${leaseMaxExpiresAt}, ${attemptHash}, ${claimedAt}
      )
    `);
    return {
      queueKind,
      eventRowId: row.id,
      attemptId,
      attemptSequence,
      fencingToken,
      leaseOwnerId,
      leaseToken,
      leaseExpiresAt,
      leaseMaxExpiresAt,
      envelope: verified.event,
    };
  });
}

async function lockedQueueRow(tx: Tx, identity: BusinessQueueLeaseIdentity) {
  if (identity.queueKind === 'INBOX') {
    return (await tx.$queryRaw<InboxRow[]>(Prisma.sql`
      SELECT * FROM "BusinessInboxEvent"
      WHERE "id" = ${identity.eventRowId}::UUID
      FOR UPDATE
    `))[0] ?? null;
  }
  return (await tx.$queryRaw<OutboxRow[]>(Prisma.sql`
    SELECT * FROM "BusinessOutboxEvent"
    WHERE "id" = ${identity.eventRowId}::UUID
    FOR UPDATE
  `))[0] ?? null;
}

function normalizeLeaseIdentity(input: BusinessQueueLeaseIdentity) {
  if (input.queueKind !== 'INBOX' && input.queueKind !== 'OUTBOX') {
    fail('BUSINESS_QUEUE_LEASE_STALE');
  }
  return {
    queueKind: input.queueKind,
    eventRowId: normalizeUuid(input.eventRowId),
    attemptId: normalizeUuid(input.attemptId),
    fencingToken: input.fencingToken,
    leaseOwnerId: normalizeUuid(input.leaseOwnerId),
    leaseTokenHash: hashBusinessQueueLeaseToken(input.leaseToken),
  };
}

function verifyOpenAttemptForQueueRow(
  queueKind: BusinessQueueKind,
  row: ContractRow,
  attempt: AttemptRow,
) {
  const targetsMatch = queueKind === 'INBOX'
    ? attempt.inboxEventId === row.id && attempt.outboxEventId === null
    : attempt.outboxEventId === row.id && attempt.inboxEventId === null;
  if (
    row.state !== 'LEASED'
    || attempt.queueKind !== queueKind
    || !targetsMatch
    || attempt.attemptSequence !== row.attemptCount
    || attempt.fencingToken !== row.fencingToken
    || attempt.leaseOwnerId !== row.leaseOwnerId
    || attempt.leaseTokenHash !== row.leaseTokenHash
    || row.leaseClaimedAt === null
    || row.leaseExpiresAt === null
    || row.leaseMaxExpiresAt === null
    || attempt.claimedAt.getTime() !== row.leaseClaimedAt.getTime()
    || attempt.leaseExpiresAt.getTime() > row.leaseExpiresAt.getTime()
    || attempt.leaseMaxExpiresAt.getTime() !== row.leaseMaxExpiresAt.getTime()
    || row.leaseExpiresAt.getTime() > row.leaseMaxExpiresAt.getTime()
    || attempt.createdAt.getTime() !== attempt.claimedAt.getTime()
    || attempt.finishedAt !== null
    || attempt.outcome !== null
    || attempt.failureCode !== null
    || attempt.retryable !== null
    || attempt.nextAvailableAt !== null
    || attempt.completionHash !== null
  ) fail('BUSINESS_QUEUE_INTEGRITY_FAILURE');
  let expectedAttemptHash: string;
  try {
    expectedAttemptHash = calculateBusinessQueueAttemptHash({
      attemptId: attempt.id,
      queueKind,
      eventRowId: row.id,
      attemptSequence: attempt.attemptSequence,
      fencingToken: attempt.fencingToken,
      leaseOwnerId: attempt.leaseOwnerId,
      leaseTokenHash: attempt.leaseTokenHash,
      claimedAt: attempt.claimedAt,
      leaseExpiresAt: attempt.leaseExpiresAt,
      leaseMaxExpiresAt: attempt.leaseMaxExpiresAt,
    });
  } catch {
    fail('BUSINESS_QUEUE_INTEGRITY_FAILURE');
  }
  if (attempt.attemptHash !== expectedAttemptHash) {
    fail('BUSINESS_QUEUE_INTEGRITY_FAILURE');
  }
}

async function assertCurrentLease(
  tx: Tx,
  input: BusinessQueueLeaseIdentity,
) {
  const identity = normalizeLeaseIdentity(input);
  const row = await lockedQueueRow(tx, input);
  if (!row) fail('BUSINESS_QUEUE_LEASE_STALE');
  if (identity.queueKind === 'INBOX') verifyInboxRow(row as InboxRow);
  else verifyOutboxRow(row as OutboxRow);
  const now = await databaseNow(tx);
  if (
    row.state !== 'LEASED'
    || row.fencingToken !== identity.fencingToken
    || row.leaseOwnerId !== identity.leaseOwnerId
    || row.leaseTokenHash !== identity.leaseTokenHash
    || !row.leaseExpiresAt
    || row.leaseExpiresAt.getTime() <= now.getTime()
  ) fail('BUSINESS_QUEUE_LEASE_STALE');
  const attempts = await tx.$queryRaw<AttemptRow[]>(Prisma.sql`
    SELECT * FROM "BusinessQueueAttempt"
    WHERE "id" = ${identity.attemptId}::UUID
      AND "queueKind" = ${identity.queueKind}
      AND "finishedAt" IS NULL
      AND ("inboxEventId" = ${identity.queueKind === 'INBOX' ? row.id : null}::UUID
        OR "outboxEventId" = ${identity.queueKind === 'OUTBOX' ? row.id : null}::UUID)
    FOR UPDATE
  `);
  const attempt = attempts[0];
  if (
    !attempt
    || attempt.fencingToken !== identity.fencingToken
    || attempt.leaseOwnerId !== identity.leaseOwnerId
    || attempt.leaseTokenHash !== identity.leaseTokenHash
  ) fail('BUSINESS_QUEUE_LEASE_STALE');
  verifyOpenAttemptForQueueRow(identity.queueKind, row, attempt);
  return { identity, row, attempt, now };
}

export async function heartbeatBusinessQueueLease(
  prisma: PrismaClient,
  input: BusinessQueueLeaseIdentity,
) {
  return withBusinessTransaction(prisma, async (tx) => {
    const { identity, row } = await assertCurrentLease(tx, input);
    if (!row.leaseExpiresAt || !row.leaseMaxExpiresAt) fail('BUSINESS_QUEUE_LEASE_STALE');
    const leaseExpiresAt = new Date(Math.min(
      row.leaseExpiresAt.getTime()
        + BUSINESS_EVENT_BACKBONE_MANIFEST.initialLeaseSeconds * 1_000,
      row.leaseMaxExpiresAt.getTime(),
    ));
    if (leaseExpiresAt.getTime() <= row.leaseExpiresAt.getTime()) {
      fail('BUSINESS_QUEUE_STATE_CONFLICT');
    }
    const query = identity.queueKind === 'INBOX'
      ? Prisma.sql`UPDATE "BusinessInboxEvent" SET "leaseExpiresAt" = ${leaseExpiresAt}
          WHERE "id" = ${row.id}::UUID AND "state" = 'LEASED'
          AND "fencingToken" = ${identity.fencingToken}
          AND "leaseOwnerId" = ${identity.leaseOwnerId}::UUID
          AND "leaseTokenHash" = ${identity.leaseTokenHash} RETURNING "leaseExpiresAt"`
      : Prisma.sql`UPDATE "BusinessOutboxEvent" SET "leaseExpiresAt" = ${leaseExpiresAt}
          WHERE "id" = ${row.id}::UUID AND "state" = 'LEASED'
          AND "fencingToken" = ${identity.fencingToken}
          AND "leaseOwnerId" = ${identity.leaseOwnerId}::UUID
          AND "leaseTokenHash" = ${identity.leaseTokenHash} RETURNING "leaseExpiresAt"`;
    const updated = await tx.$queryRaw<Array<{ leaseExpiresAt: Date }>>(query);
    if (!updated[0]) fail('BUSINESS_QUEUE_LEASE_STALE');
    return Object.freeze({ leaseExpiresAt: updated[0].leaseExpiresAt });
  });
}

async function closeAttempt(
  tx: Tx,
  attempt: AttemptRow,
  finishedAt: Date,
  outcome: BusinessQueueOutcome,
  failureCode: string | null,
  retryable: boolean | null,
  nextAvailableAt: Date | null,
) {
  const completionHash = calculateBusinessQueueCompletionHash({
    attemptHash: attempt.attemptHash,
    finishedAt,
    outcome,
    failureCode,
    retryable,
    nextAvailableAt,
  });
  const updated = await tx.$executeRaw(Prisma.sql`
    UPDATE "BusinessQueueAttempt"
    SET "finishedAt" = ${finishedAt}, "outcome" = ${outcome}, "failureCode" = ${failureCode},
        "retryable" = ${retryable}, "nextAvailableAt" = ${nextAvailableAt},
        "completionHash" = ${completionHash}
    WHERE "id" = ${attempt.id}::UUID AND "finishedAt" IS NULL
  `);
  if (updated !== 1) fail('BUSINESS_QUEUE_LEASE_STALE');
  return completionHash;
}

export async function completeBusinessQueueEvent(
  prisma: PrismaClient,
  input: BusinessQueueLeaseIdentity,
) {
  return withBusinessTransaction(prisma, async (tx) => {
    const { identity, row, attempt, now } = await assertCurrentLease(tx, input);
    const terminalState = identity.queueKind === 'INBOX' ? 'PROCESSED' : 'PUBLISHED';
    const query = identity.queueKind === 'INBOX'
      ? Prisma.sql`UPDATE "BusinessInboxEvent" SET "state" = 'PROCESSED', "terminalAt" = ${now},
          "leaseOwnerId" = NULL, "leaseTokenHash" = NULL, "leaseClaimedAt" = NULL,
          "leaseExpiresAt" = NULL, "leaseMaxExpiresAt" = NULL
          WHERE "id" = ${row.id}::UUID AND "state" = 'LEASED'`
      : Prisma.sql`UPDATE "BusinessOutboxEvent" SET "state" = 'PUBLISHED', "terminalAt" = ${now},
          "leaseOwnerId" = NULL, "leaseTokenHash" = NULL, "leaseClaimedAt" = NULL,
          "leaseExpiresAt" = NULL, "leaseMaxExpiresAt" = NULL
          WHERE "id" = ${row.id}::UUID AND "state" = 'LEASED'`;
    if (await tx.$executeRaw(query) !== 1) fail('BUSINESS_QUEUE_LEASE_STALE');
    const completionHash = await closeAttempt(
      tx,
      attempt,
      now,
      terminalState,
      null,
      null,
      null,
    );
    return Object.freeze({ state: terminalState, completionHash });
  });
}

export async function failBusinessQueueEvent(
  prisma: PrismaClient,
  input: BusinessQueueLeaseIdentity & {
    readonly failureCode: string;
    readonly retryable: boolean;
  },
) {
  const failureCode = normalizeBusinessQueueFailureCode(input.failureCode);
  return withBusinessTransaction(prisma, async (tx) => {
    const { identity, row, attempt, now } = await assertCurrentLease(tx, input);
    const retry = input.retryable && row.attemptCount < row.maxAttempts;
    const nextAvailableAt = retry
      ? new Date(now.getTime() + getBusinessQueueRetryDelaySeconds(row.attemptCount) * 1_000)
      : null;
    const nextState = retry ? 'AVAILABLE' : 'DEAD_LETTER';
    const query = identity.queueKind === 'INBOX'
      ? Prisma.sql`UPDATE "BusinessInboxEvent" SET "state" = ${nextState},
          "availableAt" = ${nextAvailableAt ?? row.availableAt}, "lastFailureCode" = ${failureCode},
          "terminalAt" = ${retry ? null : now}, "terminalReasonCode" = ${retry ? null : failureCode},
          "leaseOwnerId" = NULL, "leaseTokenHash" = NULL, "leaseClaimedAt" = NULL,
          "leaseExpiresAt" = NULL, "leaseMaxExpiresAt" = NULL
          WHERE "id" = ${row.id}::UUID AND "state" = 'LEASED'`
      : Prisma.sql`UPDATE "BusinessOutboxEvent" SET "state" = ${nextState},
          "availableAt" = ${nextAvailableAt ?? row.availableAt}, "lastFailureCode" = ${failureCode},
          "terminalAt" = ${retry ? null : now}, "terminalReasonCode" = ${retry ? null : failureCode},
          "leaseOwnerId" = NULL, "leaseTokenHash" = NULL, "leaseClaimedAt" = NULL,
          "leaseExpiresAt" = NULL, "leaseMaxExpiresAt" = NULL
          WHERE "id" = ${row.id}::UUID AND "state" = 'LEASED'`;
    if (await tx.$executeRaw(query) !== 1) fail('BUSINESS_QUEUE_LEASE_STALE');
    const outcome = retry ? 'RETRY_SCHEDULED' : 'DEAD_LETTER';
    const completionHash = await closeAttempt(
      tx,
      attempt,
      now,
      outcome,
      failureCode,
      input.retryable,
      nextAvailableAt,
    );
    return Object.freeze({ state: nextState, nextAvailableAt, completionHash });
  });
}

async function selectExpiredRows(
  tx: Tx,
  queueKind: BusinessQueueKind,
  maximumRows: number,
) {
  if (queueKind === 'INBOX') {
    return tx.$queryRaw<InboxRow[]>(Prisma.sql`
      SELECT * FROM "BusinessInboxEvent"
      WHERE "state" = 'LEASED' AND "leaseExpiresAt" <= clock_timestamp()
      ORDER BY "leaseExpiresAt", "id"
      LIMIT ${maximumRows}
      FOR UPDATE SKIP LOCKED
    `);
  }
  return tx.$queryRaw<OutboxRow[]>(Prisma.sql`
    SELECT * FROM "BusinessOutboxEvent"
    WHERE "state" = 'LEASED' AND "leaseExpiresAt" <= clock_timestamp()
    ORDER BY "leaseExpiresAt", "id"
    LIMIT ${maximumRows}
    FOR UPDATE SKIP LOCKED
  `);
}

export async function recoverExpiredBusinessQueueLeases(
  prisma: PrismaClient,
  input: { readonly queueKind: BusinessQueueKind; readonly maximumRows?: number },
) {
  if (input.queueKind !== 'INBOX' && input.queueKind !== 'OUTBOX') {
    fail('BUSINESS_QUEUE_STATE_CONFLICT');
  }
  const maximumRows = input.maximumRows
    ?? BUSINESS_EVENT_BACKBONE_MANIFEST.maximumRecoveryBatch;
  if (!Number.isInteger(maximumRows) || maximumRows < 1
    || maximumRows > BUSINESS_EVENT_BACKBONE_MANIFEST.maximumRecoveryBatch) {
    fail('BUSINESS_QUEUE_STATE_CONFLICT');
  }
  return withBusinessTransaction(prisma, async (tx) => {
    const rows = await selectExpiredRows(tx, input.queueKind, maximumRows);
    let retried = 0;
    let deadLettered = 0;
    for (const row of rows) {
      if (input.queueKind === 'INBOX') verifyInboxRow(row as InboxRow);
      else verifyOutboxRow(row as OutboxRow);
      const attempts = await tx.$queryRaw<AttemptRow[]>(Prisma.sql`
        SELECT * FROM "BusinessQueueAttempt"
        WHERE "queueKind" = ${input.queueKind} AND "finishedAt" IS NULL
          AND ("inboxEventId" = ${input.queueKind === 'INBOX' ? row.id : null}::UUID
            OR "outboxEventId" = ${input.queueKind === 'OUTBOX' ? row.id : null}::UUID)
        FOR UPDATE
      `);
      const attempt = attempts[0];
      if (!attempt || attempts.length !== 1) fail('BUSINESS_QUEUE_INTEGRITY_FAILURE');
      verifyOpenAttemptForQueueRow(input.queueKind, row, attempt);
      const now = await databaseNow(tx);
      const retry = row.attemptCount < row.maxAttempts;
      const nextAvailableAt = retry
        ? new Date(now.getTime() + getBusinessQueueRetryDelaySeconds(row.attemptCount) * 1_000)
        : null;
      const nextState = retry ? 'AVAILABLE' : 'DEAD_LETTER';
      const query = input.queueKind === 'INBOX'
        ? Prisma.sql`UPDATE "BusinessInboxEvent" SET "state" = ${nextState},
            "availableAt" = ${nextAvailableAt ?? row.availableAt}, "lastFailureCode" = 'LEASE_EXPIRED',
            "terminalAt" = ${retry ? null : now}, "terminalReasonCode" = ${retry ? null : 'LEASE_EXPIRED'},
            "leaseOwnerId" = NULL, "leaseTokenHash" = NULL, "leaseClaimedAt" = NULL,
            "leaseExpiresAt" = NULL, "leaseMaxExpiresAt" = NULL
            WHERE "id" = ${row.id}::UUID AND "state" = 'LEASED'`
        : Prisma.sql`UPDATE "BusinessOutboxEvent" SET "state" = ${nextState},
            "availableAt" = ${nextAvailableAt ?? row.availableAt}, "lastFailureCode" = 'LEASE_EXPIRED',
            "terminalAt" = ${retry ? null : now}, "terminalReasonCode" = ${retry ? null : 'LEASE_EXPIRED'},
            "leaseOwnerId" = NULL, "leaseTokenHash" = NULL, "leaseClaimedAt" = NULL,
            "leaseExpiresAt" = NULL, "leaseMaxExpiresAt" = NULL
            WHERE "id" = ${row.id}::UUID AND "state" = 'LEASED'`;
      if (await tx.$executeRaw(query) !== 1) fail('BUSINESS_QUEUE_STATE_CONFLICT');
      await closeAttempt(
        tx,
        attempt,
        now,
        'LEASE_EXPIRED',
        'LEASE_EXPIRED',
        retry,
        nextAvailableAt,
      );
      if (retry) retried++;
      else deadLettered++;
    }
    return Object.freeze({ recovered: rows.length, retried, deadLettered });
  });
}
