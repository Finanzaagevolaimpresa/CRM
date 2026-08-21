import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { canonicalJson, canonicalSha256 } from './canonical-json';
import {
  BUSINESS_EVENT_BACKBONE_MANIFEST,
  calculateBusinessInboxRecordHash,
} from './business-event-backbone';
import { hasPermission } from './permission-evaluator';
import {
  acquireLeadIdentityWriteLock,
  assertLeadIdentityKeyConsensus,
  digestLeadIdentitySignals,
  discoverLeadIdentityCandidates,
  LEAD_NORMALIZATION_VERSION,
  LeadIdentityError,
  normalizeLeadIdentitySignals,
  readLeadIdentityKeyFile,
  type LeadIdentityCandidate,
  type LeadIdentityKeyFile,
} from './lead-identity';
import { mapLeadSubmittedEventToLead, LEAD_PROJECTION_MANIFEST } from './lead-projection';
import {
  LeadEventContractError,
  parseLeadSubmittedEventV1,
  type LeadSubmittedEventV1,
} from './lead-event-contract';
import { lockAuthoritativeInternalSession } from './internal-session-registry';
import { internalSessionMode } from './session';

export const LEAD_DUPLICATE_RESOLUTION_MANIFEST = Object.freeze({
  version: 1,
  dormant: true,
  activation: 'NONE' as const,
  permission: 'lead.duplicate.resolve' as const,
  decisionHashDomain: 'fai.lead-duplicate-decision.v1',
  resolutionHashDomain: 'fai.lead-projection.resolution.v1',
  auditEvent: 'lead_duplicate_decision_v1',
  transactionAttempts: 3,
  transactionTimeoutMs: 5_000,
  transactionMaxWaitMs: 2_000,
});

export const LEAD_DUPLICATE_RESOLUTION_ERROR_CODES = Object.freeze([
  'N13_DUPLICATE_SESSION_DENIED',
  'N13_DUPLICATE_CASE_NOT_FOUND',
  'N13_DUPLICATE_CASE_VERSION_CONFLICT',
  'N13_DUPLICATE_CASE_STATE_CONFLICT',
  'N13_DUPLICATE_CANDIDATE_INVALID',
  'N13_DUPLICATE_TRANSACTION_CONFLICT',
  'N13_IDENTITY_KEY_UNAVAILABLE',
  'N13_IDENTITY_KEY_CONSENSUS_FAILURE',
  'N13_PROJECTION_INVARIANT_FAILURE',
] as const);

export type LeadDuplicateResolutionErrorCode =
  typeof LEAD_DUPLICATE_RESOLUTION_ERROR_CODES[number];

export class LeadDuplicateResolutionError extends Error {
  constructor(readonly code: LeadDuplicateResolutionErrorCode) {
    super(code);
    this.name = 'LeadDuplicateResolutionError';
  }
}

export type LeadDuplicateResolutionOutcome =
  | 'LINK_EXISTING_NO_OVERWRITE'
  | 'CREATE_NEW'
  | 'REOPEN';

export type LeadDuplicateResolutionInput = Readonly<{
  caseId: string;
  expectedCaseVersion: number;
  outcome: LeadDuplicateResolutionOutcome;
  selectedLeadId?: string;
  reasonCode: string;
  reasonNote?: string;
  actorUserId: string;
  actorSessionId: string;
}>;

export type LeadDuplicateResolutionOptions = Readonly<{
  keyFilePath?: string;
  allowedSecretRoot?: string;
}>;

