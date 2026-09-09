import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { canonicalJson, canonicalSha256 } from './canonical-json';
import {
  CommunicationIntentContractError,
  createCommunicationAuditRecordV1,
  createCommunicationHeldDecisionV1,
  createCommunicationIntentV1,
  parseCommunicationHeldDecisionV1,
  parseCommunicationIntentV1,
  type CommunicationAuditRecordV1,
  type CommunicationGateSnapshotV1,
  type CommunicationHeldDecisionV1,
  type CommunicationIntentV1,
  type CommunicationMessageReferenceV1,
  type CommunicationRecipientReferenceV1,
} from './communication-backbone-contract';

const AUTHORITY = Symbol('N15_INTERNAL_AUTHORITY');
const TRANSACTION = Symbol('N15_CALLER_TRANSACTION');

export interface CommunicationPersistenceTransactionV1 {
  readonly [TRANSACTION]: true;
  readonly client: Prisma.TransactionClient;
}

type TransactionState = { failure?: { error: unknown } };
const activeTransactions = new WeakMap<CommunicationPersistenceTransactionV1, TransactionState>();

/** Created only at an internal composition boundary; never deserialize this from business input. */
export interface CommunicationPersistenceAuthorityV1 {
  readonly [AUTHORITY]: true;
  readonly producerCode: string;
  readonly now: () => Date;
}

export function createCommunicationPersistenceAuthorityV1(configuration: {
  readonly producerCode: string;
  readonly now: () => Date;
}): CommunicationPersistenceAuthorityV1 {
  if (!/^[A-Z][A-Z0-9_]{0,119}$/u.test(configuration.producerCode)
    || typeof configuration.now !== 'function') {
    throw new CommunicationPersistenceError('N15_AUTHORITY_INVALID');
  }
  return Object.freeze({
    [AUTHORITY]: true as const,
    producerCode: configuration.producerCode,
    now: configuration.now,
  });
}

export interface RecordCommunicationIntentHeldInputV1 {
  readonly intentId: string;
  readonly businessCorrelationId: string;
  readonly callerIdempotencyKey: string;
  readonly recipient: CommunicationRecipientReferenceV1;
  readonly message: CommunicationMessageReferenceV1;
  readonly gateSnapshot: CommunicationGateSnapshotV1;
}

export type CommunicationPersistenceErrorCode =
  | 'N15_TRANSACTION_REQUIRED'
  | 'N15_AUTHORITY_INVALID'
  | 'N15_CLOCK_INVALID'
  | 'N15_IDEMPOTENCY_CONFLICT'
  | 'N15_AGGREGATE_INCOMPLETE'
  | 'N15_AGGREGATE_INCOHERENT'
  | 'N15_SCHEMA_UNAVAILABLE';

export class CommunicationPersistenceError extends Error {
  constructor(readonly code: CommunicationPersistenceErrorCode) {
    super(code);
    this.name = 'CommunicationPersistenceError';
  }
}

export interface CommunicationPersistenceAggregateV1 {
  readonly outcome: 'RECORDED' | 'REPLAYED';
  readonly intent: CommunicationIntentV1;
  readonly decision: CommunicationHeldDecisionV1;
  readonly audit: CommunicationAuditRecordV1;
}

type StoredAggregate = {
  id: string;
  intentId: string;
  producerCode: string;
  occurredAt: Date;
  keyDigest: string;
  semanticHash: string;
  envelopeHash: string;
  canonicalEnvelope: string;
  state: string;
  heldDecision: null | {
    intentRecordId: string; decisionHash: string; canonicalDecision: string; state: string; evaluatedAt: Date;
  };
  auditRecord: null | { intentRecordId: string; recordHash: string; canonicalAudit: string };
};

function schemaUnavailable(error: unknown) {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; meta?: { code?: unknown } };
  return candidate.code === 'P2021' || candidate.meta?.code === '42P01' || candidate.meta?.code === '42704';
}

