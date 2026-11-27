import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { PostgresPreferenceStore } from './marketing-preferences/postgres-store';
import { MarketingPreferences, type PreferenceTransaction } from './marketing-preferences/service';
import { createWithdrawalPost, type WithdrawalRuntime } from './marketing-preferences/withdrawal-http';
import { readNewsletterWithdrawalCredential } from './workflow-newsletter-policy';

export const withdrawalBudgetNamespace = 'marketing-withdrawal:public:v1';
export const withdrawalBudgetLimit = 300;
type CredentialSource = typeof readNewsletterWithdrawalCredential;

/** One bounded, shared bucket. No address, IP or token is recorded here; the
 * namespace is separate from website intake and its admission counters. */
export async function consumeWithdrawalBudget(db: PrismaClient) {
  const rows = await db.$queryRaw<Array<{ requestCount: number }>>`
    INSERT INTO "WebsiteLeadRateLimitBucket" (namespace,"callerDigest","windowStartedAt","requestCount","updatedAt")
    VALUES (${withdrawalBudgetNamespace},'public-marketing-withdrawal',timezone('UTC',clock_timestamp()),1,timezone('UTC',clock_timestamp()))
    ON CONFLICT (namespace) DO UPDATE SET
      "requestCount" = CASE WHEN "WebsiteLeadRateLimitBucket"."windowStartedAt" + interval '1 minute' <= EXCLUDED."updatedAt"
        THEN 1 ELSE LEAST("WebsiteLeadRateLimitBucket"."requestCount" + 1,${withdrawalBudgetLimit + 1}) END,
      "windowStartedAt" = CASE WHEN "WebsiteLeadRateLimitBucket"."windowStartedAt" + interval '1 minute' <= EXCLUDED."updatedAt"
        THEN EXCLUDED."updatedAt" ELSE "WebsiteLeadRateLimitBucket"."windowStartedAt" END,
      "updatedAt" = EXCLUDED."updatedAt"
    RETURNING "requestCount"`;
  return rows.length === 1 && rows[0].requestCount <= withdrawalBudgetLimit;
}

/** This store can only persist suppression. It provides no sender handoff.
 * An epoch mismatch cannot write a seemingly valid receipt under another key. */
class WithdrawalStore extends PostgresPreferenceStore {
  constructor(db: PrismaClient, private readonly epoch: string) { super(db); }
  withContact<T>(contactKey: string, operation: (tx: PreferenceTransaction) => Promise<T>) {
    return super.withContact(contactKey, async tx => {
      if ((await tx.snapshot()).epoch !== this.epoch) throw new Error('WITHDRAWAL_EPOCH_UNAVAILABLE');
      return operation(tx);
    });
  }
}

async function withdrawalRuntime(db: PrismaClient, source: CredentialSource): Promise<WithdrawalRuntime | null> {
  try {
    if (process.env.WORKFLOW_MARKETING_WITHDRAWAL_MODE !== 'enabled') return null;
    const credential = await source();
    const origin = new URL(credential.publicOrigin);
    if (origin.protocol !== 'https:' || origin.origin !== credential.publicOrigin
      || credential.unsubscribeUrl !== origin.origin + '/preferenze-email') return null;
    const epochs = await db.$queryRaw<Array<{ epoch: string }>>`
      SELECT epoch FROM "MarketingPreferenceEpoch" WHERE singleton=true AND reconciled=true`;
    if (epochs.length !== 1 || epochs[0].epoch !== credential.epoch) return null;
    return { publicOrigin: origin.origin,
      service: new MarketingPreferences(new WithdrawalStore(db, credential.epoch), credential.key, async () => null),
      admitRequest: async () => consumeWithdrawalBudget(db) };
  } catch { return null; }
}

const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" };
const unavailable = () => new Response('<!doctype html><html lang="it"><title>Preferenze email</title><main><h1>Preferenze email</h1><p>Servizio temporaneamente non disponibile. Riprova più tardi.</p></main></html>', { status: 503, headers });

/** Server composition only. HTTP callers cannot supply credentials or policy.
 * Default-off handlers neither provision an epoch nor enable an email channel. */
export function marketingWithdrawalHandlers(db: PrismaClient, source: CredentialSource = readNewsletterWithdrawalCredential) {
  return {
    async GET(request: Request) {
      const runtime = await withdrawalRuntime(db, source);
      if (!runtime) return unavailable();
      if (new URL(request.url).origin !== runtime.publicOrigin) return new Response(null, { status: 403, headers });
      return new Response(`<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Preferenze email</title></head><body><main><h1>Preferenze email</h1><p>Indica l’indirizzo per cui vuoi interrompere le email promozionali sui servizi FAI.</p><form method="post" action="/preferenze-email"><input type="hidden" name="requestId" value="${randomUUID()}"><label for="email">Indirizzo email</label><input id="email" name="email" type="email" autocomplete="email" maxlength="254" required><button type="submit">Non inviarmi più email promozionali</button></form></main></body></html>`, { status: 200, headers });
    },
    async POST(request: Request) {
      return createWithdrawalPost(await withdrawalRuntime(db, source))(request);
    },
  };
}