type DuplicateCaseRow = Readonly<{
  caseId: string;
  caseState: string;
  discoveryRevision: number;
  caseCandidateCount: number;
  caseVersion: number;
  resolvedAt: Date | null;
  ledgerId: string;
  inboxEventId: string;
  sourceRecordHash: string;
  ledgerState: string;
  ledgerLeadId: string | null;
  ledgerCandidateCount: number;
  ledgerVersion: number;
  ledgerResultHash: string;
  privacyEvidenceCount: number;
  inboxState: string;
  inboxSchemaVersion: string;
  inboxEventType: string;
  inboxEventVersion: number;
  inboxCanonicalizationVersion: number;
  inboxEventBusinessId: string;
  inboxBusinessCorrelationId: string;
  inboxOccurredAt: string;
  inboxKeyDigest: string;
  inboxPayloadHash: string;
  inboxEnvelopeJson: string;
  inboxRecordHash: string;
  inboxClassificationCatalogVersion: string;
  inboxClassificationContractCode: string;
  inboxMaxAttempts: number;
  inboxRetentionClass: string;
  inboxRetentionPolicyVersion: string;
  inboxRetentionEligibleAt: Date | null;
  inboxCreatedAt: Date;
}>;

type LockedCandidateRow = Readonly<{
  leadId: string;
  rank: number;
  deletedAt: Date | null;
}>;

type PrivacyEvidenceRow = Readonly<{
  purposeCode: string;
  legalBasisCode: string;
  evidenceKind: string;
  decision: string;
  sourceSystem: string;
  formCode: string;
  formVersion: string;
  sourceSubmittedAt: Date;
  sourceEvidenceDigest: string;
  leadId: string | null;
  websiteLeadReceiptId: string | null;
}>;

const RETRYABLE_SQL_STATES = new Set(['40001', '40P01', '55P03']);

function duplicateFail(code: LeadDuplicateResolutionErrorCode): never {
  throw new LeadDuplicateResolutionError(code);
}

function retryableSerializableError(error: unknown) {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') return true;
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; meta?: { code?: unknown } };
  return (typeof candidate.code === 'string' && RETRYABLE_SQL_STATES.has(candidate.code))
    || (typeof candidate.meta?.code === 'string'
      && RETRYABLE_SQL_STATES.has(candidate.meta.code));
}

async function withDuplicateResolutionTransaction<T>(
  prisma: PrismaClient,
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
) {
  for (let attempt = 1; attempt <= LEAD_DUPLICATE_RESOLUTION_MANIFEST.transactionAttempts; attempt++) {
    try {
      return await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '1000ms'");
        await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '4000ms'");
        return operation(tx);
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: LEAD_DUPLICATE_RESOLUTION_MANIFEST.transactionMaxWaitMs,
        timeout: LEAD_DUPLICATE_RESOLUTION_MANIFEST.transactionTimeoutMs,
      });
    } catch (error) {
      if (!retryableSerializableError(error)) throw error;
      if (attempt === LEAD_DUPLICATE_RESOLUTION_MANIFEST.transactionAttempts) {
        duplicateFail('N13_DUPLICATE_TRANSACTION_CONFLICT');
      }
    }
  }
  return duplicateFail('N13_DUPLICATE_TRANSACTION_CONFLICT');
}

async function authorizeDecision(
  tx: Prisma.TransactionClient,
  input: LeadDuplicateResolutionInput,
) {
  let registryMode = false;
  try {
    registryMode = internalSessionMode() === 'registry';
  } catch {
    return duplicateFail('N13_DUPLICATE_SESSION_DENIED');
  }
  if (!registryMode) return duplicateFail('N13_DUPLICATE_SESSION_DENIED');
  const session = await lockAuthoritativeInternalSession(tx, {
    sessionId: input.actorSessionId,
    userId: input.actorUserId,
  });
  if (!session
    || session.revokedAt !== null
    || session.live !== true
    || session.active !== true
    || session.deletedAt !== null
    || !hasPermission({
      role: session.role,
      active: session.active,
      permissionOverrides: session.permissionOverrides,
    }, LEAD_DUPLICATE_RESOLUTION_MANIFEST.permission)) {
    return duplicateFail('N13_DUPLICATE_SESSION_DENIED');
  }
  return session;
}

