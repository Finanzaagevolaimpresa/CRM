import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { parseLeadSubmittedEventV1 } from '../lead-event-contract';
import { withSerializableTransaction } from '../serializable';
import { canonicalSha256 } from '../canonical-json';
import { BUSINESS_LEAD_PRIVACY_EVIDENCE_HASH_DOMAIN } from '../privacy-evidence';
import { eventHash, eventSchema, type PreferenceEvent } from './policy';
import type { PreferenceStore, PreferenceTransaction, VerifiedChoice } from './service';

type ReceiptRow = {
  id: string; businessInboxEventId: string; catalogVersion: string;
  sourceSubmittedAt: Date; sourceEvidenceDigest: string; evidenceHash: string;
  sourceSystem: string; formCode: string; formVersion: string;
  purposeCode: string; legalBasisCode: string; evidenceKind: string; decision: string;
  noticeVersionId: string; noticeCode: string; noticeVersion: string; contentHash: string;
  effectiveFrom: Date | null; retiredAt: Date | null; status: string;
  envelopeJson: string; payloadHash: string;
};

/** Separate additive tables only. Nothing here rewrites a lead or an N04 receipt. */
export class PostgresPreferenceStore implements PreferenceStore {
  constructor(private readonly db: PrismaClient) {}

  async verifiedChoice(receiptId: string, canonicalNoticeText: string): Promise<VerifiedChoice> {
    // The legacy receipt has no immutable original email. Do not bind it to a mutable Lead.email.
    const rows = await this.db.$queryRaw<ReceiptRow[]>(Prisma.sql`
      SELECT evidence.*, notice."noticeCode", notice."noticeVersion", notice."contentHash",
        notice."effectiveFrom", notice."retiredAt", notice."status", inbox."envelopeJson", inbox."payloadHash"
      FROM "PrivacyEvidenceReceipt" evidence
      JOIN "PrivacyNoticeVersion" notice ON notice."id" = evidence."noticeVersionId"
      JOIN "BusinessInboxEvent" inbox ON inbox."id" = evidence."businessInboxEventId"
      WHERE evidence."id" = ${receiptId}::UUID
        AND evidence."purposeCode" = 'DIRECT_MARKETING' AND evidence."legalBasisCode" = 'CONSENT'
        AND evidence."evidenceKind" = 'CONSENT' AND evidence."decision" IN ('GRANTED', 'DENIED')
        AND notice."purposeCode" = evidence."purposeCode" AND notice."legalBasisCode" = evidence."legalBasisCode"
        AND notice."evidenceKind" = evidence."evidenceKind"
    `);
    const row = rows[0];
    if (!row || rows.length !== 1) throw new Error('MARKETING_RECEIPT_UNAVAILABLE');
    const envelope = parseLeadSubmittedEventV1(JSON.parse(row.envelopeJson));
    const marketing = envelope.privacy.marketing;
    const occurredAt = row.sourceSubmittedAt.toISOString();
    const expectedHash = canonicalSha256({
      domain: BUSINESS_LEAD_PRIVACY_EVIDENCE_HASH_DOMAIN, businessInboxEventId: row.businessInboxEventId,
      catalogVersion: row.catalogVersion, decision: row.decision, evidenceKind: row.evidenceKind,
      formCode: row.formCode, formVersion: row.formVersion, legalBasisCode: row.legalBasisCode,
      noticeVersionId: row.noticeVersionId, purposeCode: row.purposeCode,
      sourceEvidenceDigest: row.sourceEvidenceDigest, sourceSubmittedAt: occurredAt, sourceSystem: row.sourceSystem,
    });
    if (envelope.idempotency.payloadHash !== row.payloadHash || row.payloadHash !== row.sourceEvidenceDigest
      || expectedHash !== row.evidenceHash || envelope.occurredAt !== occurredAt
      || envelope.source.systemCode !== row.sourceSystem || envelope.source.formCode !== row.formCode
      || envelope.source.formVersion !== row.formVersion || marketing.decision !== row.decision
      || marketing.noticeCode !== row.noticeCode || marketing.noticeVersion !== row.noticeVersion
      || row.status === 'DRAFT' || !row.effectiveFrom || row.effectiveFrom > row.sourceSubmittedAt
      || (row.retiredAt !== null && row.retiredAt <= row.sourceSubmittedAt)
      || createHash('sha256').update(canonicalNoticeText, 'utf8').digest('hex') !== row.contentHash
      || !envelope.payload.email) {
      throw new Error('MARKETING_RECEIPT_BINDING_INVALID');
    }
    return { receiptId: row.id, noticeVersionId: row.noticeVersionId, noticeHash: row.contentHash,
      canonicalNoticeText, email: envelope.payload.email, occurredAt, kind: row.decision as 'GRANTED' | 'DENIED' };
  }

  async withContact<T>(contactKey: string, operation: (tx: PreferenceTransaction) => Promise<T>): Promise<T> {
    return withSerializableTransaction(this.db, async db => {
      await db.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${contactKey}, 1300))`);
      await db.$executeRaw(Prisma.sql`
        INSERT INTO "MarketingPreferenceSubject" ("contactKey") VALUES (${contactKey}) ON CONFLICT DO NOTHING
      `);
      await db.$queryRaw(Prisma.sql`SELECT "contactKey" FROM "MarketingPreferenceSubject" WHERE "contactKey" = ${contactKey} FOR UPDATE`);
      const tx: PreferenceTransaction = {
        now: async () => {
          const [row] = await db.$queryRaw<Array<{ now: Date }>>(Prisma.sql`SELECT date_trunc('milliseconds', clock_timestamp()) AS "now"`);
          return row.now.toISOString();
        },
        snapshot: async () => {
          const [state] = await db.$queryRaw<Array<{ revision: number; quarantined: boolean }>>(Prisma.sql`
            SELECT "revision", "quarantined" FROM "MarketingPreferenceSubject" WHERE "contactKey" = ${contactKey}
          `);
          const [fence] = await db.$queryRaw<Array<{ epoch: string }>>(Prisma.sql`
            SELECT "epoch" FROM "MarketingPreferenceEpoch" WHERE "singleton" = true AND "reconciled" = true FOR SHARE
          `);
          const rows = await db.$queryRaw<Array<{ payload: PreferenceEvent; eventHash: string; recordedAt: Date }>>(Prisma.sql`
            SELECT "payload", "eventHash", "recordedAt" FROM "MarketingPreferenceEvent" WHERE "contactKey" = ${contactKey}
          `);
          if (!state) throw new Error('MARKETING_STATE_UNAVAILABLE');
          return { contactKey, ...state, epoch: fence?.epoch ?? null,
            events: rows.map(row => ({ ...eventSchema.parse(row.payload), eventHash: row.eventHash, recordedAt: row.recordedAt.toISOString() })) };
        },
        append: async event => {
          await db.$executeRaw(Prisma.sql`
            INSERT INTO "MarketingPreferenceEvent" ("contactKey", "eventId", "payload", "eventHash")
            VALUES (${contactKey}, ${event.eventId}::UUID, ${JSON.stringify(event)}::JSONB, ${eventHash(event)})
          `);
        },
        quarantine: async () => {
          await db.$executeRaw(Prisma.sql`
            UPDATE "MarketingPreferenceSubject" SET "quarantined" = true WHERE "contactKey" = ${contactKey}
          `);
        },
      };
      return operation(tx);
    });
  }
}
