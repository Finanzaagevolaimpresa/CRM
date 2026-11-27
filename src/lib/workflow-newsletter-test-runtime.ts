import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { assertSyntheticCatalogDatabase } from './service-catalog-v2-persistence';
import { PostgresPreferenceStore } from './marketing-preferences/postgres-store';
import { MarketingPreferences, type PreferenceTransaction } from './marketing-preferences/service';
import { PROPOSED_POLICY, type Readiness } from './marketing-preferences/policy';
import { syntheticNewsletterTransport, type NewsletterRuntime, type NewsletterTransportResult } from './workflow-newsletters';

/** Public, fixed test material, not a provisioned application credential. */
export const SYNTHETIC_NEWSLETTER_KEY = Buffer.alloc(32, 91);

/** This qualified boundary is restricted to local DB-only tests. The underlying
 * transaction cannot fence an external provider, so this class is not exported
 * as a production marketing store and no real transport is accepted here. */
class SyntheticDatabasePreferenceStore extends PostgresPreferenceStore {
  withFinalHandoff<T>(contactKey: string, operation: (tx: PreferenceTransaction) => Promise<T>) {
    return this.withContact(contactKey, operation);
  }
}

export async function createSyntheticNewsletterRuntime(db: PrismaClient, outcome: NewsletterTransportResult['outcome'] = 'SENT', qualifiedDatabaseHandoff = true): Promise<NewsletterRuntime> {
  if (process.env.APP_ENV !== 'test') throw new Error('NEWSLETTER_SYNTHETIC_ONLY');
  await assertSyntheticCatalogDatabase(db);
  const readiness = async (): Promise<Readiness | null> => {
    const [state] = await db.$queryRaw<Array<{ epoch: string; reconciled: boolean }>>`SELECT epoch,reconciled FROM "MarketingPreferenceEpoch" WHERE singleton=true`;
    if (!state?.reconciled) return null;
    const notices = await db.privacyNoticeVersion.findMany({ where: { noticeCode: { startsWith: 'FLOW_MARKETING_' }, status: 'ACTIVE' },
      select: { id: true, contentHash: true } });
    if (!notices.length) return null;
    const now = new Date(), tomorrow = new Date(now.getTime() + 86_400_000);
    return { policyVersion: PROPOSED_POLICY.version, approvalReference: 'SYNTHETIC_TEST_APPROVAL_ONLY',
      effectiveFrom: new Date(now.getTime() - 60_000).toISOString(), effectiveUntil: tomorrow.toISOString(), checkedAt: now.toISOString(),
      purposeOpen: true, reconciled: true, epoch: state.epoch,
      keyFingerprint: createHash('sha256').update(SYNTHETIC_NEWSLETTER_KEY).digest('hex'), maxTicketAgeMs: 60_000,
      approvedEmailNotices: notices.map(row => ({ noticeVersionId: row.id, contentHash: row.contentHash })) };
  };
  return { synthetic: true, preferences: new MarketingPreferences(qualifiedDatabaseHandoff ? new SyntheticDatabasePreferenceStore(db) : new PostgresPreferenceStore(db), SYNTHETIC_NEWSLETTER_KEY, readiness),
    unsubscribeUrl: 'https://example.test/preferenze-email/', qualificationReference: 'SYNTHETIC_NEWSLETTER_DB_V1',
    policyReference: 'SYNTHETIC_TEST_APPROVAL_ONLY',
    transport: syntheticNewsletterTransport(outcome) };
}