async function lockDuplicateCase(tx: Prisma.TransactionClient, caseId: string) {
  const rows = await tx.$queryRaw<DuplicateCaseRow[]>(Prisma.sql`
    SELECT duplicate_case."id" AS "caseId", duplicate_case."state" AS "caseState",
      duplicate_case."discoveryRevision", duplicate_case."candidateCount" AS "caseCandidateCount",
      duplicate_case."version" AS "caseVersion", duplicate_case."resolvedAt",
      ledger."id" AS "ledgerId", ledger."inboxEventId", ledger."sourceRecordHash",
      ledger."state" AS "ledgerState", ledger."leadId" AS "ledgerLeadId",
      ledger."candidateCount" AS "ledgerCandidateCount", ledger."version" AS "ledgerVersion",
      ledger."resultHash" AS "ledgerResultHash",
      ledger."privacyEvidenceCount", inbox."state" AS "inboxState",
      inbox."schemaVersion" AS "inboxSchemaVersion", inbox."eventType" AS "inboxEventType",
      inbox."eventVersion" AS "inboxEventVersion",
      inbox."canonicalizationVersion" AS "inboxCanonicalizationVersion",
      inbox."eventId" AS "inboxEventBusinessId",
      inbox."businessCorrelationId" AS "inboxBusinessCorrelationId",
      inbox."occurredAt" AS "inboxOccurredAt", inbox."keyDigest" AS "inboxKeyDigest",
      inbox."payloadHash" AS "inboxPayloadHash", inbox."envelopeJson" AS "inboxEnvelopeJson",
      inbox."recordHash" AS "inboxRecordHash",
      inbox."classificationCatalogVersion" AS "inboxClassificationCatalogVersion",
      inbox."classificationContractCode" AS "inboxClassificationContractCode",
      inbox."maxAttempts" AS "inboxMaxAttempts", inbox."retentionClass" AS "inboxRetentionClass",
      inbox."retentionPolicyVersion" AS "inboxRetentionPolicyVersion",
      inbox."retentionEligibleAt" AS "inboxRetentionEligibleAt",
      inbox."createdAt" AS "inboxCreatedAt"
    FROM "LeadDuplicateCase" duplicate_case
    JOIN "LeadProjectionLedger" ledger ON ledger."id" = duplicate_case."projectionLedgerId"
    JOIN "BusinessInboxEvent" inbox ON inbox."id" = ledger."inboxEventId"
    WHERE duplicate_case."id" = ${caseId}::UUID
    FOR UPDATE OF duplicate_case, ledger, inbox
  `);
  return rows[0] ?? null;
}

function verifiedSourceEvent(row: DuplicateCaseRow) {
  let raw: unknown;
  try {
    raw = JSON.parse(row.inboxEnvelopeJson) as unknown;
  } catch {
    return duplicateFail('N13_PROJECTION_INVARIANT_FAILURE');
  }
  let event: LeadSubmittedEventV1;
  try {
    event = parseLeadSubmittedEventV1(raw);
  } catch (error) {
    if (error instanceof LeadEventContractError) {
      return duplicateFail('N13_PROJECTION_INVARIANT_FAILURE');
    }
    throw error;
  }
  let calculatedRecordHash: string;
  try {
    calculatedRecordHash = calculateBusinessInboxRecordHash(
      row.inboxEventId,
      event,
      row.inboxCreatedAt,
    );
  } catch {
    return duplicateFail('N13_PROJECTION_INVARIANT_FAILURE');
  }
  if (row.sourceRecordHash !== row.inboxRecordHash
    || calculatedRecordHash !== row.inboxRecordHash
    || canonicalJson(event) !== row.inboxEnvelopeJson
    || row.inboxState !== 'PROCESSED'
    || row.inboxSchemaVersion !== event.schemaVersion
    || row.inboxEventType !== event.eventType
    || row.inboxEventVersion !== event.eventVersion
    || row.inboxCanonicalizationVersion !== event.idempotency.canonicalizationVersion
    || row.inboxEventBusinessId !== event.eventId
    || row.inboxBusinessCorrelationId !== event.businessCorrelationId
    || row.inboxOccurredAt !== event.occurredAt
    || row.inboxKeyDigest !== event.idempotency.keyDigest
    || row.inboxPayloadHash !== event.idempotency.payloadHash
    || row.inboxClassificationCatalogVersion
      !== BUSINESS_EVENT_BACKBONE_MANIFEST.classificationCatalogVersion
    || row.inboxClassificationContractCode
      !== BUSINESS_EVENT_BACKBONE_MANIFEST.classificationContractCode
    || row.inboxMaxAttempts !== BUSINESS_EVENT_BACKBONE_MANIFEST.maxAttempts
    || row.inboxRetentionClass !== BUSINESS_EVENT_BACKBONE_MANIFEST.retentionClass
    || row.inboxRetentionPolicyVersion
      !== BUSINESS_EVENT_BACKBONE_MANIFEST.retentionPolicyVersion
    || row.inboxRetentionEligibleAt !== null) {
    return duplicateFail('N13_PROJECTION_INVARIANT_FAILURE');
  }
  return event;
}

