import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  COMMERCIAL_LEAD_ACTIVITY_TYPES,
  COMMERCIAL_LEAD_INBOX_MANIFEST,
  COMMERCIAL_LEAD_ORIGIN_KINDS,
  COMMERCIAL_LEAD_REASON_CODES,
  commercialLeadInboxMode,
  isCommercialLeadOriginKind,
  isCommercialLeadReasonCode,
  isCommercialLeadResponseTargetSeconds,
} from '../src/lib/commercial-lead-inbox-contract';
import { classifyDataField } from '../src/lib/data-classification';

test('N14 remains dormant and fail-closed for missing, empty and unknown modes', () => {
  assert.equal(COMMERCIAL_LEAD_INBOX_MANIFEST.dormant, true);
  assert.equal(COMMERCIAL_LEAD_INBOX_MANIFEST.activation, 'NONE');
  assert.deepEqual(COMMERCIAL_LEAD_INBOX_MANIFEST.runtimeConsumers, []);
  for (const value of [undefined, '', 'disabled', 'true', 'ENFORCED', 'unknown']) {
    assert.equal(commercialLeadInboxMode(value), 'disabled');
  }
  assert.equal(commercialLeadInboxMode('enforced'), 'enforced');
  for (const path of ['.env.example', '.env.production.example', '.env.staging.example']) {
    assert.match(readFileSync(path, 'utf8'), /COMMERCIAL_LEAD_INBOX_MODE="disabled"/u);
  }
});

test('N14 exposes only closed provenance, lifecycle, activity and reason vocabularies', () => {
  assert.deepEqual(COMMERCIAL_LEAD_ORIGIN_KINDS, [
    'MANUAL_CRM', 'WEBSITE_LEGACY_N01', 'BUSINESS_PROJECTION_N13', 'LEGACY_UNVERIFIED',
  ]);
  assert.equal(COMMERCIAL_LEAD_ACTIVITY_TYPES.length, 7);
  assert.equal(COMMERCIAL_LEAD_REASON_CODES.length, 12);
  assert.equal(isCommercialLeadOriginKind('MANUAL_CRM'), true);
  assert.equal(isCommercialLeadOriginKind('INFERRED_FROM_EMAIL'), false);
  assert.equal(isCommercialLeadReasonCode('SELF_CLAIM'), true);
  assert.equal(isCommercialLeadReasonCode('free text'), false);
});

test('N14 SLA target is positive, integer and bounded to one year', () => {
  for (const value of [1, 60, 86_400, 31_536_000]) {
    assert.equal(isCommercialLeadResponseTargetSeconds(value), true);
  }
  for (const value of [0, -1, 1.5, Number.NaN, 31_536_001, '3600']) {
    assert.equal(isCommercialLeadResponseTargetSeconds(value), false);
  }
});

test('N14 documentation fixes the database-clock and application rollback boundaries', () => {
  const document = readFileSync('docs/n14-commercial-lead-inbox-attribution-sla-v1.md', 'utf8');
  assert.match(document, /clock PostgreSQL/u);
  assert.match(document, /fresh42/u);
  assert.match(document, /PR108 N−1 su DB42/u);
  assert.match(document, /nessuna down-migration/u);
});

test('N14 classifies identifiers, session bindings, provenance and SLA timestamps', () => {
  assert.equal(classifyDataField('commercial_lead_inbox_item_v1', 'leadId').classification, 'PERSONAL');
  assert.equal(classifyDataField('commercial_lead_inbox_item_v1', 'originKind').classification, 'INTERNAL');
  assert.equal(classifyDataField('commercial_lead_sla_cycle_v1', 'dueAt').classification, 'PERSONAL');
  assert.equal(classifyDataField('commercial_lead_activity_v1', 'actorSessionId').classification, 'AUTHENTICATION_SECRET');
});
