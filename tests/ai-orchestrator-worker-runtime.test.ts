import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { canonicalSha256 } from '../src/lib/canonical-json';
import { FAI_AUDIT_JOB_CODES } from '../src/lib/ai-orchestrator/job-catalog-v1';
import {
  AI_ORCHESTRATOR_RETRYABLE_FAILURE_CODES,
  AI_ORCHESTRATOR_TERMINAL_FAILURE_CODES,
  AI_ORCHESTRATOR_WORKER_CAPABILITIES,
  AI_ORCHESTRATOR_WORKER_CAPABILITY_HASHES,
  AI_ORCHESTRATOR_WORKER_RUNTIME_LIMITS,
  AI_ORCHESTRATOR_WORKER_RUNTIME_POLICY_HASH,
  calculateAiOrchestratorRetryDelayMs,
  createAiOrchestratorWorkerRuntimePolicyHash,
  getAiOrchestratorWorkerRuntimePolicyInvariantErrors,
} from '../src/lib/ai-orchestrator/worker-runtime-policy-v1';

const root = resolve(import.meta.dirname, '..');
const schema = readFileSync(resolve(root, 'prisma/schema.prisma'), 'utf8');
const migration = readFileSync(resolve(
  root,
  'prisma/migrations/20260718220000_ai_orchestrator_worker_runtime_foundation/migration.sql',
), 'utf8');
const service = readFileSync(resolve(root, 'src/lib/ai-orchestrator/worker-runtime.ts'), 'utf8');
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  scripts?: Record<string, string>;
};

test('runtime policy v1 è completa, deterministica e mock-only', () => {
  assert.deepEqual(getAiOrchestratorWorkerRuntimePolicyInvariantErrors(), []);
  assert.equal(AI_ORCHESTRATOR_WORKER_CAPABILITIES.length, FAI_AUDIT_JOB_CODES.length);
  assert.equal(createAiOrchestratorWorkerRuntimePolicyHash(), AI_ORCHESTRATOR_WORKER_RUNTIME_POLICY_HASH);
  assert.match(AI_ORCHESTRATOR_WORKER_RUNTIME_POLICY_HASH, /^[0-9a-f]{64}$/);
  for (const capability of AI_ORCHESTRATOR_WORKER_CAPABILITIES) {
    assert.equal(capability.provider, 'mock');
    assert.equal(capability.dataMode, 'synthetic');
    assert.equal(capability.networkAccessAllowed, false);
    assert.equal(capability.crmDataAccessAllowed, false);
    assert.equal(capability.providerCallAllowed, false);
    assert.equal(capability.workflowTransitionWriteAllowed, false);
    assert.match(AI_ORCHESTRATOR_WORKER_CAPABILITY_HASHES[capability.jobCode], /^[0-9a-f]{64}$/);
  }
});

test('retry/backoff è limitato, deterministico e sensibile al fencing token', () => {
  const first = calculateAiOrchestratorRetryDelayMs({
    jobId: 'synthetic-job-1', fencingToken: 1n, retryFailureCount: 1,
  });
  const replay = calculateAiOrchestratorRetryDelayMs({
    jobId: 'synthetic-job-1', fencingToken: 1n, retryFailureCount: 1,
  });
  const fenced = calculateAiOrchestratorRetryDelayMs({
    jobId: 'synthetic-job-1', fencingToken: 2n, retryFailureCount: 1,
  });
  assert.equal(first, replay);
  assert.notEqual(first, fenced);
  assert.ok(first >= AI_ORCHESTRATOR_WORKER_RUNTIME_LIMITS.retryBaseDelayMs);
  assert.ok(first <= AI_ORCHESTRATOR_WORKER_RUNTIME_LIMITS.retryBaseDelayMs * 1.2);
  const capped = calculateAiOrchestratorRetryDelayMs({
    jobId: 'synthetic-job-1', fencingToken: 99n, retryFailureCount: 99,
  });
  assert.ok(capped >= AI_ORCHESTRATOR_WORKER_RUNTIME_LIMITS.retryMaxDelayMs);
  assert.ok(capped <= AI_ORCHESTRATOR_WORKER_RUNTIME_LIMITS.retryMaxDelayMs * 1.2);
  assert.deepEqual(AI_ORCHESTRATOR_RETRYABLE_FAILURE_CODES, [
    'LEASE_EXPIRED', 'MOCK_HANDLER_TRANSIENT', 'WORKER_TRANSIENT',
  ]);
  assert.ok(AI_ORCHESTRATOR_TERMINAL_FAILURE_CODES.includes('HUMAN_APPROVAL_REACHED'));
});