async function verifyPrivacyEvidence(
  tx: Prisma.TransactionClient,
  row: DuplicateCaseRow,
  event: LeadSubmittedEventV1,
) {
  const evidence = await tx.$queryRaw<PrivacyEvidenceRow[]>(Prisma.sql`
    SELECT "purposeCode", "legalBasisCode", "evidenceKind", "decision", "sourceSystem",
      "formCode", "formVersion", "sourceSubmittedAt", "sourceEvidenceDigest", "leadId",
      "websiteLeadReceiptId"
    FROM "PrivacyEvidenceReceipt"
    WHERE "businessInboxEventId" = ${row.inboxEventId}::UUID
    ORDER BY "purposeCode"
    FOR SHARE
  `);
  const expected = [
    {
      reference: event.privacy.service,
      evidenceKind: 'NOTICE_ACKNOWLEDGEMENT',
      decision: 'ACKNOWLEDGED',
    },
    {
      reference: event.privacy.marketing,
      evidenceKind: 'CONSENT',
      decision: event.privacy.marketing.decision === 'GRANTED' ? 'GRANTED' : 'DENIED',
    },
  ] as const;
  const submittedAt = new Date(event.occurredAt).getTime();
  if (row.privacyEvidenceCount !== 2 || evidence.length !== 2
    || !Number.isFinite(submittedAt)
    || expected.some(({ reference, evidenceKind, decision }) => {
      const receipt = evidence.find(({ purposeCode }) => purposeCode === reference.purposeCode);
      return !receipt
        || receipt.legalBasisCode !== reference.legalBasisCode
        || receipt.evidenceKind !== evidenceKind
        || receipt.decision !== decision
        || receipt.sourceSystem !== event.source.systemCode
        || receipt.formCode !== event.source.formCode
        || receipt.formVersion !== event.source.formVersion
        || receipt.sourceSubmittedAt.getTime() !== submittedAt
        || receipt.sourceEvidenceDigest !== event.idempotency.payloadHash
        || receipt.leadId !== null
        || receipt.websiteLeadReceiptId !== null;
    })) {
    return duplicateFail('N13_PROJECTION_INVARIANT_FAILURE');
  }
}

async function lockCurrentCandidates(
  tx: Prisma.TransactionClient,
  row: DuplicateCaseRow,
) {
  const candidates = await tx.$queryRaw<LockedCandidateRow[]>(Prisma.sql`
    SELECT candidate."leadId", candidate."rank", lead."deletedAt"
    FROM "LeadDuplicateCandidate" candidate
    JOIN "Lead" lead ON lead."id" = candidate."leadId"
    WHERE candidate."duplicateCaseId" = ${row.caseId}::UUID
      AND candidate."discoveryRevision" = ${row.discoveryRevision}
    ORDER BY candidate."rank"
    FOR UPDATE OF candidate, lead
  `);
  if (candidates.length !== row.caseCandidateCount
    || row.caseCandidateCount !== row.ledgerCandidateCount
    || candidates.some((candidate, index) => candidate.rank !== index + 1)) {
    return duplicateFail('N13_PROJECTION_INVARIANT_FAILURE');
  }
  if (row.ledgerLeadId && !candidates.some(({ leadId }) => leadId === row.ledgerLeadId)) {
    const lead = await tx.$queryRaw<Array<{ id: string; deletedAt: Date | null }>>(Prisma.sql`
      SELECT "id", "deletedAt" FROM "Lead"
      WHERE "id" = ${row.ledgerLeadId}
      FOR UPDATE
    `);
    if (!lead[0]) return duplicateFail('N13_PROJECTION_INVARIANT_FAILURE');
  }
  return candidates;
}

