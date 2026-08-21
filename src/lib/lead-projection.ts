import { canonicalSha256 } from './canonical-json';
import { Prisma, type PrismaClient } from '@prisma/client';
import {
  BusinessEventBackboneError,
  failBusinessQueueEvent,
  processClaimedBusinessInboxEventInTransaction,
  type BusinessQueueLeaseIdentity,
  type ClaimedBusinessInboxTransactionContext,
} from './business-event-backbone';
import {
  acquireLeadIdentityWriteLock,
  assertLeadIdentityKeyConsensus,
  digestLeadIdentitySignals,
  discoverLeadIdentityCandidates,
  LEAD_NORMALIZATION_VERSION,
  LeadIdentityError,
  normalizeLeadIdentitySignals,
  readLeadIdentityKeyFile,
  type LeadIdentityKeyFile,
} from './lead-identity';
import type { LeadSubmittedEventV1 } from './lead-event-contract';
import {
  createBusinessLeadPrivacyEvidence,
  PrivacyContractUnavailableError,
} from './privacy-evidence';

export const LEAD_PROJECTION_MANIFEST = Object.freeze({
  version: 1,
  dormant: true,
  runtimeConsumers: Object.freeze([] as string[]),
  activation: 'NONE' as const,
  normalizationVersion: LEAD_NORMALIZATION_VERSION,
  projectionHashDomain: 'fai.lead-projection.result.v1',
  candidateHashDomain: 'fai.lead-duplicate-candidate.snapshot.v1',
  auditEvent: 'lead_projection_completed_v1',
});

export const LEAD_PROJECTION_ERROR_CODES = Object.freeze([
  'N13_IDENTITY_KEY_UNAVAILABLE',
  'N13_IDENTITY_KEY_CONSENSUS_FAILURE',
  'N13_PRIVACY_CONTRACT_UNAVAILABLE',
  'N13_PROJECTION_INVARIANT_FAILURE',
] as const);

export type LeadProjectionErrorCode = typeof LEAD_PROJECTION_ERROR_CODES[number];

export class LeadProjectionError extends Error {
  constructor(readonly code: LeadProjectionErrorCode) {
    super(code);
    this.name = 'LeadProjectionError';
  }
}

export type LeadProjectionFaultPoint =
  | 'AFTER_EVIDENCE'
  | 'AFTER_LEAD'
  | 'AFTER_LEDGER'
  | 'AFTER_CASE'
  | 'BEFORE_COMPLETION';

export type ProjectClaimedLeadInboxEventOptions = Readonly<{
  keyFilePath?: string;
  allowedSecretRoot?: string;
  faultInjector?: (point: LeadProjectionFaultPoint) => void | Promise<void>;
}>;

function projectionFail(code: LeadProjectionErrorCode): never {
  throw new LeadProjectionError(code);
}

export function mapLeadSubmittedEventToLead(
  event: LeadSubmittedEventV1,
): Prisma.LeadUncheckedCreateInput {
  const requestedAmount = event.payload.requestedAmount
    ? new Prisma.Decimal(event.payload.requestedAmount.minorUnits).div(100)
    : null;
  return {
    firstName: event.payload.firstName ?? '',
    lastName: event.payload.lastName ?? '',
    companyName: event.payload.companyName ?? null,
    contactPerson: null,
    phone: event.payload.phone ?? null,
    email: event.payload.email ?? null,
    source: `N10:${event.source.systemCode}:${event.source.formCode}:${event.source.formVersion}`,
    leadSource: 'altro',
    region: event.payload.region ?? null,
    province: null,
    city: event.payload.city ?? null,
    interest: event.payload.serviceInterestText
      ?? event.payload.interestText
      ?? event.catalogReference?.serviceCode
      ?? null,
    declaredInvestment: null,
    requestedAmount,
    availableBudget: null,
    status: 'nuovo',
    priority: 'media',
    commercialStatus: null,
    assignedToId: null,
    nextAction: null,
    nextActionNote: null,
    nextActionDate: null,
    notes: event.payload.message ?? null,
    commercialProposal: null,
    clientId: null,
    deletedAt: null,
  };
}