function parseStored(row: StoredAggregate): Omit<CommunicationPersistenceAggregateV1, 'outcome'> {
  if (!row.heldDecision || !row.auditRecord) {
    throw new CommunicationPersistenceError('N15_AGGREGATE_INCOMPLETE');
  }
  try {
    const intent = parseCommunicationIntentV1(JSON.parse(row.canonicalEnvelope));
    const decision = parseCommunicationHeldDecisionV1(JSON.parse(row.heldDecision.canonicalDecision));
    const audit = createCommunicationAuditRecordV1(intent, decision);
    if (row.state !== 'RECORDED' || row.heldDecision.state !== 'HELD'
      || row.intentId !== intent.intentId
      || row.producerCode !== intent.source.producerCode
      || !(row.occurredAt instanceof Date)
      || row.occurredAt.valueOf() !== Date.parse(intent.occurredAt)
      || row.heldDecision.intentRecordId !== row.id
      || row.auditRecord.intentRecordId !== row.id
      || !(row.heldDecision.evaluatedAt instanceof Date)
      || row.heldDecision.evaluatedAt.valueOf() !== Date.parse(decision.evaluatedAt)
      || row.keyDigest !== intent.idempotency.keyDigest
      || row.semanticHash !== intent.idempotency.semanticHash
      || row.envelopeHash !== intent.idempotency.envelopeHash
      || row.canonicalEnvelope !== canonicalJson(intent)
      || row.heldDecision.decisionHash !== decision.decisionHash
      || row.heldDecision.canonicalDecision !== canonicalJson(decision)
      || row.auditRecord.recordHash !== canonicalSha256(audit)
      || row.auditRecord.canonicalAudit !== canonicalJson(audit)) {
      throw new CommunicationPersistenceError('N15_AGGREGATE_INCOHERENT');
    }
    return { intent, decision, audit };
  } catch (error) {
    if (error instanceof CommunicationPersistenceError) throw error;
    throw new CommunicationPersistenceError('N15_AGGREGATE_INCOHERENT');
  }
}

async function findAggregates(tx: Prisma.TransactionClient, intent: CommunicationIntentV1) {
  return tx.communicationIntentRecord.findMany({
    where: { OR: [{ keyDigest: intent.idempotency.keyDigest }, { intentId: intent.intentId }] },
    include: { heldDecision: true, auditRecord: true },
  }) as Promise<StoredAggregate[]>;
}

/** The caller supplies one callback containing its cause and every N15 write. */
export async function runCommunicationPersistenceTransactionV1<T>(
  client: PrismaClient,
  action: (scope: CommunicationPersistenceTransactionV1) => Promise<T>,
): Promise<T> {
  if (!client || typeof client.$transaction !== 'function') {
    throw new CommunicationPersistenceError('N15_TRANSACTION_REQUIRED');
  }
  return client.$transaction(async (tx) => {
    const scope: CommunicationPersistenceTransactionV1 = Object.freeze({ [TRANSACTION]: true as const, client: tx });
    const state: TransactionState = {};
    activeTransactions.set(scope, state);
    try {
      const result = await action(scope);
      if (state.failure) throw state.failure.error;
      // Surface deferred failures while still inside Prisma's callback, before engine commit.
      await tx.$executeRaw`SET CONSTRAINTS "CommunicationIntentRecord_complete_at_commit" IMMEDIATE`;
      return result;
    } catch (error) {
      if (schemaUnavailable(error)) throw new CommunicationPersistenceError('N15_SCHEMA_UNAVAILABLE');
      throw error;
    } finally {
      activeTransactions.delete(scope);
    }
  });
}

export async function recordCommunicationIntentHeldV1(
  scope: CommunicationPersistenceTransactionV1,
  authority: CommunicationPersistenceAuthorityV1,
  input: RecordCommunicationIntentHeldInputV1,
  fault?: (point: 'AFTER_INTENT' | 'AFTER_DECISION') => void,
): Promise<CommunicationPersistenceAggregateV1> {
  const state = scope && activeTransactions.get(scope);
  if (!state) throw new CommunicationPersistenceError('N15_TRANSACTION_REQUIRED');
  if (state.failure) throw state.failure.error;
  try {
    return await recordInCallerTransaction(scope.client, authority, input, fault);
  } catch (error) {
    state.failure = { error };
    throw error;
  }
}

