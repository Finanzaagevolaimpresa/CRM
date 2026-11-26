import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as waitForRateWindow } from 'node:timers/promises';
import type { PrismaClient } from '@prisma/client';
import { NextRequest } from 'next/server';
import { handleSecureLeadGatewayRequest } from '../../src/app/api/integrations/website/leads/v2/route';
import { createSecureLeadGatewaySignature, createSecureLeadGatewaySignedBytes, digestSecureLeadGatewayKey,
  SECURE_LEAD_GATEWAY_PROTOCOL } from '../../src/lib/secure-lead-gateway-protocol';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { syntheticLeadEventInputV1 } from '../fixtures/n10-lead-event-v1';
import { createLeadSubmittedEventV1 } from '../../src/lib/lead-event-contract';
import { admitBusinessInboxEvent, claimBusinessQueueEvent, processClaimedBusinessInboxEventInTransaction } from '../../src/lib/business-event-backbone';
import { calculateLeadIdentityKeyDigest, LEAD_NORMALIZATION_VERSION } from '../../src/lib/lead-identity';
import { mapLeadSubmittedEventToLead, projectClaimedLeadInboxEvent } from '../../src/lib/lead-projection';
import { createBusinessLeadPrivacyEvidence } from '../../src/lib/privacy-evidence';
import { maybeEnrollProjectedCommercialLead } from '../../src/lib/commercial-lead-inbox';
import { canonicalJson, canonicalSha256 } from '../../src/lib/canonical-json';
import { captureWorkflowLeadReceiptAfterCommit } from '../../src/lib/workflow-native-runner';

/** Native authenticated HTTP/HMAC ingress + POSIX identity projection on Linux. On Windows only,
 * the explicitly labelled projection fixture replaces the POSIX key-file step.
 * receipt creation and projection are explicit fixtures because the native key
 * readers require POSIX0600. The gateway is never bypassed on Linux.
 * No product guard or filesystem check is relaxed for these tests. */