function projectionError(error: unknown): LeadProjectionError | null {
  if (error instanceof LeadProjectionError) return error;
  if (error instanceof LeadIdentityError) return new LeadProjectionError(error.code);
  if (error instanceof PrivacyContractUnavailableError) {
    return new LeadProjectionError('N13_PRIVACY_CONTRACT_UNAVAILABLE');
  }
  return null;
}

async function injectFault(
  options: ProjectClaimedLeadInboxEventOptions,
  point: LeadProjectionFaultPoint,
) {
  await options.faultInjector?.(point);
}

function candidateSnapshots(
  sourceRecordHash: string,
  candidates: Awaited<ReturnType<typeof discoverLeadIdentityCandidates>>,
) {
  return candidates.map((candidate, index) => {
    const rank = index + 1;
    const snapshotHash = canonicalSha256({
      domain: LEAD_PROJECTION_MANIFEST.candidateHashDomain,
      sourceRecordHash,
      discoveryRevision: 1,
      leadId: candidate.leadId,
      rank,
      strongestSignal: candidate.strongestSignal,
      strongSignalCount: candidate.strongSignalCount,
      weakSignalCount: candidate.weakSignalCount,
      matchedSignalCodes: candidate.matchedSignalCodes,
    });
    return Object.freeze({ ...candidate, rank, snapshotHash });
  });
}

async function createProjectedLead(
  tx: Prisma.TransactionClient,
  input: Readonly<{
    inboxEventId: string;
    sourceRecordHash: string;
    event: LeadSubmittedEventV1;
    databaseNow: Date;
    identityKey: LeadIdentityKeyFile;
    identityKeyVersionId: string;
    identitySignals: ReturnType<typeof digestLeadIdentitySignals>;
    evidenceHashes: readonly string[];
    options: ProjectClaimedLeadInboxEventOptions;
  }>,
) {
  const lead = await tx.lead.create({ data: mapLeadSubmittedEventToLead(input.event) });
  await injectFault(input.options, 'AFTER_LEAD');
  const resultHash = canonicalSha256({
    domain: LEAD_PROJECTION_MANIFEST.projectionHashDomain,
    inboxEventId: input.inboxEventId,
    sourceRecordHash: input.sourceRecordHash,
    state: 'PROJECTED_NEW',
    leadId: lead.id,
    candidateCount: 0,
    normalizationVersion: LEAD_NORMALIZATION_VERSION,
    keyVersion: input.identityKey.version,
    privacyEvidenceHashes: input.evidenceHashes,
    identityDigests: input.identitySignals.map((signal) => ({
      signalKind: signal.kind,
      identityDigest: signal.identityDigest,
    })),
  });
  const ledger = await tx.leadProjectionLedger.create({
    data: {
      inboxEventId: input.inboxEventId,
      sourceRecordHash: input.sourceRecordHash,
      state: 'PROJECTED_NEW',
      leadId: lead.id,
      candidateCount: 0,
      normalizationVersion: LEAD_NORMALIZATION_VERSION,
      identityKeyVersionId: input.identityKeyVersionId,
      version: 1,
      privacyEvidenceCount: 2,
      resultHash,
      completedAt: input.databaseNow,
    },
  });
  await injectFault(input.options, 'AFTER_LEDGER');
  if (input.identitySignals.length > 0) {
    await tx.leadIdentityKey.createMany({
      data: input.identitySignals.map((signal) => ({
        leadId: lead.id,
        identityKeyVersionId: input.identityKeyVersionId,
        normalizationVersion: LEAD_NORMALIZATION_VERSION,
        signalKind: signal.kind,
        signalStrength: signal.strength,
        identityDigest: signal.identityDigest,
        sourceProjectionId: ledger.id,
      })),
    });
  }
  return Object.freeze({
    state: 'PROJECTED_NEW' as const,
    leadId: lead.id,
    candidateCount: 0,
    ledgerId: ledger.id,
    duplicateCaseId: null,
  });
}

