import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { canonicalSha256 } from '../../src/lib/canonical-json';
import { createWebsiteLeadPrivacyEvidence } from '../../src/lib/privacy-evidence';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';

export async function adminHistoryFixture(db: PrismaClient, actorId: string) {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  const suffix = randomUUID().replaceAll('-', '').toUpperCase();
  const lead = await db.lead.create({ data: { firstName: 'Fonte', lastName: 'Sintetica',
    email: suffix.toLowerCase() + '@synthetic.invalid' } });
  const source = await db.websiteLeadReceipt.create({ data: { namespace: 'admin-history-synthetic',
    keyDigest: canonicalSha256({ suffix }), payloadHash: canonicalSha256({ suffix, source: true }), status: 'pending' } });
  const codes = ['SYNTHETIC_PRIVACY_' + suffix, 'SYNTHETIC_MARKETING_' + suffix];
  await db.privacyNoticeVersion.createMany({ data: [
    { noticeCode: codes[0], noticeVersion: 'v1', purposeCode: 'SERVICE_REQUEST_FOLLOW_UP',
      legalBasisCode: 'PRE_CONTRACTUAL_MEASURES', evidenceKind: 'NOTICE_ACKNOWLEDGEMENT', contentHash: '1'.repeat(64) },
    { noticeCode: codes[1], noticeVersion: 'v1', purposeCode: 'DIRECT_MARKETING',
      legalBasisCode: 'CONSENT', evidenceKind: 'CONSENT', contentHash: '2'.repeat(64) },
  ] });
  await db.privacyNoticeVersion.updateMany({ where: { noticeCode: { in: codes }, status: 'DRAFT' },
    data: { status: 'ACTIVE', effectiveFrom: new Date('2026-01-01T00:00:00Z') } });
  await db.$transaction(tx => createWebsiteLeadPrivacyEvidence(tx, { leadId: lead.id, websiteLeadReceiptId: source.id,
    sourceEvidenceDigest: source.payloadHash, sourceSystem: 'SYNTHETIC_ADMIN', formCode: 'SYNTHETIC', formVersion: 'v1',
    sourceSubmittedAt: new Date(), privacyAccepted: true, privacyNoticeCode: codes[0], privacyNoticeVersion: 'v1',
    privacyPurposeCode: 'SERVICE_REQUEST_FOLLOW_UP', privacyLegalBasisCode: 'PRE_CONTRACTUAL_MEASURES',
    marketingAccepted: false, marketingNoticeCode: codes[1], marketingNoticeVersion: 'v1',
    marketingPurposeCode: 'DIRECT_MARKETING', marketingLegalBasisCode: 'CONSENT' }));
  const receipt = await db.privacyEvidenceReceipt.findFirstOrThrow({ where: { websiteLeadReceiptId: source.id, purposeCode: 'DIRECT_MARKETING' } });
  const intake = await db.controlledIntake.create({ data: { channel: 'EMAIL', sourceId: 'SYNTHETIC-' + suffix,
    sourceOccurredAt: new Date(), acquisitionMode: 'MANUAL_CONTROLLED', mappingVersion: 'synthetic-admin-history-v1',
    payloadHash: canonicalSha256({ suffix, intake: true }), leadId: lead.id, subjectType: 'PERSONA',
    firstName: 'Fonte', lastName: 'Sintetica', email: lead.email, classificationState: 'VERIFIED',
    effectiveCategory: 'sintetico', need: 'Fonte sintetica immutata', operatorId: actorId } });
  return { lead, receipt, intake };
}
