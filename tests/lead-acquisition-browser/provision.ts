import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity, assertAiOrchestratorEphemeralDbTestConfiguration } from '../db/ai-orchestrator-db-test-guard';
import { admitBusinessInboxEvent, claimBusinessQueueEvent, failBusinessQueueEvent } from '../../src/lib/business-event-backbone';
import { createLeadSubmittedEventV1 } from '../../src/lib/lead-event-contract';
import { projectClaimedLeadInboxEvent } from '../../src/lib/lead-projection';
import { resolveLeadDuplicateCase } from '../../src/lib/lead-duplicate-resolution';
import { calculateLeadIdentityKeyDigest, LEAD_NORMALIZATION_VERSION } from '../../src/lib/lead-identity';
import { revokeInternalSession } from '../../src/lib/internal-session-registry';
import { syntheticLeadEventInputV1 } from '../fixtures/n10-lead-event-v1';
import { N13_SYNTHETIC_KEY_SECRET } from '../fixtures/n13-lead-projection-v1';

const db = new PrismaClient();
async function main() {
  assert.equal(process.env.M3_BROWSER_CONFIRMED, '1');
  assert.equal(assertAiOrchestratorEphemeralDbTestConfiguration({ requested: process.env.RUN_DB_TESTS === '1',
    destructiveConfirmed: process.env.AI_ORCHESTRATOR_DB_TESTS_CONFIRMED === '1', databaseUrl: process.env.DATABASE_URL,
    sentinel: process.env.AI_ORCHESTRATOR_DB_TEST_SENTINEL, appEnvironment: process.env.APP_ENV, nodeEnvironment: process.env.NODE_ENV }), true);
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  assert.equal(await db.user.count(), 0);
  const password = process.env.M3_BROWSER_PASSWORD!;
  const evidence = process.env.M3_BROWSER_EVIDENCE!;
  assert.ok(password?.length >= 24 && evidence);
  mkdirSync(evidence, { recursive: true });
  const passwordHash = await bcrypt.hash(password, 10);
  const admin = await db.user.create({ data: { name: 'Synthetic M3 Admin', email: 'm3-admin@invalid.test', role: 'admin', passwordHash, active: true } });
  const reader = await db.user.create({ data: { name: 'Synthetic M3 Operator', email: 'm3-operator@invalid.test', role: 'commerciale', passwordHash, active: true } });
  const session = await db.internalSession.create({ data: { id: randomUUID(), userId: admin.id, tokenDigest: Buffer.alloc(32, 73), expiresAt: new Date(Date.now() + 3_600_000) } });
  await db.privacyNoticeVersion.createMany({ data: [
    { noticeCode: 'SYNTHETIC_PRIVACY_NOTICE', noticeVersion: 'v1', purposeCode: 'SERVICE_REQUEST_FOLLOW_UP', legalBasisCode: 'PRE_CONTRACTUAL_MEASURES', evidenceKind: 'NOTICE_ACKNOWLEDGEMENT', contentHash: '1'.repeat(64) },
    { noticeCode: 'SYNTHETIC_MARKETING_NOTICE', noticeVersion: 'v1', purposeCode: 'DIRECT_MARKETING', legalBasisCode: 'CONSENT', evidenceKind: 'CONSENT', contentHash: '2'.repeat(64) },
  ] });
  await db.privacyNoticeVersion.updateMany({ where: { status: 'DRAFT' }, data: { status: 'ACTIVE', effectiveFrom: new Date('2026-01-01T00:00:00Z') } });
  const key = await db.leadIdentityKeyVersion.create({ data: { normalizationVersion: LEAD_NORMALIZATION_VERSION, version: 7,
    keyDigest: calculateLeadIdentityKeyDigest(N13_SYNTHETIC_KEY_SECRET), createdById: admin.id } });
  await db.leadIdentityKeyVersion.update({ where: { id: key.id }, data: { status: 'ACTIVE', activatedAt: new Date() } });
  const keyFilePath = join(evidence, 'synthetic-identity.json');
  writeFileSync(keyFilePath, JSON.stringify({ version: 7, secretBase64: N13_SYNTHETIC_KEY_SECRET.toString('base64') }), { mode: 0o600 });
  const options = { keyFilePath, allowedSecretRoot: evidence };
  const base = syntheticLeadEventInputV1();
  let leadId = '';
  for (let i = 1; i <= 3; i += 1) {
    const event = createLeadSubmittedEventV1({ ...base, eventId: randomUUID(), businessCorrelationId: randomUUID(),
      source: { ...base.source, formCode: 'M3_BROWSER_SYNTHETIC', submissionId: `M3-BROWSER-${i}` },
      payload: { ...base.payload, campaignCode: `M3-CAMPAIGN-${i}`, adCode: `AD-${i}`, message: `Richiesta sintetica M3 numero ${i}` } });
    const receipt = await admitBusinessInboxEvent(db, event);
    assert.equal((await admitBusinessInboxEvent(db, event)).outcome, 'REPLAY');
    const lease = await claimBusinessQueueEvent(db, { queueKind: 'INBOX', leaseOwnerId: randomUUID(), inboxEventIds: [receipt.inboxEventId] });
    assert.ok(lease);
    if (i === 3) {
      await failBusinessQueueEvent(db, { ...lease, failureCode: 'M3_SYNTHETIC_RETRY', retryable: true });
      continue;
    }
    const projected = await projectClaimedLeadInboxEvent(db, lease, options);
    if (i === 1) {
      const ledger = await db.leadProjectionLedger.findUniqueOrThrow({ where: { id: projected.result.ledgerId } });
      leadId = ledger.leadId!;
      await db.lead.update({ where: { id: leadId }, data: { assignedToId: reader.id } });
    } else {
      const duplicate = await db.leadDuplicateCase.findUniqueOrThrow({ where: { projectionLedgerId: projected.result.ledgerId } });
      await resolveLeadDuplicateCase(db, { caseId: duplicate.id, expectedCaseVersion: 1, outcome: 'LINK_EXISTING_NO_OVERWRITE',
        selectedLeadId: leadId, reasonCode: 'M3_SYNTHETIC_NEW_REQUEST', actorUserId: admin.id, actorSessionId: session.id }, options);
    }
  }
  await db.$transaction((tx) => revokeInternalSession(tx, session.id, 'INTERNAL_SINGLE', admin.id));
  assert.equal(await db.internalSession.count({ where: { revokedAt: null } }), 0);
  writeFileSync(join(evidence, 'fixture.json'), JSON.stringify({ synthetic: true, leadId, readerId: reader.id }));
  process.stdout.write('M3_SYNTHETIC_BROWSER_READY\n');
}
main().finally(() => db.$disconnect()).catch((error) => { console.error(error); process.exitCode = 1; });