async function createDuplicateReviewCase(
  tx: Prisma.TransactionClient,
  input: Readonly<{
    inboxEventId: string;
    sourceRecordHash: string;
    databaseNow: Date;
    identityKey: LeadIdentityKeyFile;
    identityKeyVersionId: string;
    evidenceHashes: readonly string[];
    snapshots: ReturnType<typeof candidateSnapshots>;
    options: ProjectClaimedLeadInboxEventOptions;
  }>,
) {
  const resultHash = canonicalSha256({
    domain: LEAD_PROJECTION_MANIFEST.projectionHashDomain,
    inboxEventId: input.inboxEventId,
    sourceRecordHash: input.sourceRecordHash,
    state: 'REVIEW_REQUIRED',
    leadId: null,
    candidateCount: input.snapshots.length,
    normalizationVersion: LEAD_NORMALIZATION_VERSION,
    keyVersion: input.identityKey.version,
    privacyEvidenceHashes: input.evidenceHashes,
    candidateSnapshotHashes: input.snapshots.map(({ snapshotHash }) => snapshotHash),
  });
  const ledger = await tx.leadProjectionLedger.create({
    data: {
      inboxEventId: input.inboxEventId,
      sourceRecordHash: input.sourceRecordHash,
      state: 'REVIEW_REQUIRED',
      leadId: null,
      candidateCount: input.snapshots.length,
      normalizationVersion: LEAD_NORMALIZATION_VERSION,
      identityKeyVersionId: input.identityKeyVersionId,
      version: 1,
      privacyEvidenceCount: 2,
      resultHash,
      completedAt: input.databaseNow,
    },
  });
  await injectFault(input.options, 'AFTER_LEDGER');
  const duplicateCase = await tx.leadDuplicateCase.create({
    data: {
      projectionLedgerId: ledger.id,
      state: 'OPEN',
      discoveryRevision: 1,
      candidateCount: input.snapshots.length,
      version: 1,
    },
  });
  await tx.leadDuplicateCandidate.createMany({
    data: input.snapshots.map((snapshot) => ({
      duplicateCaseId: duplicateCase.id,
      discoveryRevision: 1,
      leadId: snapshot.leadId,
      rank: snapshot.rank,
      strongestSignal: snapshot.strongestSignal,
      strongSignalCount: snapshot.strongSignalCount,
      weakSignalCount: snapshot.weakSignalCount,
      matchedSignalCodes: [...snapshot.matchedSignalCodes],
      snapshotHash: snapshot.snapshotHash,
    })),
  });
  await injectFault(input.options, 'AFTER_CASE');
  return Object.freeze({
    state: 'REVIEW_REQUIRED' as const,
    leadId: null,
    candidateCount: input.snapshots.length,
    ledgerId: ledger.id,
    duplicateCaseId: duplicateCase.id,
  });
}