async function databaseNow(tx: Prisma.TransactionClient) {
  const rows = await tx.$queryRaw<Array<{ now: Date }>>(Prisma.sql`
    SELECT DATE_TRUNC('milliseconds', clock_timestamp()) AS "now"
  `);
  return rows[0]?.now ?? duplicateFail('N13_PROJECTION_INVARIANT_FAILURE');
}

async function previousDecision(tx: Prisma.TransactionClient, caseId: string) {
  return tx.leadDuplicateDecision.findFirst({
    where: { duplicateCaseId: caseId },
    orderBy: { sequence: 'desc' },
    select: {
      id: true,
      sequence: true,
      outcome: true,
      decisionHash: true,
    },
  });
}

function decisionHash(input: Readonly<{
  caseId: string;
  sequence: number;
  caseVersionBefore: number;
  outcome: LeadDuplicateResolutionOutcome;
  selectedLeadId: string | null;
  resultingLeadId: string | null;
  actorUserId: string;
  actorSessionId: string;
  reasonCode: string;
  reasonNote: string | null;
  previousDecisionHash: string | null;
}>) {
  return canonicalSha256({
    domain: LEAD_DUPLICATE_RESOLUTION_MANIFEST.decisionHashDomain,
    ...input,
  });
}

async function createDecision(
  tx: Prisma.TransactionClient,
  input: LeadDuplicateResolutionInput,
  row: DuplicateCaseRow,
  outcome: LeadDuplicateResolutionOutcome,
  selectedLeadId: string | null,
  resultingLeadId: string | null,
  previous: Awaited<ReturnType<typeof previousDecision>>,
) {
  const sequence = (previous?.sequence ?? 0) + 1;
  const hash = decisionHash({
    caseId: row.caseId,
    sequence,
    caseVersionBefore: row.caseVersion,
    outcome,
    selectedLeadId,
    resultingLeadId,
    actorUserId: input.actorUserId,
    actorSessionId: input.actorSessionId,
    reasonCode: input.reasonCode,
    reasonNote: input.reasonNote ?? null,
    previousDecisionHash: previous?.decisionHash ?? null,
  });
  return tx.leadDuplicateDecision.create({
    data: {
      id: randomUUID(),
      duplicateCaseId: row.caseId,
      sequence,
      caseVersionBefore: row.caseVersion,
      outcome,
      selectedLeadId,
      resultingLeadId,
      actorUserId: input.actorUserId,
      actorSessionId: input.actorSessionId,
      reasonCode: input.reasonCode,
      reasonNote: input.reasonNote ?? null,
      decisionHash: hash,
    },
  });
}

async function createDecisionIdentityRows(
  tx: Prisma.TransactionClient,
  input: Readonly<{
    leadId: string;
    ledgerId: string;
    decisionId: string;
    identityKeyVersionId: string;
    signals: ReturnType<typeof digestLeadIdentitySignals>;
  }>,
) {
  if (input.signals.length === 0) return;
  await tx.leadIdentityKey.createMany({
    data: input.signals.map((signal) => ({
      leadId: input.leadId,
      identityKeyVersionId: input.identityKeyVersionId,
      normalizationVersion: LEAD_NORMALIZATION_VERSION,
      signalKind: signal.kind,
      signalStrength: signal.strength,
      identityDigest: signal.identityDigest,
      sourceProjectionId: input.ledgerId,
      sourceDecisionId: input.decisionId,
    })),
  });
}

