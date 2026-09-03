import type { PrismaClient } from '@prisma/client';
import { canonicalJson, canonicalSha256 } from './canonical-json';
import {
  BUSINESS_EVENT_BACKBONE_MANIFEST,
  calculateBusinessInboxRecordHash,
} from './business-event-backbone';
import { CORE_QUERY_MAX_CANDIDATES } from './core-query-policy';
import { parseLeadSubmittedEventV1 } from './lead-event-contract';
import { LEAD_PROJECTION_MANIFEST } from './lead-projection';

export class LeadDuplicateReviewIntegrityError extends Error {
  readonly code = 'N13_DUPLICATE_REVIEW_INTEGRITY_FAILURE' as const;

  constructor() {
    super('N13_DUPLICATE_REVIEW_INTEGRITY_FAILURE');
    this.name = 'LeadDuplicateReviewIntegrityError';
  }
}

function integrityFail(): never {
  throw new LeadDuplicateReviewIntegrityError();
}

function exactCurrentCandidates<T extends Readonly<{
  discoveryRevision: number;
  rank: number;
  leadId: string;
  strongestSignal: string;
  strongSignalCount: number;
  weakSignalCount: number;
  matchedSignalCodes: unknown;
  snapshotHash: string;
}>>(
  candidates: readonly T[],
  discoveryRevision: number,
  expectedCount: number,
  sourceRecordHash: string,
) {
  if (expectedCount < 0 || expectedCount > CORE_QUERY_MAX_CANDIDATES) {
    return integrityFail();
  }
  const current = candidates.filter((candidate) => (
    candidate.discoveryRevision === discoveryRevision
  ));
  if (current.length !== expectedCount
    || new Set(current.map(({ leadId }) => leadId)).size !== current.length
    || current.some((candidate, index) => {
      if (candidate.rank !== index + 1
        || !Array.isArray(candidate.matchedSignalCodes)
        || candidate.matchedSignalCodes.some((code) => typeof code !== 'string')) {
        return true;
      }
      return candidate.snapshotHash !== canonicalSha256({
        domain: LEAD_PROJECTION_MANIFEST.candidateHashDomain,
        sourceRecordHash,
        discoveryRevision,
        leadId: candidate.leadId,
        rank: candidate.rank,
        strongestSignal: candidate.strongestSignal,
        strongSignalCount: candidate.strongSignalCount,
        weakSignalCount: candidate.weakSignalCount,
        matchedSignalCodes: candidate.matchedSignalCodes,
      });
    })) {
    return integrityFail();
  }
  return current;
}