async function projectInTransaction(
  context: ClaimedBusinessInboxTransactionContext,
  key: LeadIdentityKeyFile,
  options: ProjectClaimedLeadInboxEventOptions,
) {
  await acquireLeadIdentityWriteLock(context.tx);
  const activeKey = await assertLeadIdentityKeyConsensus(context.tx, key);
  const existingLedger = await context.tx.leadProjectionLedger.findUnique({
    where: { inboxEventId: context.inboxEventId },
    select: { id: true },
  });
  if (existingLedger) {
    throw new BusinessEventBackboneError('BUSINESS_QUEUE_INTEGRITY_FAILURE');
  }
  let evidence;
  try {
    evidence = await createBusinessLeadPrivacyEvidence(context.tx, {
      businessInboxEventId: context.inboxEventId,
      event: context.envelope,
    });
  } catch (error) {
    if (error instanceof PrivacyContractUnavailableError) {
      projectionFail('N13_PRIVACY_CONTRACT_UNAVAILABLE');
    }
    throw error;
  }
  await injectFault(options, 'AFTER_EVIDENCE');
  const normalizedSignals = normalizeLeadIdentitySignals(context.envelope.payload);
  const identitySignals = digestLeadIdentitySignals(key, normalizedSignals);
  const candidates = await discoverLeadIdentityCandidates(context.tx, {
    identityKeyVersionId: activeKey.id,
    signals: identitySignals,
  });
  const snapshots = candidateSnapshots(context.recordHash, candidates);
  const result = snapshots.length === 0
    ? await createProjectedLead(context.tx, {
      inboxEventId: context.inboxEventId,
      sourceRecordHash: context.recordHash,
      event: context.envelope,
      databaseNow: context.databaseNow,
      identityKey: key,
      identityKeyVersionId: activeKey.id,
      identitySignals,
      evidenceHashes: evidence.evidenceHashes,
      options,
    })
    : await createDuplicateReviewCase(context.tx, {
      inboxEventId: context.inboxEventId,
      sourceRecordHash: context.recordHash,
      databaseNow: context.databaseNow,
      identityKey: key,
      identityKeyVersionId: activeKey.id,
      evidenceHashes: evidence.evidenceHashes,
      snapshots,
      options,
    });
  await context.tx.auditLog.create({
    data: {
      actorId: null,
      event: LEAD_PROJECTION_MANIFEST.auditEvent,
      entityType: 'LeadProjectionLedger',
      entityId: null,
      after: {
        projectionVersion: LEAD_PROJECTION_MANIFEST.version,
        normalizationVersion: LEAD_NORMALIZATION_VERSION,
        state: result.state,
        candidateCount: result.candidateCount,
        privacyEvidenceCount: evidence.count,
      },
    },
  });
  await injectFault(options, 'BEFORE_COMPLETION');
  return result;
}

async function recordProjectionFailure(
  prisma: PrismaClient,
  leaseIdentity: BusinessQueueLeaseIdentity,
  failureCode: string,
  retryable: boolean,
) {
  await failBusinessQueueEvent(prisma, {
    ...leaseIdentity,
    failureCode,
    retryable,
  });
}

export async function projectClaimedLeadInboxEvent(
  prisma: PrismaClient,
  leaseIdentity: BusinessQueueLeaseIdentity,
  options: ProjectClaimedLeadInboxEventOptions = {},
) {
  if (leaseIdentity.queueKind !== 'INBOX') {
    throw new BusinessEventBackboneError('BUSINESS_QUEUE_LEASE_STALE');
  }
  let key: LeadIdentityKeyFile;
  try {
    key = await readLeadIdentityKeyFile(options.keyFilePath, {
      allowedRoot: options.allowedSecretRoot,
    });
  } catch (error) {
    const classified = projectionError(error);
    if (!classified) throw error;
    await recordProjectionFailure(prisma, leaseIdentity, classified.code, true);
    throw classified;
  }
  try {
    return await processClaimedBusinessInboxEventInTransaction(
      prisma,
      leaseIdentity,
      (context) => projectInTransaction(context, key, options),
    );
  } catch (error) {
    if (error instanceof BusinessEventBackboneError) {
      if (error.code === 'BUSINESS_QUEUE_DATABASE_CONFLICT') {
        await recordProjectionFailure(prisma, leaseIdentity, error.code, true);
      }
      throw error;
    }
    const classified = projectionError(error)
      ?? new LeadProjectionError('N13_PROJECTION_INVARIANT_FAILURE');
    await recordProjectionFailure(
      prisma,
      leaseIdentity,
      classified.code,
      classified.code !== 'N13_PROJECTION_INVARIANT_FAILURE',
    );
    throw classified;
  }
}