function resolutionResultHash(
  row: DuplicateCaseRow,
  input: Readonly<{
    state: 'REVIEW_REQUIRED' | 'RESOLVED_EXISTING' | 'RESOLVED_NEW';
    leadId: string | null;
    candidateCount: number;
    discoveryRevision: number;
    decisionHash: string;
    candidateSnapshotHashes?: readonly string[];
  }>,
) {
  return canonicalSha256({
    domain: LEAD_DUPLICATE_RESOLUTION_MANIFEST.resolutionHashDomain,
    previousResultHash: row.ledgerResultHash,
    state: input.state,
    leadId: input.leadId,
    candidateCount: input.candidateCount,
    discoveryRevision: input.discoveryRevision,
    decisionHash: input.decisionHash,
    candidateSnapshotHashes: input.candidateSnapshotHashes ?? [],
  });
}

function snapshotsForRevision(
  row: DuplicateCaseRow,
  revision: number,
  candidates: readonly LeadIdentityCandidate[],
) {
  return candidates.map((candidate, index) => {
    const rank = index + 1;
    return Object.freeze({
      ...candidate,
      rank,
      snapshotHash: canonicalSha256({
        domain: LEAD_PROJECTION_MANIFEST.candidateHashDomain,
        sourceRecordHash: row.sourceRecordHash,
        discoveryRevision: revision,
        leadId: candidate.leadId,
        rank,
        strongestSignal: candidate.strongestSignal,
        strongSignalCount: candidate.strongSignalCount,
        weakSignalCount: candidate.weakSignalCount,
        matchedSignalCodes: candidate.matchedSignalCodes,
      }),
    });
  });
}

async function auditDecision(
  tx: Prisma.TransactionClient,
  input: LeadDuplicateResolutionInput,
  row: DuplicateCaseRow,
  outcome: LeadDuplicateResolutionOutcome,
  candidateCount: number,
  discoveryRevision: number,
) {
  await tx.auditLog.create({
    data: {
      actorId: input.actorUserId,
      event: LEAD_DUPLICATE_RESOLUTION_MANIFEST.auditEvent,
      entityType: 'LeadDuplicateDecision',
      entityId: null,
      after: {
        resolutionVersion: LEAD_DUPLICATE_RESOLUTION_MANIFEST.version,
        outcome,
        reasonCode: input.reasonCode,
        caseVersionBefore: row.caseVersion,
        caseVersionAfter: row.caseVersion + 1,
        ledgerVersionBefore: row.ledgerVersion,
        ledgerVersionAfter: row.ledgerVersion + 1,
        discoveryRevision,
        candidateCount,
      },
    },
  });
}

