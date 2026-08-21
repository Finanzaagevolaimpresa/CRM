import type { Prisma } from '@prisma/client';
import { canonicalSha256 } from './canonical-json';
import { DATA_CLASSIFICATION_CATALOG_VERSION } from './data-classification';
import type { LeadSubmittedEventV1 } from './lead-event-contract';

export const WEBSITE_LEAD_PRIVACY_PURPOSE = 'SERVICE_REQUEST_FOLLOW_UP' as const;
export const WEBSITE_LEAD_PRIVACY_LEGAL_BASIS = 'PRE_CONTRACTUAL_MEASURES' as const;
export const WEBSITE_LEAD_MARKETING_PURPOSE = 'DIRECT_MARKETING' as const;
export const WEBSITE_LEAD_MARKETING_LEGAL_BASIS = 'CONSENT' as const;
export const BUSINESS_LEAD_PRIVACY_EVIDENCE_HASH_DOMAIN = 'fai.privacy-evidence.business-inbox.v1' as const;

export type WebsiteLeadPrivacyEvidenceInput = Readonly<{
  leadId: string;
  websiteLeadReceiptId: string;
  sourceEvidenceDigest: string;
  sourceSystem: string;
  formCode: string;
  formVersion: string;
  sourceSubmittedAt: Date;
  privacyAccepted: true;
  privacyNoticeCode: string;
  privacyNoticeVersion: string;
  privacyPurposeCode: typeof WEBSITE_LEAD_PRIVACY_PURPOSE;
  privacyLegalBasisCode: typeof WEBSITE_LEAD_PRIVACY_LEGAL_BASIS;
  marketingAccepted: boolean;
  marketingNoticeCode: string;
  marketingNoticeVersion: string;
  marketingPurposeCode: typeof WEBSITE_LEAD_MARKETING_PURPOSE;
  marketingLegalBasisCode: typeof WEBSITE_LEAD_MARKETING_LEGAL_BASIS;
}>;

export type BusinessLeadPrivacyEvidenceInput = Readonly<{
  businessInboxEventId: string;
  event: LeadSubmittedEventV1;
}>;

export class PrivacyContractUnavailableError extends Error {
  constructor() {
    super('Privacy contract unavailable');
    this.name = 'PrivacyContractUnavailableError';
  }
}

function activeAt(sourceSubmittedAt: Date) {
  return {
    status: 'ACTIVE' as const,
    effectiveFrom: { lte: sourceSubmittedAt },
    OR: [{ retiredAt: null }, { retiredAt: { gt: sourceSubmittedAt } }],
  };
}

export async function createWebsiteLeadPrivacyEvidence(
  tx: Prisma.TransactionClient,
  input: WebsiteLeadPrivacyEvidenceInput,
) {
  const [privacyNotice, marketingNotice] = await Promise.all([
    tx.privacyNoticeVersion.findFirst({
      where: {
        noticeCode: input.privacyNoticeCode,
        noticeVersion: input.privacyNoticeVersion,
        purposeCode: input.privacyPurposeCode,
        legalBasisCode: input.privacyLegalBasisCode,
        evidenceKind: 'NOTICE_ACKNOWLEDGEMENT',
        ...activeAt(input.sourceSubmittedAt),
      },
      select: { id: true },
    }),
    tx.privacyNoticeVersion.findFirst({
      where: {
        noticeCode: input.marketingNoticeCode,
        noticeVersion: input.marketingNoticeVersion,
        purposeCode: input.marketingPurposeCode,
        legalBasisCode: input.marketingLegalBasisCode,
        evidenceKind: 'CONSENT',
        ...activeAt(input.sourceSubmittedAt),
      },
      select: { id: true },
    }),
  ]);
  if (!privacyNotice || !marketingNotice) throw new PrivacyContractUnavailableError();

  const shared = {
    leadId: input.leadId,
    websiteLeadReceiptId: input.websiteLeadReceiptId,
    catalogVersion: DATA_CLASSIFICATION_CATALOG_VERSION,
    sourceSystem: input.sourceSystem,
    formCode: input.formCode,
    formVersion: input.formVersion,
    sourceSubmittedAt: input.sourceSubmittedAt,
    sourceEvidenceDigest: input.sourceEvidenceDigest,
  };
  const rows = [
    {
      ...shared,
      noticeVersionId: privacyNotice.id,
      purposeCode: input.privacyPurposeCode,
      legalBasisCode: input.privacyLegalBasisCode,
      evidenceKind: 'NOTICE_ACKNOWLEDGEMENT' as const,
      decision: 'ACKNOWLEDGED' as const,
    },
    {
      ...shared,
      noticeVersionId: marketingNotice.id,
      purposeCode: input.marketingPurposeCode,
      legalBasisCode: input.marketingLegalBasisCode,
      evidenceKind: 'CONSENT' as const,
      decision: input.marketingAccepted ? 'GRANTED' as const : 'DENIED' as const,
    },
  ].map((row) => ({
    ...row,
    evidenceHash: canonicalSha256({
      catalogVersion: row.catalogVersion,
      evidenceKind: row.evidenceKind,
      decision: row.decision,
      formCode: row.formCode,
      formVersion: row.formVersion,
      leadId: row.leadId,
      legalBasisCode: row.legalBasisCode,
      noticeVersionId: row.noticeVersionId,
      purposeCode: row.purposeCode,
      sourceEvidenceDigest: row.sourceEvidenceDigest,
      sourceSubmittedAt: row.sourceSubmittedAt.toISOString(),
      sourceSystem: row.sourceSystem,
      websiteLeadReceiptId: row.websiteLeadReceiptId,
    }),
  }));

  const created = await tx.privacyEvidenceReceipt.createMany({ data: rows });
  if (created.count !== 2) throw new PrivacyContractUnavailableError();
  return { count: created.count, evidenceHashes: rows.map(({ evidenceHash }) => evidenceHash) };
}

