import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { Prisma, type PrismaClient } from '@prisma/client';
import { canonicalSha256 } from '../src/lib/canonical-json';
import { createLeadSubmittedEventV1 } from '../src/lib/lead-event-contract';
import { BUSINESS_LEAD_PRIVACY_EVIDENCE_HASH_DOMAIN } from '../src/lib/privacy-evidence';
import { PostgresPreferenceStore } from '../src/lib/marketing-preferences/postgres-store';
import { SerializableConflictError } from '../src/lib/serializable';
import { syntheticLeadEventInputV1 } from './fixtures/n10-lead-event-v1';
import { id, SYNTHETIC_EMAIL, SYNTHETIC_NOTICE } from './fixtures/r13-marketing-store';

function receipt(decision: 'GRANTED' | 'DENIED' = 'GRANTED') {
  const input = syntheticLeadEventInputV1();
  const envelope = createLeadSubmittedEventV1({ ...input,
    privacy: { ...input.privacy, marketing: { ...input.privacy.marketing, decision } },
    payload: { ...input.payload, email: SYNTHETIC_EMAIL },
  });
  const row = {
    id: id(1), businessInboxEventId: id(800), noticeVersionId: id(900), catalogVersion: 'n04-v1',
    purposeCode: 'DIRECT_MARKETING', legalBasisCode: 'CONSENT', evidenceKind: 'CONSENT', decision,
    sourceSubmittedAt: new Date(envelope.occurredAt), sourceSystem: envelope.source.systemCode,
    formCode: envelope.source.formCode, formVersion: envelope.source.formVersion,
    sourceEvidenceDigest: envelope.idempotency.payloadHash, payloadHash: envelope.idempotency.payloadHash,
    noticeCode: envelope.privacy.marketing.noticeCode, noticeVersion: envelope.privacy.marketing.noticeVersion,
    contentHash: createHash('sha256').update(SYNTHETIC_NOTICE).digest('hex'),
    effectiveFrom: new Date('2026-01-01T00:00:00.000Z'), retiredAt: null as Date | null, status: 'ACTIVE',
    envelopeJson: JSON.stringify(envelope), evidenceHash: '',
  };
  row.evidenceHash = canonicalSha256({
    domain: BUSINESS_LEAD_PRIVACY_EVIDENCE_HASH_DOMAIN, businessInboxEventId: row.businessInboxEventId,
    catalogVersion: row.catalogVersion, decision: row.decision, evidenceKind: row.evidenceKind,
    formCode: row.formCode, formVersion: row.formVersion, legalBasisCode: row.legalBasisCode,
    noticeVersionId: row.noticeVersionId, purposeCode: row.purposeCode,
    sourceEvidenceDigest: row.sourceEvidenceDigest, sourceSubmittedAt: envelope.occurredAt, sourceSystem: row.sourceSystem,
  });
  return row;
}
function storeFor(row: ReturnType<typeof receipt> | null) {
  return new PostgresPreferenceStore({ $queryRaw: async () => row ? [row] : [] } as unknown as PrismaClient);
}

test('PostgreSQL adapter binds a choice to the original immutable envelope and full notice', async () => {
  for (const decision of ['GRANTED', 'DENIED'] as const) {
    const row = receipt(decision);
    const verified = await storeFor(row).verifiedChoice(id(1), SYNTHETIC_NOTICE);
    assert.equal(verified.email, SYNTHETIC_EMAIL); assert.equal(verified.kind, decision);
    assert.equal(verified.occurredAt, row.sourceSubmittedAt.toISOString());
    assert.equal(verified.canonicalNoticeText, SYNTHETIC_NOTICE);
  }
});

test('receipt, source envelope, decision, source time and canonical notice tampering are denied', async () => {
  const mutations: Array<(row: ReturnType<typeof receipt>) => void> = [
    row => { row.evidenceHash = '0'.repeat(64); },
    row => { row.sourceEvidenceDigest = '0'.repeat(64); },
    row => { row.payloadHash = '0'.repeat(64); },
    row => { row.noticeCode = 'OTHER_NOTICE'; },
    row => { row.noticeVersion = 'different'; },
    row => { row.contentHash = '0'.repeat(64); },
    row => { row.sourceSubmittedAt = new Date('2026-08-20T00:00:00.000Z'); },
    row => { row.decision = 'DENIED'; },
    row => { row.status = 'DRAFT'; },
    row => { row.retiredAt = row.sourceSubmittedAt; },
    row => { row.effectiveFrom = new Date('2027-01-01T00:00:00.000Z'); },
    row => { row.envelopeJson = row.envelopeJson.replace(SYNTHETIC_EMAIL, 'different@r13.invalid'); },
  ];
  for (const mutate of mutations) {
    const row = receipt(); mutate(row);
    await assert.rejects(storeFor(row).verifiedChoice(id(1), SYNTHETIC_NOTICE));
  }
  await assert.rejects(storeFor(receipt()).verifiedChoice(id(1), `${SYNTHETIC_NOTICE} altered`));
  await assert.rejects(storeFor(null).verifiedChoice(id(1), SYNTHETIC_NOTICE), /UNAVAILABLE/u);
});

test('retiring a notice after the original consent does not rewrite its history', async () => {
  const row = receipt(); row.status = 'RETIRED'; row.retiredAt = new Date('2026-09-01T00:00:00.000Z');
  assert.equal((await storeFor(row).verifiedChoice(id(1), SYNTHETIC_NOTICE)).kind, 'GRANTED');
});

test('PostgreSQL transactions request serializable isolation and never retry an ambiguous operation', async () => {
  let calls = 0;
  const client = {
    $transaction: async (_callback: unknown, options: unknown) => {
      calls++; assert.deepEqual(options, { isolationLevel: 'Serializable' });
      throw new Prisma.PrismaClientKnownRequestError('synthetic conflict', { code: 'P2034', clientVersion: 'synthetic' });
    },
  } as unknown as PrismaClient;
  await assert.rejects(new PostgresPreferenceStore(client).withContact('unused', async () => undefined), SerializableConflictError);
  assert.equal(calls, 1);
});
