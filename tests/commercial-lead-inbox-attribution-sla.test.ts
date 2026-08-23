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
import { createOperationalCorrelationId, createOperationalEventV1 } from '../src/lib/operational-telemetry';
import { hasPermission } from '../src/lib/permission-evaluator';

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

test('N14 telemetry is aggregate-only and rejects identifiers or free metadata', () => {
  const event = createOperationalEventV1({
    eventCode: 'COMMERCIAL_LEAD_INBOX_OPERATION_COMPLETED',
    outcome: 'SUCCESS',
    correlationId: createOperationalCorrelationId(() => '00000000-0000-4000-8000-000000000014'),
    metadata: { operationCode: 'CLAIM' },
    nowMs: Date.parse('2026-08-23T00:00:00.000Z'),
  });
  assert.deepEqual(event.metadata, { operationCode: 'CLAIM' });
  assert.throws(() => createOperationalEventV1({
    eventCode: 'COMMERCIAL_LEAD_INBOX_OPERATION_COMPLETED',
    outcome: 'SUCCESS',
    correlationId: createOperationalCorrelationId(() => '00000000-0000-4000-8000-000000000014'),
    metadata: { operationCode: 'CLAIM', leadId: 'forbidden' },
  }), /TELEMETRY_METADATA_INVALID/u);
});

test('N14 service fixes lock order, database clock and transaction-local Lead guard context', () => {
  const source = readFileSync('src/lib/commercial-lead-inbox.ts', 'utf8');
  assert.match(source, /lockAuthoritativeInternalSession[\s\S]*lockLead[\s\S]*lockItem[\s\S]*lockOpenCycle/u);
  assert.match(source, /clock_timestamp\(\)::timestamptz\(3\)/u);
  assert.match(source, /set_config\('fai\.n14_write_context', 'authorized', true\)/u);
  assert.doesNotMatch(source, /setInterval|setTimeout|\bfetch\s*\(|\bconsole\./u);
});

test('N14 separates self-claim from protected assignment permissions', () => {
  const commerciale = { role: 'commerciale' as const, active: true, permissionOverrides: [] };
  const direzione = { role: 'direzione' as const, active: true, permissionOverrides: [] };
  assert.equal(hasPermission(commerciale, 'lead.inbox.claim'), true);
  assert.equal(hasPermission(commerciale, 'lead.inbox.assign'), false);
  assert.equal(hasPermission({ ...commerciale, permissionOverrides: [{ permission: 'lead.inbox.assign', allowed: true }] }, 'lead.inbox.assign'), false);
  assert.equal(hasPermission(direzione, 'lead.inbox.assign'), true);
  assert.equal(hasPermission(direzione, 'lead.inbox.claim'), false);
});

test('N14 protected actions require step-up before transactional registry revalidation', () => {
  const actions = readFileSync('src/lib/actions.ts', 'utf8');
  for (const code of ['N14_LEAD_INBOX_ASSIGN', 'N14_LEAD_INBOX_UNASSIGN', 'N14_LEAD_INBOX_REOPEN', 'N14_LEAD_INBOX_LEGACY_ENROLL']) {
    assert.match(actions, new RegExp(`requireEnforcedPrivilegedMutation\\(session, '${code}'\\)`));
  }
  assert.match(actions, /commercialLeadActor\(session\)/u);
});

test('N13 projected-new paths enter N14 only through mode plus active-policy enrollment', () => {
  const projection = readFileSync('src/lib/lead-projection.ts', 'utf8');
  const duplicate = readFileSync('src/lib/lead-duplicate-resolution.ts', 'utf8');
  const service = readFileSync('src/lib/commercial-lead-inbox.ts', 'utf8');
  assert.match(projection, /result\.state === 'PROJECTED_NEW'[\s\S]*maybeEnrollProjectedCommercialLead/u);
  assert.match(duplicate, /input\.outcome === 'CREATE_NEW'[\s\S]*maybeEnrollProjectedCommercialLead/u);
  assert.match(service, /maybeEnrollProjectedCommercialLead[\s\S]*commercialLeadInboxMode\(\) !== 'enforced'[\s\S]*optionalActivePolicyAndClock/u);
});