export async function createBusinessLeadPrivacyEvidence(
  tx: Prisma.TransactionClient,
  input: BusinessLeadPrivacyEvidenceInput,
) {
  const sourceSubmittedAt = new Date(input.event.occurredAt);
  if (!Number.isFinite(sourceSubmittedAt.getTime())) throw new PrivacyContractUnavailableError();
  const service = input.event.privacy.service;
  const marketing = input.event.privacy.marketing;
  const [serviceNotice, marketingNotice] = await Promise.all([
    tx.privacyNoticeVersion.findFirst({
      where: {
        noticeCode: service.noticeCode,
        noticeVersion: service.noticeVersion,
        purposeCode: service.purposeCode,
        legalBasisCode: service.legalBasisCode,
        evidenceKind: 'NOTICE_ACKNOWLEDGEMENT',
        ...activeAt(sourceSubmittedAt),
      },
      select: { id: true },
    }),
    tx.privacyNoticeVersion.findFirst({
      where: {
        noticeCode: marketing.noticeCode,
        noticeVersion: marketing.noticeVersion,
        purposeCode: marketing.purposeCode,
        legalBasisCode: marketing.legalBasisCode,
        evidenceKind: 'CONSENT',
        ...activeAt(sourceSubmittedAt),
      },
      select: { id: true },
    }),
  ]);
  if (!serviceNotice || !marketingNotice) throw new PrivacyContractUnavailableError();

  const shared = {
    leadId: null,
    websiteLeadReceiptId: null,
    businessInboxEventId: input.businessInboxEventId,
    catalogVersion: DATA_CLASSIFICATION_CATALOG_VERSION,
    sourceSystem: input.event.source.systemCode,
    formCode: input.event.source.formCode,
    formVersion: input.event.source.formVersion,
    sourceSubmittedAt,
    sourceEvidenceDigest: input.event.idempotency.payloadHash,
  };
  const rows = [
    {
      ...shared,
      noticeVersionId: serviceNotice.id,
      purposeCode: service.purposeCode,
      legalBasisCode: service.legalBasisCode,
      evidenceKind: 'NOTICE_ACKNOWLEDGEMENT' as const,
      decision: 'ACKNOWLEDGED' as const,
    },
    {
      ...shared,
      noticeVersionId: marketingNotice.id,
      purposeCode: marketing.purposeCode,
      legalBasisCode: marketing.legalBasisCode,
      evidenceKind: 'CONSENT' as const,
      decision: marketing.decision === 'GRANTED' ? 'GRANTED' as const : 'DENIED' as const,
    },
  ].map((row) => ({
    ...row,
    evidenceHash: canonicalSha256({
      domain: BUSINESS_LEAD_PRIVACY_EVIDENCE_HASH_DOMAIN,
      businessInboxEventId: row.businessInboxEventId,
      catalogVersion: row.catalogVersion,
      decision: row.decision,
      evidenceKind: row.evidenceKind,
      formCode: row.formCode,
      formVersion: row.formVersion,
      legalBasisCode: row.legalBasisCode,
      noticeVersionId: row.noticeVersionId,
      purposeCode: row.purposeCode,
      sourceEvidenceDigest: row.sourceEvidenceDigest,
      sourceSubmittedAt: row.sourceSubmittedAt.toISOString(),
      sourceSystem: row.sourceSystem,
    }),
  }));

  const created = await tx.privacyEvidenceReceipt.createMany({ data: rows });
  if (created.count !== 2) throw new PrivacyContractUnavailableError();
  return { count: created.count, evidenceHashes: rows.map(({ evidenceHash }) => evidenceHash) };
}