async function resolveOpenCase(
  tx: Prisma.TransactionClient,
  input: LeadDuplicateResolutionInput,
  row: DuplicateCaseRow,
  event: LeadSubmittedEventV1,
  key: LeadIdentityKeyFile,
  activeKey: Awaited<ReturnType<typeof assertLeadIdentityKeyConsensus>>,
  candidates: readonly LockedCandidateRow[],
  previous: Awaited<ReturnType<typeof previousDecision>>,
  now: Date,
) {
  if (row.caseState !== 'OPEN' || row.ledgerState !== 'REVIEW_REQUIRED'
    || row.resolvedAt !== null || row.ledgerLeadId !== null) {
    return duplicateFail('N13_DUPLICATE_CASE_STATE_CONFLICT');
  }
  const signals = digestLeadIdentitySignals(key, normalizeLeadIdentitySignals(event.payload));
  let resultingLeadId: string;
  let selectedLeadId: string | null = null;
  let ledgerState: 'RESOLVED_EXISTING' | 'RESOLVED_NEW';
  if (input.outcome === 'LINK_EXISTING_NO_OVERWRITE') {
    const selected = candidates.find(({ leadId }) => leadId === input.selectedLeadId);
    if (!selected || selected.deletedAt !== null) {
      return duplicateFail('N13_DUPLICATE_CANDIDATE_INVALID');
    }
    selectedLeadId = selected.leadId;
    resultingLeadId = selected.leadId;
    ledgerState = 'RESOLVED_EXISTING';
  } else if (input.outcome === 'CREATE_NEW') {
    const lead = await tx.lead.create({ data: mapLeadSubmittedEventToLead(event) });
    resultingLeadId = lead.id;
    ledgerState = 'RESOLVED_NEW';
  } else {
    return duplicateFail('N13_DUPLICATE_CASE_STATE_CONFLICT');
  }
  const decision = await createDecision(
    tx,
    input,
    row,
    input.outcome,
    selectedLeadId,
    resultingLeadId,
    previous,
  );
  await createDecisionIdentityRows(tx, {
    leadId: resultingLeadId,
    ledgerId: row.ledgerId,
    decisionId: decision.id,
    identityKeyVersionId: activeKey.id,
    signals,
  });
  const caseUpdated = await tx.leadDuplicateCase.updateMany({
    where: { id: row.caseId, state: 'OPEN', version: row.caseVersion },
    data: { state: 'RESOLVED', resolvedAt: now, version: row.caseVersion + 1 },
  });
  const ledgerUpdated = await tx.leadProjectionLedger.updateMany({
    where: { id: row.ledgerId, state: 'REVIEW_REQUIRED', version: row.ledgerVersion },
    data: {
      state: ledgerState,
      leadId: resultingLeadId,
      version: row.ledgerVersion + 1,
      resultHash: resolutionResultHash(row, {
        state: ledgerState,
        leadId: resultingLeadId,
        candidateCount: row.caseCandidateCount,
        discoveryRevision: row.discoveryRevision,
        decisionHash: decision.decisionHash,
      }),
    },
  });
  if (caseUpdated.count !== 1 || ledgerUpdated.count !== 1) {
    return duplicateFail('N13_DUPLICATE_CASE_VERSION_CONFLICT');
  }
  await auditDecision(
    tx,
    input,
    row,
    input.outcome,
    row.caseCandidateCount,
    row.discoveryRevision,
  );
  return Object.freeze({
    outcome: input.outcome,
    decisionId: decision.id,
    resultingLeadId,
    state: ledgerState,
    candidateCount: row.caseCandidateCount,
    discoveryRevision: row.discoveryRevision,
    caseVersion: row.caseVersion + 1,
  });
}

async function reopenResolvedCase(
  tx: Prisma.TransactionClient,
  input: LeadDuplicateResolutionInput,
  row: DuplicateCaseRow,
  event: LeadSubmittedEventV1,
  key: LeadIdentityKeyFile,
  activeKey: Awaited<ReturnType<typeof assertLeadIdentityKeyConsensus>>,
  previous: Awaited<ReturnType<typeof previousDecision>>,
  now: Date,
) {
  if (input.outcome !== 'REOPEN'
    || row.caseState !== 'RESOLVED'
    || !['RESOLVED_EXISTING', 'RESOLVED_NEW'].includes(row.ledgerState)
    || row.resolvedAt === null
    || row.ledgerLeadId === null
    || !previous
    || !['LINK_EXISTING_NO_OVERWRITE', 'CREATE_NEW'].includes(previous.outcome)) {
    return duplicateFail('N13_DUPLICATE_CASE_STATE_CONFLICT');
  }
  const decision = await createDecision(tx, input, row, 'REOPEN', null, null, previous);
  await tx.leadIdentityKey.updateMany({
    where: { sourceDecisionId: previous.id, retiredAt: null },
    data: { retiredAt: now, retiredByDecisionId: decision.id },
  });
  const signals = digestLeadIdentitySignals(key, normalizeLeadIdentitySignals(event.payload));
  const candidates = await discoverLeadIdentityCandidates(tx, {
    identityKeyVersionId: activeKey.id,
    signals,
  });
  const revision = row.discoveryRevision + 1;
  const snapshots = snapshotsForRevision(row, revision, candidates);
  if (snapshots.length > 0) {
    await tx.leadDuplicateCandidate.createMany({
      data: snapshots.map((snapshot) => ({
        duplicateCaseId: row.caseId,
        discoveryRevision: revision,
        leadId: snapshot.leadId,
        rank: snapshot.rank,
        strongestSignal: snapshot.strongestSignal,
        strongSignalCount: snapshot.strongSignalCount,
        weakSignalCount: snapshot.weakSignalCount,
        matchedSignalCodes: [...snapshot.matchedSignalCodes],
        snapshotHash: snapshot.snapshotHash,
      })),
    });
  }
  const caseUpdated = await tx.leadDuplicateCase.updateMany({
    where: { id: row.caseId, state: 'RESOLVED', version: row.caseVersion },
    data: {
      state: 'OPEN',
      discoveryRevision: revision,
      candidateCount: snapshots.length,
      resolvedAt: null,
      version: row.caseVersion + 1,
    },
  });
  const ledgerUpdated = await tx.leadProjectionLedger.updateMany({
    where: { id: row.ledgerId, state: row.ledgerState, version: row.ledgerVersion },
    data: {
      state: 'REVIEW_REQUIRED',
      leadId: null,
      candidateCount: snapshots.length,
      version: row.ledgerVersion + 1,
      resultHash: resolutionResultHash(row, {
        state: 'REVIEW_REQUIRED',
        leadId: null,
        candidateCount: snapshots.length,
        discoveryRevision: revision,
        decisionHash: decision.decisionHash,
        candidateSnapshotHashes: snapshots.map(({ snapshotHash }) => snapshotHash),
      }),
    },
  });
  if (caseUpdated.count !== 1 || ledgerUpdated.count !== 1) {
    return duplicateFail('N13_DUPLICATE_CASE_VERSION_CONFLICT');
  }
  await auditDecision(tx, input, row, 'REOPEN', snapshots.length, revision);
  return Object.freeze({
    outcome: 'REOPEN' as const,
    decisionId: decision.id,
    resultingLeadId: null,
    state: 'REVIEW_REQUIRED' as const,
    candidateCount: snapshots.length,
    discoveryRevision: revision,
    caseVersion: row.caseVersion + 1,
  });
}

