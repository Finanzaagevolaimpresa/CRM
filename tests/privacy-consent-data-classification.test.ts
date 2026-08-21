import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { NextRequest } from 'next/server';
import { POST } from '../src/app/api/integrations/website/leads/route';
import {
  assertClassifiedFields,
  DATA_CLASSIFICATION_CATALOG_VERSION,
  dataClassificationCatalog,
  redactAuditPayload,
  redactTechnicalText,
  UnclassifiedDataFieldError,
} from '../src/lib/data-classification';
import { roleHasPermission } from '../src/lib/permissions';
import { SYNTHETIC_LEAD_EVENT_V1 } from './fixtures/n10-lead-event-v1';

const migrationPath = 'prisma/migrations/20260817120000_privacy_consent_data_classification_foundation_v1/migration.sql';
const migration = readFileSync(migrationPath, 'utf8');
const contractFields = [
  'firstName', 'lastName', 'companyName', 'email', 'phone', 'city', 'region', 'interest',
  'requestedAmount', 'message', 'sourcePage', 'serviceInterest', 'sourceSystem', 'formCode',
  'formVersion', 'privacyAccepted', 'privacyNoticeCode', 'privacyNoticeVersion',
  'privacyPurposeCode', 'privacyLegalBasisCode', 'marketingAccepted', 'marketingNoticeCode',
  'marketingNoticeVersion', 'marketingPurposeCode', 'marketingLegalBasisCode', 'submittedAt',
] as const;
const noticeFields = [
  'id', 'noticeCode', 'noticeVersion', 'purposeCode', 'legalBasisCode', 'evidenceKind',
  'contentHash', 'status', 'effectiveFrom', 'retiredAt', 'createdAt',
] as const;
const evidenceFields = [
  'id', 'leadId', 'websiteLeadReceiptId', 'businessInboxEventId', 'noticeVersionId', 'catalogVersion', 'purposeCode',
  'legalBasisCode', 'evidenceKind', 'decision', 'sourceSystem', 'formCode', 'formVersion',
  'sourceSubmittedAt', 'sourceEvidenceDigest', 'evidenceHash', 'createdAt',
] as const;
const leadBusinessEventFields = [
  'schemaVersion', 'eventType', 'eventVersion', 'eventId', 'businessCorrelationId',
  'occurredAt', 'source.systemCode', 'source.formCode', 'source.formVersion',
  'source.submissionId', 'privacy.service.noticeCode', 'privacy.service.noticeVersion',
  'privacy.service.purposeCode', 'privacy.service.legalBasisCode',
  'privacy.service.evidenceKind', 'privacy.service.decision',
  'privacy.marketing.noticeCode', 'privacy.marketing.noticeVersion',
  'privacy.marketing.purposeCode', 'privacy.marketing.legalBasisCode',
  'privacy.marketing.evidenceKind', 'privacy.marketing.decision',
  'catalogReference.catalogVersion', 'catalogReference.serviceCode',
  'catalogReference.serviceVersion', 'payload.firstName', 'payload.lastName',
  'payload.companyName', 'payload.email', 'payload.phone', 'payload.city', 'payload.region',
  'payload.interestText', 'payload.serviceInterestText', 'payload.message',
  'payload.sourcePagePath', 'payload.requestedAmount.currency',
  'payload.requestedAmount.minorUnits', 'idempotency.canonicalizationVersion',
  'idempotency.keyDigest', 'idempotency.payloadHash',
] as const;

const leadContract = {
  firstName: 'Synthetic',
  lastName: 'N04',
  email: 'privacy-contract@n04.invalid',
  sourceSystem: 'N04_UNIT_TEST',
  formCode: 'SYNTHETIC_LEAD',
  formVersion: 'n04-v1',
  privacyAccepted: true,
  privacyNoticeCode: 'N04_TEST_PRIVACY',
  privacyNoticeVersion: 'n04-v1',
  privacyPurposeCode: 'SERVICE_REQUEST_FOLLOW_UP',
  privacyLegalBasisCode: 'PRE_CONTRACTUAL_MEASURES',
  marketingAccepted: false,
  marketingNoticeCode: 'N04_TEST_MARKETING',
  marketingNoticeVersion: 'n04-v1',
  marketingPurposeCode: 'DIRECT_MARKETING',
  marketingLegalBasisCode: 'CONSENT',
  submittedAt: '2026-08-17T00:00:00.000Z',
} as const;

function routeRequest(body: unknown) {
  return new NextRequest('http://local/api/integrations/website/leads', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-fai-webhook-secret': 'n04-unit-secret' },
    body: JSON.stringify(body),
  });
}