test('schema runtime resta separato dai job e dall’outbox immutabili PR75', () => {
  const job = schema.match(/model AiWorkflowJob \{([\s\S]*?)\n\}/)?.[1];
  const outbox = schema.match(/model AiWorkflowJobOutboxEvent \{([\s\S]*?)\n\}/)?.[1];
  const runtime = schema.match(/model AiWorkflowJobRuntime \{([\s\S]*?)\n\}/)?.[1];
  const attempt = schema.match(/model AiWorkflowJobAttempt \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(job && outbox && runtime && attempt);
  assert.match(job, /status\s+String\s+@default\("PLANNED"\)/);
  assert.doesNotMatch(job, /leaseTokenHash|fencingToken|retryFailureCount/);
  assert.doesNotMatch(outbox, /leaseTokenHash|fencingToken/);
  assert.match(runtime, /jobId\s+String\s+@unique/);
  assert.match(runtime, /fencingToken\s+BigInt\s+@default\(0\)/);
  assert.match(attempt, /@@unique\(\[runtimeId, attemptSequence\]\)/);
  assert.match(schema, /model AiWorkflowOutboxConsumption/);
  assert.match(schema, /model AiWorkflowJobRuntimeEvent/);
});

test('migration non fa backfill e protegge claim, lease, receipt e audit', () => {
  assert.match(migration, /^--[\s\S]*?\nBEGIN;/);
  assert.doesNotMatch(migration, /DROP CONSTRAINT "AiOrchestratorSetting_dispatch_disabled_check"/);
  assert.match(migration, /preserves AiOrchestratorSetting_dispatch_disabled_check/);
  assert.doesNotMatch(migration, /UPDATE "AiOrchestratorSetting"[\s\S]*"dispatchEnabled"\s*=\s*true/i);
  assert.doesNotMatch(migration, /INSERT INTO "AiWorkflowJobRuntime"\s*\([^)]*SELECT/i);
  assert.match(migration, /AiWorkflowJobRuntime_requires_consumption/);
  assert.match(migration, /"fencingToken" = "attemptSequence"::BIGINT/);
  assert.match(migration, /"ai_workflow_runtime_job_is_current"/);
  assert.match(migration, /stop_transition\."toState" = 'HUMAN_APPROVAL'/);
  assert.match(migration, /"ai_workflow_runtime_executor_is_valid"/);
  assert.match(migration, /"ai_agent_config_snapshot_hash"\(config\) = job\."executorAgentConfigHash"/);
  assert.match(migration, /AiWorkflowOutboxConsumption_immutable_update/);
  assert.match(migration, /AiWorkflowJobRuntimeEvent_immutable_delete/);
  assert.match(migration, /NEW\."eventHash" IS DISTINCT FROM expected_event_hash/);
  assert.match(migration, /PG_ADVISORY_XACT_LOCK\(HASHTEXTEXTENDED/);
  assert.match(migration, /AiWorkflowJobRuntime_final_consistency/);
  assert.match(migration, /assert_ai_workflow_runtime_consistency/);
  assert.doesNotMatch(migration, /\b(?:DROP|TRUNCATE)\s+(?:TABLE\s+)?"?(?:AiWorkflowJob|AiWorkflowJobOutboxEvent|AiRun|Client)"?/i);
});

test('ogni capability ha un kill switch DB separato, canonico e disabilitato per default', () => {
  const setting = schema.match(
    /model AiOrchestratorWorkerCapabilitySetting \{([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(setting);
  assert.match(setting, /jobCode\s+String\s+@id/);
  assert.match(setting, /capabilityCode\s+String\s+@unique/);
  assert.match(setting, /capabilityHash\s+String\s+@unique/);
  assert.match(setting, /enabled\s+Boolean\s+@default\(false\)/);
  assert.match(migration, /INSERT INTO "AiOrchestratorWorkerCapabilitySetting"[\s\S]*false, 1/);
  assert.match(migration, /"ai_workflow_runtime_capability_enabled"/);
  assert.match(migration, /Worker capability setting must be inserted disabled at version 1/);
  assert.match(service, /lockAndAssertCapabilityEnabled/);
  assert.match(service, /FOR UPDATE OF setting/);
});

test('audit e recovery sono causali per singolo attempt e non per sola cardinalità aggregata', () => {
  assert.match(migration, /AiWorkflowJobRuntimeEvent_one_admitted_per_runtime_key/);
  assert.match(migration, /AiWorkflowJobRuntimeEvent_one_claimed_per_attempt_key/);
  assert.match(migration, /AiWorkflowJobRuntimeEvent_one_terminal_per_attempt_key/);
  assert.match(migration, /CASE WHEN attempt\."finishedAt" IS NULL THEN 0 ELSE 1 END/);
  assert.match(migration, /event\."occurredAt" IS DISTINCT FROM attempt\."finishedAt"/);
  assert.match(service, /const ineligibilityReason = await runtimeIneligibilityReason\(tx, row\.jobId\)/);
  assert.doesNotMatch(service, /const reasonCode = current \? 'LEASE_EXPIRED' : 'PHASE_SUPERSEDED'/);
  assert.match(service, /STRUCTURAL_SUPERSESSION_REASONS\.has/);
});

test('claim usa clock PostgreSQL, lock atomico, token opaco e fencing monotono', () => {
  assert.match(service, /AI_ORCHESTRATOR_WORKER_ENABLED/);
  assert.match(service, /FOR UPDATE OF orchestrator, control/);
  assert.match(service, /FOR UPDATE OF runtime SKIP LOCKED/);
  assert.match(service, /PG_ADVISORY_XACT_LOCK\(HASHTEXTEXTENDED/);
  assert.match(service, /clock_timestamp\(\) AT TIME ZONE 'UTC'/);
  assert.match(service, /randomBytes\(32\)\.toString\('base64url'\)/);
  assert.match(service, /const tokenHash = sha256\(secret\)/);
  assert.match(service, /activeWorkflowJobLeases = new WeakMap/);
  assert.doesNotMatch(service, /data:\s*\{[\s\S]{0,200}secret/);
  assert.match(service, /const fencingToken = candidate\.fencingToken \+ 1n/);
  assert.match(service, /leaseExpiresAt:\s*\{ gt: now \}/);
  assert.match(service, /isolationLevel: Prisma\.TransactionIsolationLevel\.ReadCommitted/);
});

test('supersession idle è batch-limitata, lockata e non richiede gate positivi', () => {
  assert.match(service, /export async function supersedeIneligibleAiWorkflowJobRuntimes/);
  assert.match(service, /runtime\."state" IN \('AVAILABLE', 'RETRY_WAIT'\)/);
  assert.match(service, /eligibility\."reason" IS NOT NULL/);
  assert.match(service, /FOR UPDATE OF runtime SKIP LOCKED/);
  assert.match(service, /eventType: 'SUPERSEDED_IDLE'/);
  const supersession = service.match(
    /export async function supersedeIneligibleAiWorkflowJobRuntimes[\s\S]*?\n}\n\nfunction isRetryableFailureCode/,
  )?.[0];
  assert.ok(supersession);
  assert.doesNotMatch(supersession, /lockAndAssertRuntimeGates|assertWorkerEnvironmentEnabled/);
});

test('la Foundation non introduce processo, route, provider, AiRun o modifica il reconciler', () => {
  assert.equal(packageJson.scripts?.['ai:orchestrator:worker'], undefined);
  assert.doesNotMatch(service, /fetch\(|OpenAI|openai|axios|AiRun|aiRun|AiOutput|aiOutput/);
  assert.doesNotMatch(service, /applyAuditWorkflowTransition|WF-018|WF-019|WF-020|WF-021|WF-022|WF-023/);
  assert.match(service, /workflowTransitionApplied: false/);
  assert.equal(canonicalSha256({ provider: 'mock', dataMode: 'synthetic' }).length, 64);
});