async function resolveInTransaction(
  tx: Prisma.TransactionClient,
  input: LeadDuplicateResolutionInput,
  key: LeadIdentityKeyFile,
) {
  await authorizeDecision(tx, input);
  await acquireLeadIdentityWriteLock(tx);
  const activeKey = await assertLeadIdentityKeyConsensus(tx, key);
  const row = await lockDuplicateCase(tx, input.caseId);
  if (!row) return duplicateFail('N13_DUPLICATE_CASE_NOT_FOUND');
  if (row.caseVersion !== input.expectedCaseVersion) {
    return duplicateFail('N13_DUPLICATE_CASE_VERSION_CONFLICT');
  }
  const event = verifiedSourceEvent(row);
  await verifyPrivacyEvidence(tx, row, event);
  const candidates = await lockCurrentCandidates(tx, row);
  const previous = await previousDecision(tx, row.caseId);
  const now = await databaseNow(tx);
  if (row.caseState === 'OPEN') {
    return resolveOpenCase(tx, input, row, event, key, activeKey, candidates, previous, now);
  }
  return reopenResolvedCase(tx, input, row, event, key, activeKey, previous, now);
}

export async function resolveLeadDuplicateCase(
  prisma: PrismaClient,
  input: LeadDuplicateResolutionInput,
  options: LeadDuplicateResolutionOptions = {},
) {
  let key: LeadIdentityKeyFile;
  try {
    key = await readLeadIdentityKeyFile(options.keyFilePath, {
      allowedRoot: options.allowedSecretRoot,
    });
  } catch (error) {
    if (error instanceof LeadIdentityError) {
      throw new LeadDuplicateResolutionError(error.code);
    }
    throw error;
  }
  try {
    return await withDuplicateResolutionTransaction(
      prisma,
      (tx) => resolveInTransaction(tx, input, key),
    );
  } catch (error) {
    if (error instanceof LeadDuplicateResolutionError) throw error;
    if (error instanceof LeadIdentityError) {
      throw new LeadDuplicateResolutionError(error.code);
    }
    return duplicateFail('N13_PROJECTION_INVARIANT_FAILURE');
  }
}