export async function listLeadDuplicateReviewCases(
  prisma: PrismaClient,
  input: Readonly<{ skip: number; take: number }>,
) {
  if (!Number.isSafeInteger(input.skip) || input.skip < 0
    || !Number.isSafeInteger(input.take) || input.take < 1 || input.take > 101) {
    return integrityFail();
  }
  const rows = await prisma.leadDuplicateCase.findMany({
    where: {
      state: 'OPEN',
      projectionLedger: {
        state: 'REVIEW_REQUIRED',
        inboxEvent: { state: 'PROCESSED' },
      },
    },
    orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
    skip: input.skip,
    take: input.take,
    select: {
      id: true,
      state: true,
      discoveryRevision: true,
      candidateCount: true,
      version: true,
      projectionLedger: {
        select: {
          state: true,
          candidateCount: true,
          sourceRecordHash: true,
          inboxEvent: {
            select: {
              id: true,
              state: true,
              schemaVersion: true,
              eventType: true,
              eventVersion: true,
              canonicalizationVersion: true,
              eventId: true,
              businessCorrelationId: true,
              occurredAt: true,
              keyDigest: true,
              payloadHash: true,
              envelopeJson: true,
              recordHash: true,
              classificationCatalogVersion: true,
              classificationContractCode: true,
              maxAttempts: true,
              retentionClass: true,
              retentionPolicyVersion: true,
              retentionEligibleAt: true,
              createdAt: true,
            },
          },
        },
      },
      candidates: {
        orderBy: [{ discoveryRevision: 'desc' }, { rank: 'asc' }],
        take: CORE_QUERY_MAX_CANDIDATES + 1,
        select: {
          discoveryRevision: true,
          leadId: true,
          rank: true,
          strongestSignal: true,
          strongSignalCount: true,
          weakSignalCount: true,
          matchedSignalCodes: true,
          snapshotHash: true,
          lead: {
            select: {
              firstName: true,
              lastName: true,
              companyName: true,
              email: true,
              phone: true,
              createdAt: true,
              deletedAt: true,
            },
          },
        },
      },
      decisions: {
        orderBy: { sequence: 'desc' },
        take: 1,
        select: { outcome: true, reasonCode: true, createdAt: true },
      },
    },
  });

  return rows.map((row) => {
    if (row.state !== 'OPEN'
      || row.projectionLedger.state !== 'REVIEW_REQUIRED'
      || row.projectionLedger.candidateCount !== row.candidateCount) {
      return integrityFail();
    }
    const inbox = row.projectionLedger.inboxEvent;
    let event: ReturnType<typeof parseLeadSubmittedEventV1>;
    try {
      event = parseLeadSubmittedEventV1(JSON.parse(inbox.envelopeJson));
      const expectedRecordHash = calculateBusinessInboxRecordHash(
        inbox.id,
        event,
        inbox.createdAt,
      );
      if (expectedRecordHash !== inbox.recordHash
        || expectedRecordHash !== row.projectionLedger.sourceRecordHash
        || canonicalJson(event) !== inbox.envelopeJson
        || inbox.state !== 'PROCESSED'
        || event.schemaVersion !== inbox.schemaVersion
        || event.eventType !== inbox.eventType
        || event.eventVersion !== inbox.eventVersion
        || event.idempotency.canonicalizationVersion !== inbox.canonicalizationVersion
        || event.eventId !== inbox.eventId
        || event.businessCorrelationId !== inbox.businessCorrelationId
        || event.occurredAt !== inbox.occurredAt
        || event.idempotency.keyDigest !== inbox.keyDigest
        || event.idempotency.payloadHash !== inbox.payloadHash
        || inbox.classificationCatalogVersion
          !== BUSINESS_EVENT_BACKBONE_MANIFEST.classificationCatalogVersion
        || inbox.classificationContractCode
          !== BUSINESS_EVENT_BACKBONE_MANIFEST.classificationContractCode
        || inbox.maxAttempts !== BUSINESS_EVENT_BACKBONE_MANIFEST.maxAttempts
        || inbox.retentionClass !== BUSINESS_EVENT_BACKBONE_MANIFEST.retentionClass
        || inbox.retentionPolicyVersion
          !== BUSINESS_EVENT_BACKBONE_MANIFEST.retentionPolicyVersion
        || inbox.retentionEligibleAt !== null) {
        return integrityFail();
      }
    } catch {
      return integrityFail();
    }
    const candidates = exactCurrentCandidates(
      row.candidates,
      row.discoveryRevision,
      row.candidateCount,
      row.projectionLedger.sourceRecordHash,
    );
    return Object.freeze({
      caseId: row.id,
      caseVersion: row.version,
      discoveryRevision: row.discoveryRevision,
      candidateCount: row.candidateCount,
      incoming: Object.freeze({
        occurredAt: new Date(event.occurredAt),
        sourceSystem: event.source.systemCode,
        formCode: event.source.formCode,
        firstName: event.payload.firstName ?? '',
        lastName: event.payload.lastName ?? '',
        companyName: event.payload.companyName ?? null,
        email: event.payload.email ?? null,
        phone: event.payload.phone ?? null,
      }),
      candidates: Object.freeze(candidates.map((candidate) => Object.freeze({
        leadId: candidate.leadId,
        rank: candidate.rank,
        strongestSignal: candidate.strongestSignal,
        strongSignalCount: candidate.strongSignalCount,
        weakSignalCount: candidate.weakSignalCount,
        selectable: candidate.lead.deletedAt === null,
        lead: Object.freeze({
          firstName: candidate.lead.firstName,
          lastName: candidate.lead.lastName,
          companyName: candidate.lead.companyName,
          email: candidate.lead.email,
          phone: candidate.lead.phone,
          createdAt: candidate.lead.createdAt,
        }),
      }))),
      previousDecision: row.decisions[0]
        ? Object.freeze({ ...row.decisions[0] })
        : null,
    });
  });
}
