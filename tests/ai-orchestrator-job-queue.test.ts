import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import type { FaiAuditTransitionCode } from '../src/lib/ai-orchestrator/audit-workflow-v1-1';
import {
  FAI_AUDIT_JOB_CATALOG_HASH,
  FAI_AUDIT_JOB_CATALOG_KEY,
  FAI_AUDIT_JOB_CODES,
  FAI_AUDIT_JOB_DEFINITIONS,
  FAI_AUDIT_JOB_PLANNING_RULES,
  getFaiAuditJobCatalogInvariantErrors,
} from '../src/lib/ai-orchestrator/job-catalog-v1';
import { createFaiAuditJobPlan } from '../src/lib/ai-orchestrator/job-planner';

const root = process.cwd();
const migrationPath = resolve(
  root,
  'prisma/migrations/20260717180000_ai_orchestrator_persistent_job_queue_foundation/migration.sql',
);

function plan(transitionCode: FaiAuditTransitionCode, overrides: Record<string, unknown> = {}) {
  return createFaiAuditJobPlan({
    workflowInstanceId: 'synthetic-workflow-id',
    workflowCode: 'FAI-AUDIT-WORKFLOW',
    workflowVersion: '1.1',
    sourceCommandIdempotencyKey: 'synthetic-command-key',
    sourceTransitionCode: transitionCode,
    sourceTransitionSequence: 4,
    correlationId: 'synthetic-correlation-id',
    correctionCycle: 0,
    fromState: 'NEEDS_DOCUMENTS',
    toState: 'DATA_VALIDATION',
    ...overrides,
  });
}

test('il catalogo canonico v1 è completo, immutabile per hash e fail-closed', () => {
  assert.equal(FAI_AUDIT_JOB_CATALOG_KEY, 'FAI-AUDIT-JOB-CATALOG@1.0');
  assert.equal(
    FAI_AUDIT_JOB_CATALOG_HASH,
    'eca7f4174ab8a188ef21df6758ab6cfd081dd51a126f47097f6a3706ec7bbb9e',
  );
  assert.equal(FAI_AUDIT_JOB_CODES.length, 13);
  assert.equal(FAI_AUDIT_JOB_DEFINITIONS.length, FAI_AUDIT_JOB_CODES.length);
  assert.deepEqual(getFaiAuditJobCatalogInvariantErrors(), []);
  for (const definition of FAI_AUDIT_JOB_DEFINITIONS) {
    assert.equal(definition.jobVersion, '1.0');
    assert.equal(definition.provider, 'mock');
    assert.equal(definition.dataMode, 'synthetic');
    assert.equal(definition.automaticDispatchAllowed, false);
    assert.ok(Number(definition.completionTransitionCode.slice(3)) <= 16);
  }
});

test('il mapping transizione-job è esplicito e si arresta prima di HUMAN_APPROVAL', () => {
  assert.deepEqual(
    FAI_AUDIT_JOB_PLANNING_RULES.map(({ sourceTransitionCode, jobCodes }) => [sourceTransitionCode, jobCodes]),
    [
      ['WF-004', ['DOCUMENT_INGESTION']],
      ['WF-005', ['DOCUMENT_CLASSIFICATION']],
      ['WF-006', ['EVIDENCE_EXTRACTION']],
      ['WF-009', ['DOCUMENT_INGESTION']],
      ['WF-010', ['FINANCIAL_ANALYSIS', 'CREDIT_ANALYSIS', 'CALCULATIONS']],
      ['WF-011', ['FINDINGS_DRAFTING']],
      ['WF-012', ['REPORT_COMPOSITION']],
      ['WF-013', ['SCHEMA_REVIEW', 'NUMERIC_REVIEW', 'SOURCE_REVIEW', 'RED_TEAM_REVIEW']],
      ['WF-015', ['CORRECTION']],
      ['WF-016', ['SCHEMA_REVIEW', 'NUMERIC_REVIEW', 'SOURCE_REVIEW', 'RED_TEAM_REVIEW']],
    ],
  );
  for (const code of [
    'WF-001', 'WF-002', 'WF-003', 'WF-007', 'WF-008', 'WF-014', 'WF-017',
    'WF-018', 'WF-019', 'WF-020', 'WF-021', 'WF-022', 'WF-023',
  ] as FaiAuditTransitionCode[]) {
    assert.equal(plan(code).jobs.length, 0, code);
  }
});