/** Writes within the single transaction owned by the caller's scoped callback. */
async function recordInCallerTransaction(
  tx: Prisma.TransactionClient,
  authority: CommunicationPersistenceAuthorityV1,
  input: RecordCommunicationIntentHeldInputV1,
  fault?: (point: 'AFTER_INTENT' | 'AFTER_DECISION') => void,
): Promise<CommunicationPersistenceAggregateV1> {
  if (!authority || authority[AUTHORITY] !== true) {
    throw new CommunicationPersistenceError('N15_AUTHORITY_INVALID');
  }
  const occurredAt = authority.now();
  const evaluatedAt = authority.now();
  if (!(occurredAt instanceof Date) || !Number.isFinite(occurredAt.valueOf())
    || !(evaluatedAt instanceof Date) || !Number.isFinite(evaluatedAt.valueOf())) {
    throw new CommunicationPersistenceError('N15_CLOCK_INVALID');
  }
  const intent = createCommunicationIntentV1({
    intentId: input.intentId,
    businessCorrelationId: input.businessCorrelationId,
    occurredAt: occurredAt.toISOString(),
    source: { producerCode: authority.producerCode, callerIdempotencyKey: input.callerIdempotencyKey },
    recipient: input.recipient,
    message: input.message,
  });
  const decision = createCommunicationHeldDecisionV1(intent, input.gateSnapshot, evaluatedAt.toISOString());
  const audit = createCommunicationAuditRecordV1(intent, decision);

  try {
    const inserted = await tx.$queryRaw<Array<{ id: string }>>`
      INSERT INTO "CommunicationIntentRecord"
        ("id", "intentId", "producerCode", "keyDigest", "semanticHash", "envelopeHash", "canonicalEnvelope", "state", "occurredAt")
      VALUES
        (${randomUUID()}::uuid, ${intent.intentId}::uuid, ${intent.source.producerCode},
         ${intent.idempotency.keyDigest}, ${intent.idempotency.semanticHash}, ${intent.idempotency.envelopeHash},
         ${canonicalJson(intent)}, 'RECORDED', ${new Date(intent.occurredAt)})
      ON CONFLICT DO NOTHING RETURNING "id"`;
    const id = inserted[0]?.id;
    if (!id) {
      const matches = await findAggregates(tx, intent);
      if (matches.length === 0) throw new CommunicationPersistenceError('N15_AGGREGATE_INCOHERENT');
      if (matches.length !== 1) throw new CommunicationPersistenceError('N15_IDEMPOTENCY_CONFLICT');
      const stored = matches[0];
      const aggregate = parseStored(stored);
      if (stored.keyDigest !== intent.idempotency.keyDigest
        || stored.semanticHash !== intent.idempotency.semanticHash) {
        throw new CommunicationPersistenceError('N15_IDEMPOTENCY_CONFLICT');
      }
      return { outcome: 'REPLAYED', ...aggregate };
    }
    fault?.('AFTER_INTENT');
    await tx.communicationHeldDecision.create({ data: {
      id: randomUUID(), intentRecordId: id, decisionHash: decision.decisionHash,
      canonicalDecision: canonicalJson(decision), state: 'HELD', evaluatedAt: new Date(decision.evaluatedAt),
    } });
    fault?.('AFTER_DECISION');
    await tx.communicationIntentAudit.create({ data: {
      id: randomUUID(), intentRecordId: id, recordHash: canonicalSha256(audit), canonicalAudit: canonicalJson(audit),
    } });
    return { outcome: 'RECORDED', intent, decision, audit };
  } catch (error) {
    if (error instanceof CommunicationPersistenceError
      || error instanceof CommunicationIntentContractError) throw error;
    if (schemaUnavailable(error)) throw new CommunicationPersistenceError('N15_SCHEMA_UNAVAILABLE');
    throw error;
  }
}