async function withShadowRoute<T>(operation: () => Promise<T>) {
  const previous = {
    mode: process.env.WEBSITE_LEAD_MODE,
    secret: process.env.WEBSITE_LEAD_WEBHOOK_SECRET,
    feature: process.env.FEATURE_INTEGRATIONS_ENABLED,
  };
  process.env.WEBSITE_LEAD_MODE = 'shadow';
  process.env.WEBSITE_LEAD_WEBHOOK_SECRET = 'n04-unit-secret';
  process.env.FEATURE_INTEGRATIONS_ENABLED = 'false';
  try { return await operation(); }
  finally {
    if (previous.mode === undefined) delete process.env.WEBSITE_LEAD_MODE; else process.env.WEBSITE_LEAD_MODE = previous.mode;
    if (previous.secret === undefined) delete process.env.WEBSITE_LEAD_WEBHOOK_SECRET; else process.env.WEBSITE_LEAD_WEBHOOK_SECRET = previous.secret;
    if (previous.feature === undefined) delete process.env.FEATURE_INTEGRATIONS_ENABLED; else process.env.FEATURE_INTEGRATIONS_ENABLED = previous.feature;
  }
}

test('N04 migration 35 is additive, transactional and leaves registries empty', () => {
  const names = readdirSync('prisma/migrations').filter((name) => /^\d/.test(name)).sort();
  assert.equal(names.length, 40);
  assert.equal(names[34], '20260817120000_privacy_consent_data_classification_foundation_v1');
  assert.equal(names[35], '20260818120000_core_query_index_pagination_hardening_v1');
  assert.match(migration, /^BEGIN;/);
  assert.match(migration, /CREATE TABLE "PrivacyNoticeVersion"/);
  assert.match(migration, /CREATE TABLE "PrivacyEvidenceReceipt"/);
  assert.match(migration, /PrivacyEvidenceReceipt_append_only_v1/);
  assert.match(migration, /AuditLog_redaction_n04_v1/);
  assert.doesNotMatch(migration, /^\s*(?:DROP TABLE|TRUNCATE TABLE|DELETE FROM|UPDATE\s+"|INSERT INTO)\b/im);
  assert.match(migration, /COMMIT;\s*$/);
});

test('classification catalog v1 covers the complete lead contract and denies unknown fields', () => {
  assert.equal(DATA_CLASSIFICATION_CATALOG_VERSION, 'n04-v1');
  assert.deepEqual(Object.keys(dataClassificationCatalog.website_lead_intake_v2).sort(), [...contractFields].sort());
  assert.deepEqual(Object.keys(dataClassificationCatalog.privacy_notice_version_v1).sort(), [...noticeFields].sort());
  assert.deepEqual(Object.keys(dataClassificationCatalog.privacy_evidence_receipt_v1).sort(), [...evidenceFields].sort());
  assert.deepEqual(
    Object.keys(dataClassificationCatalog.lead_business_event_v1).sort(),
    [...leadBusinessEventFields].sort(),
  );
  assert.equal(dataClassificationCatalog.external_ai_payload_v1.context.classification, 'CONFIDENTIAL');
  assert.deepEqual(dataClassificationCatalog.website_lead_intake_v2.marketingAccepted, {
    classification: 'PERSONAL', purposeCode: 'DIRECT_MARKETING', legalBasisCode: 'CONSENT',
  });
  assert.doesNotThrow(() => assertClassifiedFields('website_lead_intake_v2', leadContract));
  assert.throws(
    () => assertClassifiedFields('website_lead_intake_v2', { ...leadContract, inferredConsent: true }),
    (error: unknown) => error instanceof UnclassifiedDataFieldError && error.fieldPath === 'inferredConsent',
  );
  assert.doesNotThrow(() => assertClassifiedFields(
    'lead_business_event_v1',
    SYNTHETIC_LEAD_EVENT_V1,
  ));
  assert.throws(
    () => assertClassifiedFields('lead_business_event_v1', {
      ...SYNTHETIC_LEAD_EVENT_V1,
      payload: { ...SYNTHETIC_LEAD_EVENT_V1.payload, inferredConsent: true },
    }),
    (error: unknown) => error instanceof UnclassifiedDataFieldError
      && error.fieldPath === 'payload.inferredConsent',
  );
});

test('technical and audit redaction removes PII, credentials and prompt text while retaining safe metadata', () => {
  const sensitive = [
    'privacy.person@n04.invalid',
    '+39 030 000 0000',
    '333 123 4567',
    '030 123 4567',
    'RSSMRA80A01H501U',
    'Bearer abcdefghijklmnopqrstuvwxyz012345',
    'token=synthetic-token-value',
    'prompt=synthetic private instruction',
  ].join('\n');
  const redactedText = redactTechnicalText(sensitive);
  for (const prohibited of ['privacy.person', '+39', '333 123', '030 123', 'RSSMRA', 'abcdefghijklmnopqrstuvwxyz', 'synthetic-token', 'private instruction']) {
    assert.equal(redactedText.toLowerCase().includes(prohibited.toLowerCase()), false, prohibited);
  }
  const hash = 'a'.repeat(64);
  const audit = redactAuditPayload({
    after: {
      email: 'privacy.person@n04.invalid',
      phone: '+390300000000',
      prompt: 'synthetic private instruction',
      token: 'synthetic-token-value',
      catalogVersion: 'n04-v1',
      evidenceHash: hash,
      reason: sensitive,
      unknownFreeText: 'must not survive',
      liquid: 'suffix-like unknown key must not survive',
    },
    ipAddress: '192.0.2.1',
  });
  const serialized = JSON.stringify(audit);
  for (const prohibited of ['privacy.person', '+3903', '333 123', '030 123', 'RSSMRA', 'synthetic-token', 'private instruction', '192.0.2.1', 'must not survive', 'suffix-like']) {
    assert.equal(serialized.toLowerCase().includes(prohibited.toLowerCase()), false, prohibited);
  }
  assert.match(serialized, /n04-v1/);
  assert.match(serialized, new RegExp(hash));
  assert.equal(redactTechnicalText('x'.repeat(5000)).length, 4096);
  assert.deepEqual(redactAuditPayload({ createdAt: new Date('2026-08-17T00:00:00.000Z') }), { createdAt: '2026-08-17T00:00:00.000Z' });
});

test('audit redaction preserves existing non-sensitive control-plane invariants', () => {
  const payload = {
    before: { policyHash: 'a'.repeat(64), revisionHash: 'b'.repeat(64), version: 1 },
    after: {
      changedPaths: ['desiredMode', 'limits'],
      operationCode: 'SET_GLOBAL_POLICY',
      policyHash: 'c'.repeat(64),
      requestHash: 'd'.repeat(64),
      requestId: '018f47a2-4d12-4abc-8def-0123456789ab',
      revisionHash: 'e'.repeat(64),
      scopeCode: 'global',
      scopeType: 'GLOBAL',
      version: 2,
    },
  };
  assert.deepEqual(redactAuditPayload(payload), payload);
});

test('website lead contract requires explicit separate privacy and marketing decisions', async () => {
  await withShadowRoute(async () => {
    assert.equal((await POST(routeRequest(leadContract))).status, 503, 'valid dormant contract reaches the closed feature gate');
    assert.equal((await POST(routeRequest({ ...leadContract, marketingAccepted: true }))).status, 503);
    const withoutMarketing: Record<string, unknown> = { ...leadContract };
    delete withoutMarketing.marketingAccepted;
    assert.equal((await POST(routeRequest(withoutMarketing))).status, 400);
    assert.equal((await POST(routeRequest({ ...leadContract, privacyAccepted: false }))).status, 400);
    assert.equal((await POST(routeRequest({ ...leadContract, inferredPurpose: 'DIRECT_MARKETING' }))).status, 400);
  });
});

test('privacy evidence is separately authorized and bootstrap output cannot disclose credentials', () => {
  assert.equal(roleHasPermission('admin', 'privacy.evidence.read'), true);
  assert.equal(roleHasPermission('direzione', 'privacy.evidence.read'), true);
  for (const role of ['commerciale', 'consulente', 'revisore', 'backoffice', 'amministrazione', 'collaboratore_limitato'] as const) {
    assert.equal(roleHasPermission(role, 'privacy.evidence.read'), false, role);
  }
  const privacyPage = readFileSync('src/app/legal-compliance/privacy/page.tsx', 'utf8');
  const navigation = readFileSync('src/components/nav-links.tsx', 'utf8');
  assert.match(privacyPage, /requirePermission\('privacy\.evidence\.read'\)/);
  assert.doesNotMatch(privacyPage, /lead:\s*\{|email|phone|contactPerson|ipAddress/);
  assert.match(navigation, /href: "\/legal-compliance\/privacy", requiredPermission: "privacy\.evidence\.read"/);

  const bootstrap = readFileSync('scripts/bootstrap-admin.ts', 'utf8');
  const reconciler = readFileSync('scripts/reconcile-ai-runs.ts', 'utf8');
  assert.match(bootstrap, /requiredEnv\("BOOTSTRAP_ADMIN_PASSWORD"\)/);
  assert.doesNotMatch(bootstrap, /randomBytes|generatePassword|console\.(?:log|error)\([^\n]*(?:password|email|name)/i);
  assert.doesNotMatch(reconciler, /error\.message|console\.error\([^\n]*error/);
});