test('planner, dedupe e bundle sono deterministici e sensibili all’identità causale', () => {
  const first = plan('WF-010');
  const replay = plan('WF-010');
  assert.deepEqual(replay, first);
  assert.equal(first.jobs.length, 3);
  assert.equal(new Set(first.jobs.map(({ bundleKey }) => bundleKey)).size, 1);
  assert.equal(new Set(first.jobs.map(({ dedupeKey }) => dedupeKey)).size, 3);
  assert.equal(plan('WF-013').jobs.length, 4);
  assert.equal(plan('WF-016', { correctionCycle: 1 }).jobs.length, 4);

  for (const changed of [
    plan('WF-010', { sourceCommandIdempotencyKey: 'different-command-key' }),
    plan('WF-010', { sourceTransitionSequence: 5 }),
    plan('WF-010', { correctionCycle: 1 }),
  ]) {
    assert.notEqual(changed.planHash, first.planHash);
    assert.notDeepEqual(changed.jobs.map(({ dedupeKey }) => dedupeKey), first.jobs.map(({ dedupeKey }) => dedupeKey));
  }
});

test('i payload pianificati contengono soltanto identità tecniche sintetiche', () => {
  const planned = plan('WF-013');
  for (const job of planned.jobs) {
    assert.equal(job.provider, 'mock');
    assert.equal(job.dataMode, 'synthetic');
    assert.equal(job.automaticDispatchAllowed, false);
    assert.match(job.payloadHash, /^[0-9a-f]{64}$/);
    assert.deepEqual(Object.keys(job.payload).sort(), [
      'catalogHash', 'catalogKey', 'job', 'schemaVersion', 'sourceTransition', 'workflow',
    ]);
    assert.doesNotMatch(
      JSON.stringify(job.payload),
      /\b(?:clientId|companyId|projectId|clientServiceId|documentContent|prompt|output|cookie|password|token|apiKey|credential|secret)\b/i,
    );
  }
});

test('schema e migration espongono solo coda persistente passiva e outbox transazionale', () => {
  const schema = readFileSync(resolve(root, 'prisma/schema.prisma'), 'utf8');
  const sql = readFileSync(migrationPath, 'utf8');
  const planner = readFileSync(resolve(root, 'src/lib/ai-orchestrator/job-planner.ts'), 'utf8');
  const catalog = readFileSync(resolve(root, 'src/lib/ai-orchestrator/job-catalog-v1.ts'), 'utf8');
  const jobModel = schema.match(/model AiWorkflowJob \{([\s\S]*?)\n\}/)?.[1];
  const outboxModel = schema.match(/model AiWorkflowJobOutboxEvent \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(jobModel);
  assert.ok(outboxModel);
  assert.match(sql, /BEGIN;[\s\S]*CREATE TABLE "AiWorkflowJob"[\s\S]*CREATE TABLE "AiWorkflowJobOutboxEvent"[\s\S]*COMMIT;/);
  assert.match(sql, /"status" = 'PLANNED'[\s\S]*"status" = 'BLOCKED'/);
  assert.match(sql, /"provider" = 'mock'[\s\S]*"dataMode" = 'synthetic'[\s\S]*"automaticDispatchAllowed" = false/);
  assert.match(sql, /"eventType" = 'AI_JOB_PLANNED'[\s\S]*"deliveryState" = 'PENDING'/);
  assert.match(sql, /DEFERRABLE INITIALLY DEFERRED/);
  assert.match(sql, /canonical job plan hash is invalid/);
  assert.match(sql, /one-way PLANNED to BLOCKED safety transition/);
  assert.doesNotMatch(`${jobModel}\n${outboxModel}\n${planner}\n${catalog}\n${sql}`, /\bRUNNING\b/);
  assert.doesNotMatch(`${jobModel}\n${outboxModel}\n${planner}\n${catalog}`, /\b(?:lease|claim|dispatchAt|workerId|providerCall|agentRun)\b/i);
  assert.doesNotMatch(`${planner}\n${catalog}`, /\bfetch\s*\(|openai|next\/headers|next\/server/i);
  assert.doesNotMatch(sql, /\b(?:DROP|TRUNCATE)\b/i);
});