export async function syntheticIntakeFixture(db: PrismaClient, actorId: string) {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  assert.equal(process.env.APP_ENV, 'test');
  const keyBytes = Buffer.alloc(32, 87), keyDigest = calculateLeadIdentityKeyDigest(keyBytes);
  let identity = await db.leadIdentityKeyVersion.findFirst({ where: { status: 'ACTIVE' } });
  if (identity && process.platform !== 'win32') assert.equal(identity.keyDigest, keyDigest,
    'This native identity fixture requires its dedicated ephemeral database.');
  if (!identity) {
    const staged = await db.leadIdentityKeyVersion.create({ data: { normalizationVersion: LEAD_NORMALIZATION_VERSION,
      version: 726, keyDigest, createdById: actorId } });
    identity = await db.leadIdentityKeyVersion.update({ where: { id: staged.id }, data: { status: 'ACTIVE', activatedAt: new Date() } });
  }
  const identityId = identity.id, suffix = randomUUID().replaceAll('-', '').toUpperCase();
  const serviceNotice = `FLOW_SERVICE_${suffix}`, marketingNotice = `FLOW_MARKETING_${suffix}`;
  const marketingNoticeText = 'Informativa sintetica FAI: consenso email facoltativo, revocabile. ' + suffix;
  for (const [noticeCode, purposeCode, legalBasisCode, evidenceKind, text] of [
    [serviceNotice, 'SERVICE_REQUEST_FOLLOW_UP', 'PRE_CONTRACTUAL_MEASURES', 'NOTICE_ACKNOWLEDGEMENT', 'Informativa di servizio sintetica ' + suffix],
    [marketingNotice, 'DIRECT_MARKETING', 'CONSENT', 'CONSENT', marketingNoticeText],
  ] as const) {
    const notice = await db.privacyNoticeVersion.create({ data: { noticeCode, noticeVersion: 'v1', purposeCode, legalBasisCode,
      evidenceKind, contentHash: createHash('sha256').update(text).digest('hex') } });
    await db.privacyNoticeVersion.update({ where: { id: notice.id }, data: { status: 'ACTIVE', effectiveFrom: new Date('2026-01-01T00:00:00Z') } });
  }
  if (!await db.commercialLeadSlaPolicyVersion.count({ where: { status: 'ACTIVE' } }))
    await db.commercialLeadSlaPolicyVersion.create({ data: { policyCode: 'COMMERCIAL_FIRST_RESPONSE', version: 1, status: 'ACTIVE',
      calendarCode: 'CONTINUOUS_24X7', timezoneCode: 'UTC', responseTargetSeconds: 3600, createdById: actorId } });
  let keyRoot = '', keyPath = '', keyringPath = '';
  const ingressSecret = Buffer.alloc(32, 93), ingressKeyId = 'flow-' + suffix.toLowerCase(), producerCode = 'SYNTHETIC_FLOW_' + suffix;
  if (process.platform !== 'win32') {
    keyRoot = mkdtempSync(join(tmpdir(), 'fai-flow-synthetic-')); keyPath = join(keyRoot, 'identity.json');
    writeFileSync(keyPath, JSON.stringify({ version: identity.version, secretBase64: keyBytes.toString('base64') }), { mode: 0o600 });
    keyringPath = join(keyRoot, 'gateway.json');
    writeFileSync(keyringPath, JSON.stringify({ version: 1, keys: [{ keyId: ingressKeyId, secretBase64: ingressSecret.toString('base64') }] }), { mode: 0o600 });
    const key = await db.secureLeadGatewayKeyVersion.create({ data: { keyId: ingressKeyId, producerCode, version: 1,
      secretDigest: digestSecureLeadGatewayKey(ingressSecret), status: 'STAGED', acceptFrom: new Date(Date.now() - 60_000) } });
    await db.secureLeadGatewayKeyVersion.update({ where: { id: key.id }, data: { status: 'ACTIVE' } });
  }
  const projectionMode = process.platform === 'win32' ? 'WINDOWS_PROJECTION_FIXTURE' : 'NATIVE_POSIX_IDENTITY_PROJECTION';
  const gatewayReceiptMode = process.platform === 'win32' ? 'SYNTHETIC_FIXTURE' : 'NATIVE_AUTHENTICATED_HTTP_HMAC';

  async function receive(review = false, marketingDecision: 'GRANTED' | 'DENIED' = 'DENIED') {
    await assertAiOrchestratorEphemeralDatabaseIdentity(db);
    const input = syntheticLeadEventInputV1(), nonce = randomUUID();
    const payload = { ...input.payload, firstName: 'Sintetico ' + nonce, lastName: 'Flusso', companyName: 'Impresa sintetica ' + nonce,
      email: `${nonce}@flow.invalid.test`, phone: undefined };
    if (review) await db.lead.create({ data: { firstName: 'Existing', lastName: 'Synthetic', email: payload.email } });
    const event = createLeadSubmittedEventV1({ ...input, eventId: randomUUID(), businessCorrelationId: randomUUID(), occurredAt: new Date().toISOString(),
      source: { ...input.source, submissionId: nonce }, payload,
      privacy: { service: { ...input.privacy.service, noticeCode: serviceNotice }, marketing: { ...input.privacy.marketing, noticeCode: marketingNotice, decision: marketingDecision } } });
    let receipt: Awaited<ReturnType<typeof db.secureLeadGatewayReceipt.findUniqueOrThrow>>;
    if (process.platform !== 'win32') {
      const priorGate = await db.applicationFeatureGate.findUniqueOrThrow({ where: { code: 'INTEGRATIONS' } });
      await db.applicationFeatureGate.update({ where: { code: 'INTEGRATIONS' }, data: { enabled: true } });
      try {
        const body = Buffer.from(canonicalJson(event)), headers = { keyId: ingressKeyId, timestamp: String(Math.trunc(Date.now() / 1000)), nonce: randomUUID().replaceAll('-', '') };
        const signature = createSecureLeadGatewaySignature(ingressSecret, createSecureLeadGatewaySignedBytes(headers, body));
        let firstReceipt: unknown;
        for (let replay = 0; replay < 2; replay++) {
          const request = () => new NextRequest('http://local' + SECURE_LEAD_GATEWAY_PROTOCOL.path, { method: 'POST',
            headers: { 'content-type': SECURE_LEAD_GATEWAY_PROTOCOL.contentType, 'content-length': String(body.byteLength),
              'x-fai-key-id': headers.keyId, 'x-fai-timestamp': headers.timestamp, 'x-fai-nonce': headers.nonce, 'x-fai-signature': signature },
            body, duplex: 'half' } as unknown as ConstructorParameters<typeof NextRequest>[1]);
          const options = { db, keyringPath, allowedKeyringRoot: keyRoot,
            environment: { SECURE_LEAD_GATEWAY_MODE: 'enforced', FEATURE_INTEGRATIONS_ENABLED: 'true' } };
          let response = await handleSecureLeadGatewayRequest(request(), options);
          // Repeated synthetic cases respect the native producer rate window.
          // A 429 precedes admission; no DB bucket or product guard is bypassed.
          for (let retry = 0; response.status === 429 && retry < 3; retry++) {
            const seconds = Number(response.headers.get('retry-after'));
            assert(Number.isInteger(seconds) && seconds >= 1 && seconds <= 60);
            await waitForRateWindow(seconds * 1000);
            response = await handleSecureLeadGatewayRequest(request(), options);
          }
          const result = await response.json();
          assert.equal(response.status, 202, JSON.stringify(result)); assert.equal(result.ok, true);
          if (replay === 0) firstReceipt = result.receipt; else assert.equal(result.receipt, firstReceipt);
        }
        const inbox = await db.businessInboxEvent.findUniqueOrThrow({ where: { eventId: event.eventId } });
        receipt = await db.secureLeadGatewayReceipt.findUniqueOrThrow({ where: { inboxEventId: inbox.id } });
        assert.equal(await db.secureLeadGatewayRequest.count({ where: { receiptId: receipt.id } }), 1);
      } finally { await db.applicationFeatureGate.update({ where: { code: 'INTEGRATIONS' }, data: { enabled: priorGate.enabled } }); }
    } else {
      const admitted = await admitBusinessInboxEvent(db, event), now = new Date();
      receipt = await db.secureLeadGatewayReceipt.create({ data: { inboxEventId: admitted.inboxEventId, createdAt: now,
        retentionEligibleAt: new Date(now.getTime() + 86400000) } });
    }
    const admitted = { inboxEventId: receipt.inboxEventId };
    const lease = await claimBusinessQueueEvent(db, { queueKind: 'INBOX', leaseOwnerId: randomUUID(), inboxEventIds: [admitted.inboxEventId] });
    assert(lease);
    if (process.platform !== 'win32') await projectClaimedLeadInboxEvent(db, lease, { keyFilePath: keyPath, allowedSecretRoot: keyRoot });
    else await processClaimedBusinessInboxEventInTransaction(db, lease, async ({ tx, inboxEventId, envelope, recordHash, databaseNow }) => {
      await createBusinessLeadPrivacyEvidence(tx, { businessInboxEventId: inboxEventId, event: envelope });
      const lead = review ? null : await tx.lead.create({ data: mapLeadSubmittedEventToLead(envelope) });
      const ledger = await tx.leadProjectionLedger.create({ data: { inboxEventId, sourceRecordHash: recordHash,
        state: review ? 'REVIEW_REQUIRED' : 'PROJECTED_NEW', leadId: lead?.id, candidateCount: review ? 1 : 0,
        normalizationVersion: LEAD_NORMALIZATION_VERSION, identityKeyVersionId: identityId, privacyEvidenceCount: 2,
        completedAt: databaseNow, resultHash: canonicalSha256({ fixture: projectionMode, inboxEventId, leadId: lead?.id ?? null }) } });
      if (lead) await maybeEnrollProjectedCommercialLead(tx, { leadId: lead.id, projectionLedgerId: ledger.id });
      await tx.auditLog.create({ data: { actorId, entityType: 'LeadProjectionLedger', entityId: ledger.id,
        event: 'synthetic_windows_projection_fixture', after: { synthetic: true, posixIdentityNotExercised: true, receiptIsFixture: true } } });
    });
    if (process.platform === 'win32') await captureWorkflowLeadReceiptAfterCommit(db, admitted.inboxEventId);
    const projection = await db.leadProjectionLedger.findUniqueOrThrow({ where: { inboxEventId: admitted.inboxEventId } });
    const replay = await admitBusinessInboxEvent(db, event);
    assert.equal(replay.inboxEventId, admitted.inboxEventId);
    assert.equal(await db.secureLeadGatewayReceipt.count({ where: { inboxEventId: admitted.inboxEventId } }), 1);
    return { event, receipt, projection, projectionMode, gatewayReceiptMode };
  }
  return { receive, projectionMode, marketingNoticeText, gatewayReceiptMode };
}
