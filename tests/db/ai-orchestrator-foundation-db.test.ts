import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  Prisma,
  PrismaClient,
  type AiWorkflowJob,
  type AiWorkflowJobOutboxEvent,
} from '@prisma/client';
import { createAiAgentConfigHash } from '../../src/lib/ai-agent-config-hash';
import { canonicalSha256 } from '../../src/lib/canonical-json';
import {
  FAI_AUDIT_WORKFLOW_DEFINITION_HASH,
  getAuditWorkflowTransition,
} from '../../src/lib/ai-orchestrator/audit-workflow-v1-1';
import {
  FAI_AUDIT_JOB_CATALOG_HASH,
  FAI_AUDIT_JOB_CATALOG_KEY,
  FAI_AUDIT_JOB_CODES,
  FAI_AUDIT_JOB_DEFINITION_HASHES,
  FAI_AUDIT_JOB_EXECUTOR_BINDINGS,
} from '../../src/lib/ai-orchestrator/job-catalog-v1';
import {
  AI_ORCHESTRATOR_WORKER_CAPABILITIES,
  AI_ORCHESTRATOR_WORKER_CAPABILITY_HASHES,
  AI_ORCHESTRATOR_WORKER_RUNTIME_LIMITS,
  AI_ORCHESTRATOR_WORKER_RUNTIME_POLICY_CODE,
  AI_ORCHESTRATOR_WORKER_RUNTIME_POLICY_HASH,
  AI_ORCHESTRATOR_WORKER_RUNTIME_POLICY_VERSION,
  getAiOrchestratorWorkerCapability,
} from '../../src/lib/ai-orchestrator/worker-runtime-policy-v1';
import {
  applyAuditWorkflowTransition,
  createAuditWorkflowCommandRequestHash,
  createAuditWorkflowInstance,
  type ApplyAuditWorkflowTransitionInput,
  type AuditWorkflowActor,
} from '../../src/lib/ai-orchestrator/workflow-service';
import {
  admitAiWorkflowJobOutbox,
  AiOrchestratorLeaseLostError,
  AiOrchestratorWorkerDisabledError,
  claimNextAiWorkflowJob,
  completeAiWorkflowJob,
  failAiWorkflowJob,
  heartbeatAiWorkflowJobLease,
  recoverExpiredAiWorkflowJobLeases,
  surrenderAiWorkflowJobLease,
  supersedeIneligibleAiWorkflowJobRuntimes,
} from '../../src/lib/ai-orchestrator/worker-runtime';
import { createSyntheticAiResultDraft } from '../../src/lib/ai-orchestrator/result-artifact-contract-v1';

const dbTestsRequested = process.env.RUN_DB_TESTS === '1';
const destructiveDbTestsConfirmed = process.env.AI_ORCHESTRATOR_DB_TESTS_CONFIRMED === '1';

function assertDedicatedTestDatabase(databaseUrl: string | undefined) {
  if (!databaseUrl) throw new Error('DATABASE_URL obbligatorio per i test DB AI Orchestrator.');
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL non valido per i test DB AI Orchestrator.');
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  const schemaName = parsed.searchParams.get('schema') ?? 'public';
  const testNamePattern = /(^|[_-])test($|[_-])/i;
  if (!testNamePattern.test(databaseName) && !testNamePattern.test(schemaName)) {
    throw new Error('I test DB AI Orchestrator richiedono un database o schema dedicato con "test" nel nome.');
  }
}

if (dbTestsRequested && !destructiveDbTestsConfirmed) {
  throw new Error('Impostare AI_ORCHESTRATOR_DB_TESTS_CONFIRMED=1 per confermare il database effimero dedicato.');
}
if (dbTestsRequested) assertDedicatedTestDatabase(process.env.DATABASE_URL);

const runDbTests = dbTestsRequested && destructiveDbTestsConfirmed;
const prisma = runDbTests ? new PrismaClient() : null;
const runId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const safeEnv = { ...process.env, AI_EXTERNAL_PROVIDERS_ENABLED: 'false' };
const passwordHash = 'not-a-real-login-hash';
const originalWorkerGate = process.env.AI_ORCHESTRATOR_WORKER_ENABLED;
let workerRuntimeDispatchFixtureOpen = false;

let runnerId = '';
let reviewerId = '';
let limitedId = '';
let roleRunnerId = '';
let overrideRunnerId = '';
let agentId = '';
let migrationDefaults: {
  stateMachineEnabled: boolean;
  dispatchEnabled: boolean;
  syntheticDataOnly: boolean;
  provider: string;
} | null = null;

function db() {
  if (!prisma) throw new Error('DB tests disabled');
  return prisma;
}

function assertConfirmedRuntimeDbFixture() {
  if (!runDbTests || !dbTestsRequested || !destructiveDbTestsConfirmed) {
    throw new Error('Fixture runtime consentita soltanto nel PostgreSQL effimero confermato.');
  }
}

async function dispatchConstraintState(client: PrismaClient | Prisma.TransactionClient = db()) {
  const rows = await client.$queryRaw<Array<{ present: boolean; validated: boolean }>>(Prisma.sql`
    SELECT true AS "present", constraint_row."convalidated" AS "validated"
    FROM pg_constraint constraint_row
    JOIN pg_class table_row ON table_row.oid = constraint_row."conrelid"
    WHERE table_row."relname" = 'AiOrchestratorSetting'
      AND table_row."relnamespace" = TO_REGNAMESPACE(CURRENT_SCHEMA())
      AND constraint_row."conname" = 'AiOrchestratorSetting_dispatch_disabled_check'
  `);
  return rows[0] ?? { present: false, validated: false };
}

async function restorePhysicalDispatchBarrier() {
  if (!runDbTests) return;
  assertConfirmedRuntimeDbFixture();
  await db().$executeRawUnsafe(
    'UPDATE "AiOrchestratorSetting" SET "dispatchEnabled" = false WHERE "id" = \'global\'',
  );
  const constraint = await dispatchConstraintState();
  if (!constraint.present) {
    await db().$executeRawUnsafe(
      'ALTER TABLE "AiOrchestratorSetting" ADD CONSTRAINT "AiOrchestratorSetting_dispatch_disabled_check" CHECK ("dispatchEnabled" = false) NOT VALID',
    );
  }
  await db().$executeRawUnsafe(
    'ALTER TABLE "AiOrchestratorSetting" VALIDATE CONSTRAINT "AiOrchestratorSetting_dispatch_disabled_check"',
  );
  assert.deepEqual(await dispatchConstraintState(), { present: true, validated: true });
}

async function withTemporaryDispatchFixture<T>(
  callback: () => Promise<T>,
  options: { enabledJobCodes?: readonly string[] } = {},
) {
  assertConfirmedRuntimeDbFixture();
  if (workerRuntimeDispatchFixtureOpen) throw new Error('Fixture dispatch runtime già aperta.');
  await restorePhysicalDispatchBarrier();
  await db().$executeRawUnsafe(
    'ALTER TABLE "AiOrchestratorSetting" DROP CONSTRAINT "AiOrchestratorSetting_dispatch_disabled_check"',
  );
  workerRuntimeDispatchFixtureOpen = true;
  try {
    await setWorkerRuntimeGates(true, true);
    await setWorkerCapabilityGates(options.enabledJobCodes ?? FAI_AUDIT_JOB_CODES);
    return await callback();
  } finally {
    try {
      await setWorkerCapabilityGates([]);
    } finally {
      try {
        await db().$executeRawUnsafe(
          'UPDATE "AiOrchestratorSetting" SET "dispatchEnabled" = false WHERE "id" = \'global\'',
        );
      } finally {
        workerRuntimeDispatchFixtureOpen = false;
        await restorePhysicalDispatchBarrier();
      }
    }
  }
}

async function withRuntimeClockFixture(
  callback: (tx: Prisma.TransactionClient) => Promise<void>,
  options: { rewriteRuntimeEvents?: boolean } = {},
) {
  assertConfirmedRuntimeDbFixture();
  let runtimeProtectionDisabled = false;
  let attemptProtectionDisabled = false;
  let eventProtectionDisabled = false;
  try {
    await db().$executeRawUnsafe(
      'ALTER TABLE "AiWorkflowJobRuntime" DISABLE TRIGGER "AiWorkflowJobRuntime_protect_update"',
    );
    runtimeProtectionDisabled = true;
    await db().$executeRawUnsafe(
      'ALTER TABLE "AiWorkflowJobAttempt" DISABLE TRIGGER "AiWorkflowJobAttempt_protect_update"',
    );
    attemptProtectionDisabled = true;
    if (options.rewriteRuntimeEvents) {
      await db().$executeRawUnsafe(
        'ALTER TABLE "AiWorkflowJobRuntimeEvent" DISABLE TRIGGER "AiWorkflowJobRuntimeEvent_immutable_update"',
      );
      eventProtectionDisabled = true;
    }
    await db().$transaction(async (tx) => {
      await callback(tx);
    });
  } finally {
    try {
      if (eventProtectionDisabled) {
        await db().$executeRawUnsafe(
          'ALTER TABLE "AiWorkflowJobRuntimeEvent" ENABLE TRIGGER "AiWorkflowJobRuntimeEvent_immutable_update"',
        );
      }
    } finally {
      try {
        if (attemptProtectionDisabled) {
          await db().$executeRawUnsafe(
            'ALTER TABLE "AiWorkflowJobAttempt" ENABLE TRIGGER "AiWorkflowJobAttempt_protect_update"',
          );
        }
      } finally {
        if (runtimeProtectionDisabled) {
          await db().$executeRawUnsafe(
            'ALTER TABLE "AiWorkflowJobRuntime" ENABLE TRIGGER "AiWorkflowJobRuntime_protect_update"',
          );
        }
      }
    }
  }
}

async function expireLeaseForTest(runtimeId: string) {
  await withRuntimeClockFixture(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ now: Date }>>(Prisma.sql`
      SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "now"
    `);
    const now = rows[0]?.now;
    assert.ok(now);
    const runtime = await tx.aiWorkflowJobRuntime.findUniqueOrThrow({
      where: { id: runtimeId },
    });
    const claimedEvent = await tx.aiWorkflowJobRuntimeEvent.findFirstOrThrow({
      where: {
        runtimeId,
        eventType: 'CLAIMED',
        attemptSequence: runtime.attemptSequence,
        fencingToken: runtime.fencingToken,
      },
    });
    const latestEvent = await tx.aiWorkflowJobRuntimeEvent.findFirstOrThrow({
      where: { runtimeId },
      orderBy: { sequence: 'desc' },
      select: { id: true },
    });
    assert.equal(latestEvent.id, claimedEvent.id);

    const claimedAt = new Date(now.getTime() - 130_000);
    const leaseExpiresAt = new Date(claimedAt.getTime() + 120_000);
    const leaseMaxExpiresAt = new Date(claimedAt.getTime() + 600_000);
    const payload = {
      ...(claimedEvent.payload as Record<string, string | number | boolean | null>),
      leaseExpiresAt: leaseExpiresAt.toISOString(),
      leaseMaxExpiresAt: leaseMaxExpiresAt.toISOString(),
    };
    const payloadHash = canonicalSha256(payload);
    const eventHash = canonicalSha256({
      schemaVersion: 1,
      runtimeId,
      jobId: runtime.jobId,
      workflowInstanceId: runtime.workflowInstanceId,
      sequence: claimedEvent.sequence,
      eventType: 'CLAIMED',
      attemptSequence: runtime.attemptSequence,
      fencingToken: String(runtime.fencingToken),
      reasonCode: null,
      payloadHash,
      previousEventHash: claimedEvent.previousEventHash,
      occurredAt: claimedAt.toISOString(),
    });
    await tx.aiWorkflowJobRuntime.update({
      where: { id: runtimeId },
      data: { leaseClaimedAt: claimedAt, leaseExpiresAt, leaseMaxExpiresAt },
    });
    await tx.aiWorkflowJobAttempt.update({
      where: {
        runtimeId_attemptSequence: {
          runtimeId,
          attemptSequence: runtime.attemptSequence,
        },
      },
      data: { claimedAt, leaseExpiresAt, leaseMaxExpiresAt },
    });
    await tx.aiWorkflowJobRuntimeEvent.update({
      where: { id: claimedEvent.id },
      data: {
        occurredAt: claimedAt,
        payload,
        payloadHash,
        eventHash,
      },
    });
  }, { rewriteRuntimeEvents: true });
}

async function makeRetryImmediatelyAvailableForTest(runtimeId: string) {
  await withRuntimeClockFixture(async (tx) => {
    const runtime = await tx.aiWorkflowJobRuntime.findUniqueOrThrow({
      where: { id: runtimeId },
    });
    assert.equal(runtime.state, 'RETRY_WAIT');
    const terminalEvent = await tx.aiWorkflowJobRuntimeEvent.findFirstOrThrow({
      where: {
        runtimeId,
        attemptSequence: runtime.attemptSequence,
        fencingToken: runtime.fencingToken,
        eventType: { in: ['RETRY_SCHEDULED', 'LEASE_RECOVERED'] },
      },
      orderBy: { sequence: 'desc' },
    });
    const latestEvent = await tx.aiWorkflowJobRuntimeEvent.findFirstOrThrow({
      where: { runtimeId },
      orderBy: { sequence: 'desc' },
      select: { id: true },
    });
    assert.equal(latestEvent.id, terminalEvent.id);
    const nextAvailableAt = new Date('2000-01-01T00:00:00.000Z');
    const payload = {
      ...(terminalEvent.payload as Record<string, string | number | boolean | null>),
      nextAvailableAt: nextAvailableAt.toISOString(),
    };
    const payloadHash = canonicalSha256(payload);
    const eventHash = canonicalSha256({
      schemaVersion: 1,
      runtimeId,
      jobId: runtime.jobId,
      workflowInstanceId: runtime.workflowInstanceId,
      sequence: terminalEvent.sequence,
      eventType: terminalEvent.eventType,
      attemptSequence: terminalEvent.attemptSequence,
      fencingToken: String(terminalEvent.fencingToken),
      reasonCode: terminalEvent.reasonCode,
      payloadHash,
      previousEventHash: terminalEvent.previousEventHash,
      occurredAt: terminalEvent.occurredAt.toISOString(),
    });
    const updatedRuntime = await tx.$executeRaw(Prisma.sql`
      UPDATE "AiWorkflowJobRuntime"
      SET "effectiveAvailableAt" = ${nextAvailableAt},
        "updatedAt" = clock_timestamp() AT TIME ZONE 'UTC'
      WHERE "id" = ${runtimeId}
    `);
    assert.equal(updatedRuntime, 1);
    const updatedAttempt = await tx.$executeRaw(Prisma.sql`
      UPDATE "AiWorkflowJobAttempt"
      SET "nextAvailableAt" = ${nextAvailableAt}
      WHERE "runtimeId" = ${runtimeId}
        AND "attemptSequence" = ${runtime.attemptSequence}
    `);
    assert.equal(updatedAttempt, 1);
    await tx.aiWorkflowJobRuntimeEvent.update({
      where: { id: terminalEvent.id },
      data: { payload, payloadHash, eventHash },
    });
    assert.equal((await tx.aiWorkflowJobRuntime.findUniqueOrThrow({
      where: { id: runtimeId },
      select: { effectiveAvailableAt: true },
    })).effectiveAvailableAt.toISOString(), '2000-01-01T00:00:00.000Z');
  }, { rewriteRuntimeEvents: true });
}

async function assertRuntimeReadyForRetryClaim(runtimeId: string) {
  const rows = await db().$queryRaw<Array<{
    state: string;
    available: boolean;
    current: boolean;
    executorValid: boolean;
    capabilityEnabled: boolean;
    activeGlobal: number;
    activeWorkflow: number;
    activeExecutor: number;
    effectiveAvailableAt: string;
    databaseNow: string;
  }>>(Prisma.sql`
    SELECT runtime."state",
      runtime."effectiveAvailableAt" <= (clock_timestamp() AT TIME ZONE 'UTC') AS "available",
      TO_CHAR(runtime."effectiveAvailableAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS "effectiveAvailableAt",
      TO_CHAR(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS "databaseNow",
      "ai_workflow_runtime_job_is_current"(runtime."jobId") AS "current",
      "ai_workflow_runtime_executor_is_valid"(runtime."jobId") AS "executorValid",
      "ai_workflow_runtime_capability_enabled"(runtime."jobId") AS "capabilityEnabled",
      (SELECT COUNT(*)::INTEGER FROM "AiWorkflowJobRuntime" active
        WHERE active."state" = 'LEASED'
          AND active."leaseExpiresAt" > clock_timestamp() AT TIME ZONE 'UTC') AS "activeGlobal",
      (SELECT COUNT(*)::INTEGER FROM "AiWorkflowJobRuntime" active
        WHERE active."state" = 'LEASED'
          AND active."leaseExpiresAt" > clock_timestamp() AT TIME ZONE 'UTC'
          AND active."workflowInstanceId" = runtime."workflowInstanceId") AS "activeWorkflow",
      (SELECT COUNT(*)::INTEGER
        FROM "AiWorkflowJobRuntime" active
        JOIN "AiWorkflowJob" active_job ON active_job."id" = active."jobId"
        WHERE active."state" = 'LEASED'
          AND active."leaseExpiresAt" > clock_timestamp() AT TIME ZONE 'UTC'
          AND active_job."executorAgentId" = job."executorAgentId"
          AND active_job."executorAgentConfigVersion" = job."executorAgentConfigVersion") AS "activeExecutor"
    FROM "AiWorkflowJobRuntime" runtime
    JOIN "AiWorkflowJob" job ON job."id" = runtime."jobId"
    WHERE runtime."id" = ${runtimeId}
  `);
  const row = rows[0];
  assert.ok(row, 'Runtime retry non trovato.');
  const diagnostic = JSON.stringify(row);
  assert.equal(row.state, 'RETRY_WAIT', diagnostic);
  assert.equal(row.available, true, diagnostic);
  assert.equal(row.current, true, diagnostic);
  assert.equal(row.executorValid, true, diagnostic);
  assert.equal(row.capabilityEnabled, true, diagnostic);
  assert.equal(row.activeGlobal, 0, diagnostic);
  assert.equal(row.activeWorkflow, 0, diagnostic);
  assert.equal(row.activeExecutor, 0, diagnostic);
}

async function createUser(name: string, role: 'admin' | 'collaboratore_limitato' | 'consulente') {
  return db().user.create({
    data: {
      email: `${name}-${runId}@example.test`,
      name: `${name}-${runId}`,
      passwordHash,
      role,
      active: true,
    },
  });
}

test.before(async () => {
  if (!runDbTests) return;
  const setting = await db().aiOrchestratorSetting.findUniqueOrThrow({ where: { id: 'global' } });
  migrationDefaults = {
    stateMachineEnabled: setting.stateMachineEnabled,
    dispatchEnabled: setting.dispatchEnabled,
    syntheticDataOnly: setting.syntheticDataOnly,
    provider: setting.provider,
  };
  await db().aiOrchestratorSetting.update({
    where: { id: 'global' },
    data: {
      stateMachineEnabled: true,
      dispatchEnabled: false,
      syntheticDataOnly: true,
      provider: 'mock',
    },
  });
  await db().aiControlSetting.upsert({
    where: { id: 'global' },
    create: { id: 'global', externalProvidersEnabled: false, maxExternalRunsPerUserPerHour: 10 },
    update: { externalProvidersEnabled: false },
  });

  const [runner, reviewer, limited, roleRunner, overrideRunner] = await Promise.all([
    createUser('orchestrator-runner', 'admin'),
    createUser('orchestrator-reviewer', 'admin'),
    createUser('orchestrator-limited', 'collaboratore_limitato'),
    createUser('orchestrator-role-runner', 'consulente'),
    createUser('orchestrator-override-runner', 'collaboratore_limitato'),
  ]);
  runnerId = runner.id;
  reviewerId = reviewer.id;
  limitedId = limited.id;
  roleRunnerId = roleRunner.id;
  overrideRunnerId = overrideRunner.id;
  await db().userPermissionOverride.create({
    data: { userId: overrideRunnerId, permission: 'ai.run', allowed: true },
  });

  const agent = await db().aiAgent.create({
    data: {
      code: `orchestrator-mock-${runId}`,
      name: 'Orchestrator mock test agent',
      description: 'Synthetic DB test only',
      operationalScope: 'Synthetic workflow transition tests',
      systemPrompt: 'No external calls.',
      requiredDataChecklist: [],
      expectedOutput: 'Synthetic result',
      toneStyle: 'technical',
      active: true,
      provider: 'mock',
      promptVersion: 'test-v1',
      configVersion: 1,
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
    },
  });
  agentId = agent.id;
  await db().aiAgentConfigVersion.create({
    data: {
      agentId,
      version: 1,
      code: agent.code,
      name: agent.name,
      description: agent.description,
      operationalScope: agent.operationalScope,
      systemPrompt: agent.systemPrompt,
      requiredDataChecklist: [],
      expectedOutput: agent.expectedOutput,
      toneStyle: agent.toneStyle,
      active: true,
      provider: 'mock',
      model: null,
      promptVersion: agent.promptVersion,
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      createdById: runnerId,
    },
  });
});

test.after(async () => {
  if (!runDbTests || !prisma) return;
  workerRuntimeDispatchFixtureOpen = false;
  await setWorkerCapabilityGates([]);
  await restorePhysicalDispatchBarrier();
  if (migrationDefaults) {
    await db().aiOrchestratorSetting.update({ where: { id: 'global' }, data: migrationDefaults });
  }
  await db().aiControlSetting.updateMany({ where: { id: 'global' }, data: { externalProvidersEnabled: false } });
  if (originalWorkerGate === undefined) delete process.env.AI_ORCHESTRATOR_WORKER_ENABLED;
  else process.env.AI_ORCHESTRATOR_WORKER_ENABLED = originalWorkerGate;
  await db().$disconnect();
});

const human = (userId: string): AuditWorkflowActor => ({ kind: 'HUMAN', userId });
const agent = (): AuditWorkflowActor => ({ kind: 'AGENT', agentId, agentConfigVersion: 1 });
const system = (): AuditWorkflowActor => ({
  kind: 'SYSTEM',
  systemCode: 'AI_ORCHESTRATOR',
  executionMode: 'WORKER',
});

async function createCase(userId = runnerId, creationKey = randomUUID()) {
  const result = await createAuditWorkflowInstance(db(), {
    creationKey,
    expectedDefinitionHash: FAI_AUDIT_WORKFLOW_DEFINITION_HASH,
    actor: { kind: 'HUMAN', userId },
  }, { env: safeEnv });
  if (!result.ok) assert.fail(`${result.code}: ${result.message}`);
  return result;
}

async function canonicalTransitionInput(
  workflowInstanceId: string,
  transitionCode: string,
  actor: AuditWorkflowActor,
  overrides: Partial<ApplyAuditWorkflowTransitionInput> = {},
): Promise<ApplyAuditWorkflowTransitionInput> {
  const definition = getAuditWorkflowTransition(transitionCode);
  assert.ok(definition, `Transizione ${transitionCode} non trovata`);
  const instance = await db().aiWorkflowInstance.findUniqueOrThrow({ where: { id: workflowInstanceId } });
  return {
    workflowInstanceId,
    transitionCode,
    idempotencyKey: randomUUID(),
    correlationId: randomUUID(),
    expectedDefinitionHash: FAI_AUDIT_WORKFLOW_DEFINITION_HASH,
    expectedState: definition.from,
    expectedStateVersion: instance.stateVersion,
    actor,
    gateResults: { [definition.gate]: 'PASS' },
    preconditions: Object.fromEntries(definition.preconditions.map((item) => [item, true])),
    manualReleaseConfirmed: definition.manualReleaseOnly ? true : undefined,
    reasonCode: definition.reasonCodeRequired ? 'SYNTHETIC_TEST_REASON' : undefined,
    ...overrides,
  };
}

async function transitionInput(
  workflowInstanceId: string,
  transitionCode: string,
  actor: AuditWorkflowActor,
  overrides: Partial<ApplyAuditWorkflowTransitionInput> = {},
): Promise<ApplyAuditWorkflowTransitionInput> {
  const definition = getAuditWorkflowTransition(transitionCode);
  assert.ok(definition, `Transizione ${transitionCode} non trovata`);
  const instance = await db().aiWorkflowInstance.findUniqueOrThrow({ where: { id: workflowInstanceId } });
  assert.equal(instance.currentState, definition.from, `${transitionCode} non applicabile da ${instance.currentState}`);
  return canonicalTransitionInput(workflowInstanceId, transitionCode, actor, overrides);
}

async function applyCode(
  workflowInstanceId: string,
  transitionCode: string,
  actor: AuditWorkflowActor,
  overrides: Partial<ApplyAuditWorkflowTransitionInput> = {},
) {
  const input = await transitionInput(workflowInstanceId, transitionCode, actor, overrides);
  return applyAuditWorkflowTransition(db(), input, { env: safeEnv });
}

async function applyOk(workflowInstanceId: string, transitionCode: string, actor: AuditWorkflowActor) {
  const result = await applyCode(workflowInstanceId, transitionCode, actor);
  if (!result.ok) assert.fail(`${result.code}: ${result.message}`);
  return result;
}

async function advanceToDataValidation(workflowInstanceId: string) {
  await applyOk(workflowInstanceId, 'WF-001', human(runnerId));
  await applyOk(workflowInstanceId, 'WF-002', human(runnerId));
  await applyOk(workflowInstanceId, 'WF-003', human(runnerId));
  await applyOk(workflowInstanceId, 'WF-004', human(runnerId));
}

async function completeDataValidation(workflowInstanceId: string) {
  await applyOk(workflowInstanceId, 'WF-005', agent());
  await applyOk(workflowInstanceId, 'WF-006', agent());
  await applyOk(workflowInstanceId, 'WF-007', agent());
  await applyOk(workflowInstanceId, 'WF-010', human(runnerId));
}

async function advanceToIndependentReview(workflowInstanceId: string) {
  await advanceToDataValidation(workflowInstanceId);
  await completeDataValidation(workflowInstanceId);
  await applyOk(workflowInstanceId, 'WF-011', system());
  await applyOk(workflowInstanceId, 'WF-012', agent());
  await applyOk(workflowInstanceId, 'WF-013', agent());
}

function asJsonObject(value: unknown, label: string): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} deve essere un oggetto JSON`);
  return value as Record<string, unknown>;
}

function asJsonArray(value: unknown, label: string): unknown[] {
  assert.ok(Array.isArray(value), `${label} deve essere un array JSON`);
  return value;
}

function collectJsonKeys(value: unknown, keys: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectJsonKeys(item, keys);
    return keys;
  }
  if (!value || typeof value !== 'object') return keys;
  for (const [key, item] of Object.entries(value)) {
    keys.push(key);
    collectJsonKeys(item, keys);
  }
  return keys;
}

type DirectActor =
  | { kind: 'HUMAN'; userId: string }
  | { kind: 'AGENT'; agentId: string; version: number }
  | { kind: 'SYSTEM'; systemCode: 'AI_ORCHESTRATOR' };

const directMilestonePolicy: Record<string, {
  phase: 'DATA_VALIDATION' | 'AI_DRAFT' | 'INDEPENDENT_REVIEW';
  canonical: string[];
  required: string[];
}> = {
  'WF-005': { phase: 'DATA_VALIDATION', canonical: ['WF-005', 'WF-006', 'WF-007'], required: [] },
  'WF-006': { phase: 'DATA_VALIDATION', canonical: ['WF-005', 'WF-006', 'WF-007'], required: ['WF-005'] },
  'WF-007': { phase: 'DATA_VALIDATION', canonical: ['WF-005', 'WF-006', 'WF-007'], required: ['WF-005', 'WF-006'] },
  'WF-010': { phase: 'DATA_VALIDATION', canonical: ['WF-005', 'WF-006', 'WF-007'], required: ['WF-005', 'WF-006', 'WF-007'] },
  'WF-012': { phase: 'AI_DRAFT', canonical: ['WF-012'], required: [] },
  'WF-013': { phase: 'AI_DRAFT', canonical: ['WF-012'], required: ['WF-012'] },
  'WF-014': { phase: 'INDEPENDENT_REVIEW', canonical: ['WF-014'], required: [] },
  'WF-015': { phase: 'INDEPENDENT_REVIEW', canonical: ['WF-014'], required: ['WF-014'] },
  'WF-017': { phase: 'INDEPENDENT_REVIEW', canonical: ['WF-014'], required: ['WF-014'] },
};

function directGuardSnapshot(
  transitionCode: string,
  actorKind: DirectActor['kind'],
  correctionCycle = 0,
  phaseEntrySequence = 1,
): Prisma.InputJsonObject {
  const definition = getAuditWorkflowTransition(transitionCode);
  assert.ok(definition, `Transizione snapshot ${transitionCode} non trovata`);
  const milestonePolicy = directMilestonePolicy[transitionCode];
  return {
    schemaVersion: 1,
    actor: { kind: actorKind, humanRole: actorKind === 'HUMAN' ? 'admin' : null },
    permission: {
      required: definition.requiredPermission,
      granted: true,
      source: definition.requiredPermission === null ? 'NOT_REQUIRED' : 'ADMIN',
    },
    correctionCycle,
    orchestratorSetting: {
      id: 'global',
      stateMachineEnabled: true,
      dispatchEnabled: false,
      provider: 'mock',
      syntheticDataOnly: true,
      version: 1,
      updatedAt: '2026-07-17T12:00:00.000Z',
    },
    providerPolicy: {
      databaseExternalProvidersEnabled: false,
      environmentExternalProvidersEnabled: false,
      effectiveExternalProvidersEnabled: false,
    },
    foundationPolicy: { transitionInScope: true, automaticDispatchAllowed: false },
    gate: { code: definition.gate, result: 'PASS', passed: true },
    preconditions: definition.preconditions.map((code) => ({ code, result: true, passed: true })),
    milestone: milestonePolicy
      ? {
          phase: milestonePolicy.phase,
          phaseEntrySequence,
          canonicalTransitionCodes: milestonePolicy.canonical,
          requiredTransitionCodes: milestonePolicy.required,
          completedTransitionCodes: milestonePolicy.required,
          decision: 'SATISFIED',
        }
      : {
          phase: null,
          phaseEntrySequence: null,
          canonicalTransitionCodes: [],
          requiredTransitionCodes: [],
          completedTransitionCodes: [],
          decision: 'NOT_REQUIRED',
        },
    separationChecks: [
      {
        code: 'HUMAN_REVIEW_BOUNDARY',
        applied: transitionCode === 'WF-017',
        result: transitionCode === 'WF-017' ? 'PASSED' : 'NOT_APPLICABLE',
      },
      {
        code: 'REVIEWER_APPROVER_SEPARATION',
        applied: false,
        result: 'NOT_APPLICABLE_FOUNDATION_SCOPE',
      },
      {
        code: 'APPROVER_RELEASE_SEPARATION',
        applied: false,
        result: 'NOT_APPLICABLE_FOUNDATION_SCOPE',
      },
    ],
  };
}

async function attemptDirectLedgerAppend(
  tx: Prisma.TransactionClient,
  workflowInstanceId: string,
  transitionCode: string,
  actor: DirectActor,
  snapshotOverride?: {
    guardSnapshot?: Prisma.InputJsonObject;
    guardSnapshotHash?: string;
  },
) {
  const definition = getAuditWorkflowTransition(transitionCode);
  assert.ok(definition, `Transizione diretta ${transitionCode} non trovata`);
  const instance = await tx.aiWorkflowInstance.findUniqueOrThrow({ where: { id: workflowInstanceId } });
  const previous = await tx.aiWorkflowTransition.findFirst({
    where: { workflowInstanceId },
    orderBy: { sequence: 'desc' },
  });
  const now = new Date();
  const correlationId = randomUUID();
  const command = await tx.aiWorkflowCommand.create({
    data: {
      workflowInstanceId,
      transitionCode: definition.transitionCode,
      eventType: definition.event,
      idempotencyKey: randomUUID(),
      requestHash: canonicalSha256({ fixture: 'direct-command', correlationId }),
      definitionHash: FAI_AUDIT_WORKFLOW_DEFINITION_HASH,
      expectedState: definition.from,
      expectedStateVersion: instance.stateVersion,
      actorKind: actor.kind,
      requestedByUserId: actor.kind === 'HUMAN' ? actor.userId : null,
      requestedByAgentId: actor.kind === 'AGENT' ? actor.agentId : null,
      requestedByAgentConfigVersion: actor.kind === 'AGENT' ? actor.version : null,
      requestedBySystemCode: actor.kind === 'SYSTEM' ? actor.systemCode : null,
      correlationId,
      status: 'PENDING',
      createdAt: now,
    },
  });
  const nextCorrectionCycle = definition.incrementsCorrectionCycle
    ? instance.correctionCycle + 1
    : instance.correctionCycle;
  let phaseEntrySequence = 1;
  if (directMilestonePolicy[transitionCode]) {
    const phaseEntryCodes = directMilestonePolicy[transitionCode]?.phase === 'DATA_VALIDATION'
      ? ['WF-004', 'WF-009']
      : directMilestonePolicy[transitionCode]?.phase === 'AI_DRAFT'
        ? ['WF-011']
        : ['WF-013', 'WF-016'];
    const phaseEntry = await tx.aiWorkflowTransition.findFirst({
      where: { workflowInstanceId, transitionCode: { in: phaseEntryCodes } },
      orderBy: { sequence: 'desc' },
      select: { sequence: true },
    });
    phaseEntrySequence = phaseEntry?.sequence ?? 1;
  }
  await tx.aiWorkflowInstance.update({
    where: { id: workflowInstanceId },
    data: {
      currentState: definition.to,
      stateVersion: instance.stateVersion + 1,
      correctionCycle: nextCorrectionCycle,
      lastTransitionAt: now,
    },
  });
  const guardSnapshot = snapshotOverride?.guardSnapshot ?? directGuardSnapshot(
    transitionCode,
    actor.kind,
    instance.correctionCycle,
    phaseEntrySequence,
  );
  const guardSnapshotHash = snapshotOverride?.guardSnapshotHash ?? canonicalSha256(guardSnapshot);
  await tx.aiWorkflowTransition.create({
    data: {
      workflowInstanceId,
      commandId: command.id,
      transitionCode: definition.transitionCode,
      eventType: definition.event,
      sequence: instance.stateVersion,
      fromState: definition.from,
      toState: definition.to,
      fromVersion: instance.stateVersion,
      toVersion: instance.stateVersion + 1,
      definitionHash: FAI_AUDIT_WORKFLOW_DEFINITION_HASH,
      guardSnapshot,
      guardSnapshotHash,
      previousTransitionHash: previous?.transitionHash ?? null,
      transitionHash: canonicalSha256({ fixture: 'direct-transition', correlationId }),
      actorKind: actor.kind,
      actorUserId: actor.kind === 'HUMAN' ? actor.userId : null,
      actorAgentId: actor.kind === 'AGENT' ? actor.agentId : null,
      actorAgentConfigVersion: actor.kind === 'AGENT' ? actor.version : null,
      actorSystemCode: actor.kind === 'SYSTEM' ? actor.systemCode : null,
      reasonCode: definition.reasonCodeRequired ? 'SYNTHETIC_DIRECT_TEST' : null,
      correlationId,
      metadata: { automaticDispatchAllowed: false, fixture: 'synthetic-db-negative-test' },
      createdAt: now,
    },
  });
  await tx.aiWorkflowCommand.update({
    where: { id: command.id },
    data: {
      status: 'APPLIED',
      resultState: definition.to,
      resultStateVersion: instance.stateVersion + 1,
      resolvedAt: now,
    },
  });
}

test('la migration crea il singleton fail-closed con state machine e dispatch disabilitati', { skip: !runDbTests }, () => {
  assert.deepEqual(migrationDefaults, {
    stateMachineEnabled: false,
    dispatchEnabled: false,
    syntheticDataOnly: true,
    provider: 'mock',
  });
});

test('la catena production preserva la barriera fisica dispatch PR74', { skip: !runDbTests }, async () => {
  assert.deepEqual(await dispatchConstraintState(), { present: true, validated: true });
  await assert.rejects(db().$executeRawUnsafe(
    'UPDATE "AiOrchestratorSetting" SET "dispatchEnabled" = true WHERE "id" = \'global\'',
  ));
  const setting = await db().aiOrchestratorSetting.findUniqueOrThrow({ where: { id: 'global' } });
  assert.equal(setting.dispatchEnabled, false);
  assert.deepEqual(await dispatchConstraintState(), { present: true, validated: true });
});

test('state machine e dispatch sono flag distinti e la foundation non autorizza mai dispatch', { skip: !runDbTests }, async () => {
  const enabledCreationKey = randomUUID();
  const enabledCase = await createCase(runnerId, enabledCreationKey);
  const enabledId = enabledCase.value.workflowInstanceId;
  const enabledInput = await transitionInput(enabledId, 'WF-001', human(runnerId));
  const planningCase = await createCase();
  const planningId = planningCase.value.workflowInstanceId;
  await applyOk(planningId, 'WF-001', human(runnerId));
  await applyOk(planningId, 'WF-002', human(runnerId));
  await applyOk(planningId, 'WF-003', human(runnerId));
  const disabledPlanningInput = await transitionInput(planningId, 'WF-004', human(runnerId));

  await db().aiOrchestratorSetting.update({
    where: { id: 'global' },
    data: { stateMachineEnabled: false, dispatchEnabled: false },
  });
  try {
    const deniedCreation = await createAuditWorkflowInstance(db(), {
      creationKey: randomUUID(),
      expectedDefinitionHash: FAI_AUDIT_WORKFLOW_DEFINITION_HASH,
      actor: { kind: 'HUMAN', userId: runnerId },
    }, { env: safeEnv });
    assert.equal(deniedCreation.ok, false);
    if (!deniedCreation.ok) assert.equal(deniedCreation.code, 'ORCHESTRATOR_DISABLED');

    const deniedCreationReplay = await createAuditWorkflowInstance(db(), {
      creationKey: enabledCreationKey,
      expectedDefinitionHash: FAI_AUDIT_WORKFLOW_DEFINITION_HASH,
      actor: { kind: 'HUMAN', userId: runnerId },
    }, { env: safeEnv });
    assert.equal(deniedCreationReplay.ok, false);
    if (!deniedCreationReplay.ok) assert.equal(deniedCreationReplay.code, 'ORCHESTRATOR_DISABLED');

    const deniedTransition = await applyAuditWorkflowTransition(db(), enabledInput, { env: safeEnv });
    assert.equal(deniedTransition.ok, false);
    if (!deniedTransition.ok) assert.equal(deniedTransition.code, 'ORCHESTRATOR_DISABLED');
    assert.deepEqual(
      await db().aiWorkflowInstance.findUniqueOrThrow({
        where: { id: enabledId },
        select: { currentState: true, stateVersion: true, correctionCycle: true },
      }),
      { currentState: 'CREATED', stateVersion: 1, correctionCycle: 0 },
    );
    assert.equal(await db().aiWorkflowCommand.count({ where: { workflowInstanceId: enabledId } }), 0);
    assert.equal(await db().aiWorkflowTransition.count({ where: { workflowInstanceId: enabledId } }), 0);
    const deniedPlanning = await applyAuditWorkflowTransition(db(), disabledPlanningInput, { env: safeEnv });
    assert.equal(deniedPlanning.ok, false);
    if (!deniedPlanning.ok) assert.equal(deniedPlanning.code, 'ORCHESTRATOR_DISABLED');
    assert.equal(await db().aiWorkflowJob.count({ where: { workflowInstanceId: planningId } }), 0);
    assert.equal(await db().aiWorkflowJobOutboxEvent.count({ where: { workflowInstanceId: planningId } }), 0);
  } finally {
    await db().aiOrchestratorSetting.update({
      where: { id: 'global' },
      data: { stateMachineEnabled: true, dispatchEnabled: false },
    });
  }

  const allowed = await applyAuditWorkflowTransition(db(), enabledInput, { env: safeEnv });
  assert.equal(allowed.ok, true);
  if (!allowed.ok) return;
  const transition = await db().aiWorkflowTransition.findUniqueOrThrow({
    where: { id: allowed.value.transitionId },
  });
  const metadata = asJsonObject(transition.metadata, 'metadata');
  assert.equal(metadata.automaticDispatchAllowed, false);
  const currentSetting = await db().aiOrchestratorSetting.findUniqueOrThrow({ where: { id: 'global' } });
  assert.equal(currentSetting.stateMachineEnabled, true);
  assert.equal(currentSetting.dispatchEnabled, false);

  await db().aiOrchestratorSetting.update({
    where: { id: 'global' },
    data: { stateMachineEnabled: false, dispatchEnabled: false },
  });
  try {
    const deniedTransitionReplay = await applyAuditWorkflowTransition(db(), enabledInput, { env: safeEnv });
    assert.equal(deniedTransitionReplay.ok, false);
    if (!deniedTransitionReplay.ok) assert.equal(deniedTransitionReplay.code, 'ORCHESTRATOR_DISABLED');
    assert.equal(await db().aiWorkflowCommand.count({ where: { workflowInstanceId: enabledId } }), 1);
    assert.equal(await db().aiWorkflowTransition.count({ where: { workflowInstanceId: enabledId } }), 1);
  } finally {
    await db().aiOrchestratorSetting.update({
      where: { id: 'global' },
      data: { stateMachineEnabled: true, dispatchEnabled: false },
    });
  }
});

test('creazione concorrente usa una sola istanza e restituisce replay idempotente', { skip: !runDbTests }, async () => {
  const creationKey = randomUUID();
  const input = {
    creationKey,
    expectedDefinitionHash: FAI_AUDIT_WORKFLOW_DEFINITION_HASH,
    actor: { kind: 'HUMAN' as const, userId: runnerId },
  };
  const [first, second] = await Promise.all([
    createAuditWorkflowInstance(db(), input, { env: safeEnv }),
    createAuditWorkflowInstance(db(), input, { env: safeEnv }),
  ]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.equal(first.value.workflowInstanceId, second.value.workflowInstanceId);
  assert.deepEqual([first.replayed, second.replayed].sort(), [false, true]);
  assert.equal(await db().aiWorkflowInstance.count({ where: { creationKey } }), 1);
  assert.equal(await db().auditLog.count({
    where: { entityId: first.value.workflowInstanceId, event: 'ai_workflow_created' },
  }), 1);
});

test('definitionHash alterato viene rifiutato prima di ledger, job e outbox', { skip: !runDbTests }, async () => {
  const created = await createCase();
  const id = created.value.workflowInstanceId;
  const input = await transitionInput(id, 'WF-001', human(runnerId), {
    expectedDefinitionHash: '0'.repeat(64),
  });
  const denied = await applyAuditWorkflowTransition(db(), input, { env: safeEnv });
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.code, 'INVALID_INPUT');
  assert.equal(await db().aiWorkflowTransition.count({ where: { workflowInstanceId: id } }), 0);
  assert.equal(await db().aiWorkflowJob.count({ where: { workflowInstanceId: id } }), 0);
  assert.equal(await db().aiWorkflowJobOutboxEvent.count({ where: { workflowInstanceId: id } }), 0);
});

test('stesso comando/hash è replay; stessa chiave con hash diverso è conflitto senza duplicati', { skip: !runDbTests }, async () => {
  const created = await createCase();
  const input = await transitionInput(created.value.workflowInstanceId, 'WF-001', human(runnerId));
  const first = await applyAuditWorkflowTransition(db(), input, { env: safeEnv });
  const replay = await applyAuditWorkflowTransition(db(), input, { env: safeEnv });
  const conflict = await applyAuditWorkflowTransition(db(), {
    ...input,
    reasonCode: 'DIFFERENT_SYNTHETIC_REASON',
  }, { env: safeEnv });

  assert.equal(first.ok, true);
  assert.equal(replay.ok, true);
  if (first.ok && replay.ok) {
    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.equal(first.value.transitionId, replay.value.transitionId);
  }
  assert.equal(conflict.ok, false);
  if (!conflict.ok) assert.equal(conflict.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(await db().aiWorkflowCommand.count({
    where: { workflowInstanceId: created.value.workflowInstanceId, idempotencyKey: input.idempotencyKey },
  }), 1);
  assert.equal(await db().aiWorkflowTransition.count({
    where: { workflowInstanceId: created.value.workflowInstanceId },
  }), 1);
  assert.equal(await db().auditLog.count({
    where: { entityId: created.value.workflowInstanceId, event: 'ai_workflow_state_changed' },
  }), 1);
});

test('WF-004 pianifica job e outbox atomici; il replay non duplica la coda', { skip: !runDbTests }, async () => {
  const created = await createCase();
  const id = created.value.workflowInstanceId;
  await applyOk(id, 'WF-001', human(runnerId));
  await applyOk(id, 'WF-002', human(runnerId));
  await applyOk(id, 'WF-003', human(runnerId));
  const input = await transitionInput(id, 'WF-004', human(runnerId));
  const aiRunCountBefore = await db().aiRun.count();
  const first = await applyAuditWorkflowTransition(db(), input, { env: safeEnv });
  const replay = await applyAuditWorkflowTransition(db(), input, { env: safeEnv });
  assert.equal(first.ok, true);
  assert.equal(replay.ok, true);
  if (!first.ok || !replay.ok) return;
  assert.equal(first.value.plannedJobCount, 1);
  assert.equal(replay.value.plannedJobCount, 1);
  assert.equal(replay.value.jobPlanHash, first.value.jobPlanHash);
  assert.equal(replay.value.transitionId, first.value.transitionId);

  const jobs = await db().aiWorkflowJob.findMany({ where: { sourceTransitionId: first.value.transitionId } });
  assert.equal(jobs.length, 1);
  const job = jobs[0];
  assert.ok(job);
  assert.equal(job.catalogCode, 'FAI-AUDIT-JOB-CATALOG');
  assert.equal(job.catalogVersion, '1.0');
  assert.equal(job.catalogHash, FAI_AUDIT_JOB_CATALOG_HASH);
  assert.equal(job.jobCode, 'DOCUMENT_INGESTION');
  assert.equal(job.completionTransitionCode, 'WF-005');
  assert.equal(job.status, 'PLANNED');
  assert.equal(job.provider, 'mock');
  assert.equal(job.dataMode, 'synthetic');
  assert.equal(job.automaticDispatchAllowed, false);
  assert.equal(job.workflowDefinitionHash, FAI_AUDIT_WORKFLOW_DEFINITION_HASH);
  assert.equal(job.phaseCode, 'DATA_VALIDATION');
  assert.equal(job.phaseEntrySequence, 4);
  assert.equal(job.sourceState, 'NEEDS_DOCUMENTS');
  assert.equal(job.sourceStateVersion, 4);
  assert.equal(job.correctionCycle, 0);
  assert.equal(job.availableAt.toISOString(), job.plannedAt.toISOString());
  const expectedExecutor = FAI_AUDIT_JOB_EXECUTOR_BINDINGS.find(({ jobCode }) => jobCode === job.jobCode);
  assert.ok(expectedExecutor);
  assert.equal(job.executorAgentCode, expectedExecutor.executorAgentCode);
  assert.equal(job.executorAgentConfigVersion, expectedExecutor.executorAgentConfigVersion);
  assert.equal(job.executorAgentConfigHash, expectedExecutor.executorAgentConfigHash);
  assert.notEqual(job.executorAgentId, runnerId, 'attore umano ed executor sono identità distinte');
  const executorSnapshot = await db().aiAgentConfigVersion.findUniqueOrThrow({
    where: {
      agentId_version: {
        agentId: job.executorAgentId,
        version: job.executorAgentConfigVersion,
      },
    },
  });
  assert.equal(createAiAgentConfigHash(executorSnapshot), job.executorAgentConfigHash);
  assert.match(job.dedupeKey, /^[0-9a-f]{64}$/);
  assert.equal(canonicalSha256(job.payload), job.payloadHash);

  const outbox = await db().aiWorkflowJobOutboxEvent.findMany({ where: { jobId: job.id } });
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0]?.eventType, 'AI_JOB_PLANNED');
  assert.equal(outbox[0]?.deliveryState, 'PENDING');
  assert.equal(canonicalSha256(outbox[0]?.payload), outbox[0]?.payloadHash);
  const outboxPayload = asJsonObject(outbox[0]?.payload, 'outbox.payload');
  const outboxExecutor = asJsonObject(outboxPayload.executor, 'outbox.payload.executor');
  assert.deepEqual(outboxExecutor, {
    agentId: job.executorAgentId,
    agentCode: job.executorAgentCode,
    configVersion: job.executorAgentConfigVersion,
    configHash: job.executorAgentConfigHash,
  });
  const transition = await db().aiWorkflowTransition.findUniqueOrThrow({ where: { id: first.value.transitionId } });
  const planning = asJsonObject(asJsonObject(transition.metadata, 'metadata').jobPlanning, 'jobPlanning');
  assert.equal(planning.catalogKey, FAI_AUDIT_JOB_CATALOG_KEY);
  assert.equal(planning.catalogHash, FAI_AUDIT_JOB_CATALOG_HASH);
  assert.equal(planning.workflowDefinitionHash, FAI_AUDIT_WORKFLOW_DEFINITION_HASH);
  assert.equal(planning.phaseCode, 'DATA_VALIDATION');
  assert.equal(planning.phaseEntrySequence, 4);
  assert.equal(planning.sourceState, 'NEEDS_DOCUMENTS');
  assert.equal(planning.sourceStateVersion, 4);
  assert.equal(planning.correctionCycle, 0);
  assert.equal(planning.planHash, first.value.jobPlanHash);
  assert.equal(planning.plannedJobCount, 1);
  assert.equal(planning.automaticDispatchAllowed, false);
  assert.equal(await db().aiRun.count(), aiRunCountBefore);
});

test('executor assente, inattivo o non mock causa rollback atomico senza reinterpretare config storiche', { skip: !runDbTests }, async () => {
  const canonicalAgent = await db().aiAgent.findUniqueOrThrow({
    where: { code: 'verifica_ai_preliminare_fai' },
  });
  const original = {
    active: canonicalAgent.active,
    provider: canonicalAgent.provider,
    configVersion: canonicalAgent.configVersion,
  };

  for (const unsafe of [
    { configVersion: 999 },
    { active: false },
    { provider: 'openai' },
  ]) {
    const created = await createCase();
    const id = created.value.workflowInstanceId;
    await applyOk(id, 'WF-001', human(runnerId));
    await applyOk(id, 'WF-002', human(runnerId));
    await applyOk(id, 'WF-003', human(runnerId));
    const input = await transitionInput(id, 'WF-004', human(runnerId));
    const before = await db().aiWorkflowInstance.findUniqueOrThrow({ where: { id } });
    await db().aiAgent.update({ where: { id: canonicalAgent.id }, data: unsafe });
    try {
      const denied = await applyAuditWorkflowTransition(db(), input, { env: safeEnv });
      assert.equal(denied.ok, false);
      if (!denied.ok) assert.equal(denied.code, 'LEDGER_INTEGRITY_ERROR');
      assert.deepEqual(
        await db().aiWorkflowInstance.findUniqueOrThrow({
          where: { id },
          select: { currentState: true, stateVersion: true, correctionCycle: true },
        }),
        {
          currentState: before.currentState,
          stateVersion: before.stateVersion,
          correctionCycle: before.correctionCycle,
        },
      );
      assert.equal(await db().aiWorkflowCommand.count({ where: { workflowInstanceId: id } }), 3);
      assert.equal(await db().aiWorkflowTransition.count({ where: { workflowInstanceId: id } }), 3);
      assert.equal(await db().aiWorkflowJob.count({ where: { workflowInstanceId: id } }), 0);
      assert.equal(await db().aiWorkflowJobOutboxEvent.count({ where: { workflowInstanceId: id } }), 0);
    } finally {
      await db().aiAgent.update({ where: { id: canonicalAgent.id }, data: original });
    }
  }

  const plannedCase = await createCase();
  const plannedId = plannedCase.value.workflowInstanceId;
  await applyOk(plannedId, 'WF-001', human(runnerId));
  await applyOk(plannedId, 'WF-002', human(runnerId));
  await applyOk(plannedId, 'WF-003', human(runnerId));
  const planningInput = await transitionInput(plannedId, 'WF-004', human(runnerId));
  const planned = await applyAuditWorkflowTransition(db(), planningInput, { env: safeEnv });
  assert.equal(planned.ok, true);
  if (!planned.ok) return;
  const jobBefore = await db().aiWorkflowJob.findFirstOrThrow({ where: { workflowInstanceId: plannedId } });
  const snapshotV1 = await db().aiAgentConfigVersion.findUniqueOrThrow({
    where: { agentId_version: { agentId: canonicalAgent.id, version: 1 } },
  });
  await assert.rejects(db().aiAgentConfigVersion.update({
    where: { id: snapshotV1.id },
    data: { systemPrompt: `${snapshotV1.systemPrompt} tampered` },
  }));
  const existingV2 = await db().aiAgentConfigVersion.findUnique({
    where: { agentId_version: { agentId: canonicalAgent.id, version: 2 } },
  });
  if (!existingV2) {
    await db().aiAgentConfigVersion.create({
      data: {
        agentId: canonicalAgent.id,
        version: 2,
        code: snapshotV1.code,
        name: snapshotV1.name,
        description: snapshotV1.description,
        operationalScope: snapshotV1.operationalScope,
        systemPrompt: `${snapshotV1.systemPrompt}\nSynthetic v2.`,
        requiredDataChecklist: snapshotV1.requiredDataChecklist as Prisma.InputJsonValue,
        expectedOutput: snapshotV1.expectedOutput,
        toneStyle: snapshotV1.toneStyle,
        active: true,
        provider: 'mock',
        model: null,
        promptVersion: 'v2',
        inputSchema: snapshotV1.inputSchema as Prisma.InputJsonValue,
        outputSchema: snapshotV1.outputSchema as Prisma.InputJsonValue,
        createdById: runnerId,
      },
    });
  }
  await db().aiAgent.update({ where: { id: canonicalAgent.id }, data: { configVersion: 2 } });
  try {
    const replay = await applyAuditWorkflowTransition(db(), planningInput, { env: safeEnv });
    assert.equal(replay.ok, true);
    if (replay.ok) assert.equal(replay.replayed, true);
    const jobAfter = await db().aiWorkflowJob.findUniqueOrThrow({ where: { id: jobBefore.id } });
    assert.equal(jobAfter.executorAgentConfigVersion, 1);
    assert.equal(jobAfter.executorAgentConfigHash, jobBefore.executorAgentConfigHash);
    assert.equal(createAiAgentConfigHash(snapshotV1), jobAfter.executorAgentConfigHash);
  } finally {
    await db().aiAgent.update({ where: { id: canonicalAgent.id }, data: original });
  }
});

test('bundle analysis e review hanno cardinalità canonica e outbox uno-a-uno', { skip: !runDbTests }, async () => {
  const created = await createCase();
  const id = created.value.workflowInstanceId;
  await advanceToDataValidation(id);
  await completeDataValidation(id);
  await applyOk(id, 'WF-011', system());
  await applyOk(id, 'WF-012', agent());
  await applyOk(id, 'WF-013', agent());

  const jobs = await db().aiWorkflowJob.findMany({
    where: { workflowInstanceId: id },
    orderBy: [{ sourceTransitionSequence: 'asc' }, { slotKey: 'asc' }],
  });
  const countFor = (code: string) => jobs.filter(({ sourceTransitionCode }) => sourceTransitionCode === code).length;
  assert.equal(countFor('WF-004'), 1);
  assert.equal(countFor('WF-005'), 1);
  assert.equal(countFor('WF-006'), 1);
  assert.equal(countFor('WF-007'), 0);
  assert.equal(countFor('WF-010'), 3);
  assert.equal(countFor('WF-011'), 1);
  assert.equal(countFor('WF-012'), 1);
  assert.equal(countFor('WF-013'), 4);
  assert.equal(new Set(jobs.filter(({ sourceTransitionCode }) => sourceTransitionCode === 'WF-010')
    .map(({ bundleKey }) => bundleKey)).size, 1);
  assert.equal(new Set(jobs.filter(({ sourceTransitionCode }) => sourceTransitionCode === 'WF-013')
    .map(({ bundleKey }) => bundleKey)).size, 1);
  assert.ok(jobs.every(({ status, provider, dataMode, automaticDispatchAllowed }) => (
    status === 'PLANNED'
    && provider === 'mock'
    && dataMode === 'synthetic'
    && automaticDispatchAllowed === false
  )));
  assert.equal(await db().aiWorkflowJobOutboxEvent.count({ where: { workflowInstanceId: id } }), jobs.length);
});

test('la coda consente soltanto PLANNED→BLOCKED e l’outbox resta append-only', { skip: !runDbTests }, async () => {
  const created = await createCase();
  const id = created.value.workflowInstanceId;
  await advanceToDataValidation(id);
  const job = await db().aiWorkflowJob.findFirstOrThrow({ where: { workflowInstanceId: id } });
  const blockedAt = new Date();
  const blocked = await db().aiWorkflowJob.update({
    where: { id: job.id },
    data: { status: 'BLOCKED', blockedAt, blockedReasonCode: 'FOUNDATION_HOLD' },
  });
  assert.equal(blocked.status, 'BLOCKED');
  await assert.rejects(db().aiWorkflowJob.update({
    where: { id: job.id },
    data: { status: 'PLANNED', blockedAt: null, blockedReasonCode: null },
  }));
  await assert.rejects(db().aiWorkflowJob.update({
    where: { id: job.id },
    data: { status: 'RUNNING' },
  }));
  const event = await db().aiWorkflowJobOutboxEvent.findFirstOrThrow({ where: { jobId: job.id } });
  await assert.rejects(db().aiWorkflowJobOutboxEvent.update({
    where: { id: event.id },
    data: { deliveryState: 'DELIVERED' },
  }));
  await assert.rejects(db().aiWorkflowJobOutboxEvent.delete({ where: { id: event.id } }));
  await assert.rejects(db().aiWorkflowJob.delete({ where: { id: job.id } }));
});

test('PostgreSQL rifiuta alterazioni di definition, fase ed executor rispetto al ledger', { skip: !runDbTests }, async () => {
  const created = await createCase();
  const id = created.value.workflowInstanceId;
  await advanceToDataValidation(id);
  const source = await db().aiWorkflowJob.findFirstOrThrow({
    where: { workflowInstanceId: id, sourceTransitionCode: 'WF-004' },
  });
  const clone = (overrides: Partial<Pick<typeof source,
    | 'workflowDefinitionHash'
    | 'phaseCode'
    | 'phaseEntrySequence'
    | 'executorAgentId'
    | 'executorAgentConfigVersion'
    | 'executorAgentConfigHash'
  >>) => db().aiWorkflowJob.create({
    data: {
      workflowInstanceId: source.workflowInstanceId,
      sourceTransitionId: source.sourceTransitionId,
      sourceTransitionCode: source.sourceTransitionCode,
      sourceTransitionSequence: source.sourceTransitionSequence,
      workflowDefinitionHash: source.workflowDefinitionHash,
      phaseCode: source.phaseCode,
      phaseEntrySequence: source.phaseEntrySequence,
      sourceState: source.sourceState,
      sourceStateVersion: source.sourceStateVersion,
      correctionCycle: source.correctionCycle,
      executorAgentId: source.executorAgentId,
      executorAgentCode: source.executorAgentCode,
      executorAgentConfigVersion: source.executorAgentConfigVersion,
      executorAgentConfigHash: source.executorAgentConfigHash,
      catalogCode: source.catalogCode,
      catalogVersion: source.catalogVersion,
      catalogHash: source.catalogHash,
      jobCode: source.jobCode,
      jobVersion: source.jobVersion,
      jobDefinitionHash: source.jobDefinitionHash,
      completionTransitionCode: source.completionTransitionCode,
      completionMode: source.completionMode,
      slotKey: source.slotKey,
      bundleCode: source.bundleCode,
      bundleKey: source.bundleKey,
      dedupeKey: source.dedupeKey,
      status: source.status,
      provider: source.provider,
      dataMode: source.dataMode,
      automaticDispatchAllowed: source.automaticDispatchAllowed,
      payload: source.payload as Prisma.InputJsonValue,
      payloadHash: source.payloadHash,
      correlationId: source.correlationId,
      plannedAt: source.plannedAt,
      availableAt: source.availableAt,
      blockedAt: source.blockedAt,
      blockedReasonCode: source.blockedReasonCode,
      ...overrides,
    },
  });

  await assert.rejects(clone({ workflowDefinitionHash: '0'.repeat(64) }), /causal phase identity/i);
  await assert.rejects(clone({ phaseCode: 'AI_DRAFT' }), /causal phase identity/i);
  await assert.rejects(clone({ phaseEntrySequence: 3 }), /causal phase identity/i);
  await assert.rejects(clone({ executorAgentId: `missing-${randomUUID()}` }), /executor config/i);
  await assert.rejects(clone({ executorAgentConfigVersion: 2 }), /canonical catalog mapping/i);
  await assert.rejects(clone({ executorAgentConfigHash: '0'.repeat(64) }), /canonical catalog mapping/i);
});

test('una transizione schedulabile senza piano e outbox viene interamente rollbackata', { skip: !runDbTests }, async () => {
  const created = await createCase();
  const id = created.value.workflowInstanceId;
  await applyOk(id, 'WF-001', human(runnerId));
  await applyOk(id, 'WF-002', human(runnerId));
  await applyOk(id, 'WF-003', human(runnerId));
  const before = await db().aiWorkflowInstance.findUniqueOrThrow({ where: { id } });
  const commandCount = await db().aiWorkflowCommand.count({ where: { workflowInstanceId: id } });
  const transitionCount = await db().aiWorkflowTransition.count({ where: { workflowInstanceId: id } });
  await assert.rejects(db().$transaction(async (tx) => {
    await attemptDirectLedgerAppend(
      tx,
      id,
      'WF-004',
      { kind: 'HUMAN', userId: runnerId },
    );
    await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
  }));
  const after = await db().aiWorkflowInstance.findUniqueOrThrow({ where: { id } });
  assert.deepEqual(
    { currentState: after.currentState, stateVersion: after.stateVersion, correctionCycle: after.correctionCycle },
    { currentState: before.currentState, stateVersion: before.stateVersion, correctionCycle: before.correctionCycle },
  );
  assert.equal(await db().aiWorkflowCommand.count({ where: { workflowInstanceId: id } }), commandCount);
  assert.equal(await db().aiWorkflowTransition.count({ where: { workflowInstanceId: id } }), transitionCount);
  assert.equal(await db().aiWorkflowJob.count({ where: { workflowInstanceId: id } }), 0);
  assert.equal(await db().aiWorkflowJobOutboxEvent.count({ where: { workflowInstanceId: id } }), 0);
});

test('diniego RBAC è persistito senza mutare stato o creare una transizione', { skip: !runDbTests }, async () => {
  const created = await createCase();
  const result = await applyCode(created.value.workflowInstanceId, 'WF-001', human(limitedId));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, 'PERMISSION_DENIED');
    assert.ok(result.commandId);
    const command = await db().aiWorkflowCommand.findUniqueOrThrow({ where: { id: result.commandId } });
    assert.equal(command.status, 'REJECTED');
    assert.equal(command.rejectionCode, 'PERMISSION_DENIED');
  }
  const instance = await db().aiWorkflowInstance.findUniqueOrThrow({ where: { id: created.value.workflowInstanceId } });
  assert.equal(instance.currentState, 'CREATED');
  assert.equal(instance.stateVersion, 1);
  assert.equal(await db().aiWorkflowTransition.count({ where: { workflowInstanceId: instance.id } }), 0);
});

test('milestone DATA_VALIDATION: missing, fuori ordine, replay esatto e duplicato con nuova key', { skip: !runDbTests }, async () => {
  const created = await createCase();
  const id = created.value.workflowInstanceId;
  await advanceToDataValidation(id);

  const skipped = await applyCode(id, 'WF-010', human(runnerId));
  assert.equal(skipped.ok, false);
  if (!skipped.ok) assert.equal(skipped.code, 'MILESTONE_NOT_COMPLETED');

  const outOfOrder = await applyCode(id, 'WF-006', agent());
  assert.equal(outOfOrder.ok, false);
  if (!outOfOrder.ok) assert.equal(outOfOrder.code, 'MILESTONE_OUT_OF_ORDER');

  const firstInput = await transitionInput(id, 'WF-005', agent());
  const first = await applyAuditWorkflowTransition(db(), firstInput, { env: safeEnv });
  const exactReplay = await applyAuditWorkflowTransition(db(), firstInput, { env: safeEnv });
  assert.equal(first.ok, true);
  assert.equal(exactReplay.ok, true);
  if (first.ok && exactReplay.ok) {
    assert.equal(first.replayed, false);
    assert.equal(exactReplay.replayed, true);
    assert.equal(exactReplay.value.transitionId, first.value.transitionId);
  }

  const extractBeforeClassification = await applyCode(id, 'WF-007', agent());
  assert.equal(extractBeforeClassification.ok, false);
  if (!extractBeforeClassification.ok) {
    assert.equal(extractBeforeClassification.code, 'MILESTONE_OUT_OF_ORDER');
  }

  const duplicateWithNewKey = await applyCode(id, 'WF-005', agent());
  assert.equal(duplicateWithNewKey.ok, false);
  if (!duplicateWithNewKey.ok) assert.equal(duplicateWithNewKey.code, 'MILESTONE_DUPLICATE');

  await applyOk(id, 'WF-006', agent());
  await applyOk(id, 'WF-007', agent());
  await applyOk(id, 'WF-010', human(runnerId));
  const instance = await db().aiWorkflowInstance.findUniqueOrThrow({ where: { id } });
  assert.equal(instance.currentState, 'READY_FOR_ANALYSIS');
  assert.equal(await db().aiWorkflowTransition.count({ where: { workflowInstanceId: id } }), 8);
});

test('le milestone DATA_VALIDATION della fase precedente non superano WF-008/WF-009', { skip: !runDbTests }, async () => {
  const created = await createCase();
  const id = created.value.workflowInstanceId;
  await advanceToDataValidation(id);
  await applyOk(id, 'WF-005', agent());
  await applyOk(id, 'WF-006', agent());
  await applyOk(id, 'WF-007', agent());
  await applyOk(id, 'WF-008', system());
  await applyOk(id, 'WF-009', human(runnerId));
  const reentryJob = await db().aiWorkflowJob.findFirstOrThrow({
    where: { workflowInstanceId: id, sourceTransitionCode: 'WF-009' },
  });
  assert.equal(reentryJob.phaseCode, 'DATA_VALIDATION');
  assert.equal(reentryJob.phaseEntrySequence, reentryJob.sourceTransitionSequence);

  const staleMilestones = await applyCode(id, 'WF-010', human(runnerId));
  assert.equal(staleMilestones.ok, false);
  if (!staleMilestones.ok) assert.equal(staleMilestones.code, 'MILESTONE_NOT_COMPLETED');

  await completeDataValidation(id);
  const postReentryJobs = await db().aiWorkflowJob.findMany({
    where: { workflowInstanceId: id, sourceTransitionCode: { in: ['WF-005', 'WF-006'] } },
  });
  assert.equal(
    postReentryJobs.filter((job) => job.phaseEntrySequence === reentryJob.phaseEntrySequence).length,
    2,
  );
  assert.equal(
    (await db().aiWorkflowInstance.findUniqueOrThrow({ where: { id } })).currentState,
    'READY_FOR_ANALYSIS',
  );
});

test('milestone AI_DRAFT e review sono uniche e limitate alla fase o al ciclo corrente', { skip: !runDbTests }, async () => {
  const created = await createCase();
  const id = created.value.workflowInstanceId;
  await advanceToDataValidation(id);
  await completeDataValidation(id);
  await applyOk(id, 'WF-011', system());

  const reportWithoutFindings = await applyCode(id, 'WF-013', agent());
  assert.equal(reportWithoutFindings.ok, false);
  if (!reportWithoutFindings.ok) assert.equal(reportWithoutFindings.code, 'MILESTONE_NOT_COMPLETED');

  const findingsInput = await transitionInput(id, 'WF-012', agent());
  const findings = await applyAuditWorkflowTransition(db(), findingsInput, { env: safeEnv });
  const findingsReplay = await applyAuditWorkflowTransition(db(), findingsInput, { env: safeEnv });
  assert.equal(findings.ok, true);
  assert.equal(findingsReplay.ok, true);
  if (findingsReplay.ok) assert.equal(findingsReplay.replayed, true);
  const duplicateFindings = await applyCode(id, 'WF-012', agent());
  assert.equal(duplicateFindings.ok, false);
  if (!duplicateFindings.ok) assert.equal(duplicateFindings.code, 'MILESTONE_DUPLICATE');

  await applyOk(id, 'WF-013', agent());
  const correctionWithoutBundle = await applyCode(id, 'WF-015', system());
  assert.equal(correctionWithoutBundle.ok, false);
  if (!correctionWithoutBundle.ok) assert.equal(correctionWithoutBundle.code, 'MILESTONE_NOT_COMPLETED');
  const reviewWithoutBundle = await applyCode(id, 'WF-017', human(reviewerId));
  assert.equal(reviewWithoutBundle.ok, false);
  if (!reviewWithoutBundle.ok) assert.equal(reviewWithoutBundle.code, 'MILESTONE_NOT_COMPLETED');

  await applyOk(id, 'WF-014', system());
  const duplicateReview = await applyCode(id, 'WF-014', system());
  assert.equal(duplicateReview.ok, false);
  if (!duplicateReview.ok) assert.equal(duplicateReview.code, 'MILESTONE_DUPLICATE');
  await applyOk(id, 'WF-015', system());
  await applyOk(id, 'WF-016', agent());

  const staleReview = await applyCode(id, 'WF-017', human(reviewerId));
  assert.equal(staleReview.ok, false);
  if (!staleReview.ok) assert.equal(staleReview.code, 'MILESTONE_NOT_COMPLETED');
  await applyOk(id, 'WF-014', system());
  await applyOk(id, 'WF-017', human(reviewerId));
  const instance = await db().aiWorkflowInstance.findUniqueOrThrow({ where: { id } });
  assert.equal(instance.currentState, 'HUMAN_APPROVAL');
  assert.equal(instance.correctionCycle, 1);
});

test('vertical slice sintetica termina a HUMAN_APPROVAL e rifiuta WF-018..WF-023', { skip: !runDbTests }, async () => {
  const created = await createCase();
  const id = created.value.workflowInstanceId;
  await advanceToIndependentReview(id);
  await applyOk(id, 'WF-014', system());

  for (let expectedCycle = 1; expectedCycle <= 2; expectedCycle += 1) {
    await applyOk(id, 'WF-015', system());
    let instance = await db().aiWorkflowInstance.findUniqueOrThrow({ where: { id } });
    assert.equal(instance.currentState, 'NEEDS_CORRECTION');
    assert.equal(instance.correctionCycle, expectedCycle);
    await applyOk(id, 'WF-016', agent());
    await applyOk(id, 'WF-014', system());
    instance = await db().aiWorkflowInstance.findUniqueOrThrow({ where: { id } });
    assert.equal(instance.currentState, 'INDEPENDENT_REVIEW');
  }

  const reviewJobs = await db().aiWorkflowJob.findMany({
    where: {
      workflowInstanceId: id,
      sourceTransitionCode: { in: ['WF-013', 'WF-016'] },
    },
  });
  for (const correctionCycle of [0, 1, 2]) {
    const cycleJobs = reviewJobs.filter((job) => job.correctionCycle === correctionCycle);
    assert.equal(cycleJobs.length, 4);
    assert.equal(new Set(cycleJobs.map(({ dedupeKey }) => dedupeKey)).size, 4);
    assert.ok(cycleJobs.every(({ phaseCode }) => phaseCode === 'INDEPENDENT_REVIEW'));
  }
  assert.equal(new Set(reviewJobs.map(({ dedupeKey }) => dedupeKey)).size, 12);
  assert.equal(new Set(reviewJobs.map(({ phaseEntrySequence }) => phaseEntrySequence)).size, 3);

  const thirdCorrection = await applyCode(id, 'WF-015', system());
  assert.equal(thirdCorrection.ok, false);
  if (!thirdCorrection.ok) assert.equal(thirdCorrection.code, 'CORRECTION_LIMIT_REACHED');
  await applyOk(id, 'WF-017', human(reviewerId));

  const beforeScopeDenials = await db().aiWorkflowInstance.findUniqueOrThrow({ where: { id } });
  assert.equal(beforeScopeDenials.currentState, 'HUMAN_APPROVAL');
  const ledgerCountAtBoundary = await db().aiWorkflowTransition.count({ where: { workflowInstanceId: id } });
  for (const transitionCode of ['WF-018', 'WF-019', 'WF-020', 'WF-021', 'WF-022', 'WF-023']) {
    const input = await canonicalTransitionInput(id, transitionCode, human(reviewerId));
    const denied = await applyAuditWorkflowTransition(db(), input, { env: safeEnv });
    assert.equal(denied.ok, false, transitionCode);
    if (!denied.ok) assert.equal(denied.code, 'FOUNDATION_SCOPE_LIMIT', transitionCode);
  }
  const malformedOutOfScope = await canonicalTransitionInput(id, 'WF-018', human(reviewerId), {
    gateResults: { UNEXPECTED_GATE: 'PASS' },
    preconditions: { UNEXPECTED_PRECONDITION: true },
  });
  const malformedOutOfScopeDenied = await applyAuditWorkflowTransition(
    db(),
    malformedOutOfScope,
    { env: safeEnv },
  );
  assert.equal(malformedOutOfScopeDenied.ok, false);
  if (!malformedOutOfScopeDenied.ok) {
    assert.equal(malformedOutOfScopeDenied.code, 'FOUNDATION_SCOPE_LIMIT');
  }

  const instance = await db().aiWorkflowInstance.findUniqueOrThrow({ where: { id } });
  assert.equal(instance.currentState, 'HUMAN_APPROVAL');
  assert.equal(instance.correctionCycle, 2);
  assert.equal(instance.stateVersion, beforeScopeDenials.stateVersion);
  assert.equal(await db().aiWorkflowTransition.count({ where: { workflowInstanceId: id } }), ledgerCountAtBoundary);
  const ledger = await db().aiWorkflowTransition.findMany({
    where: { workflowInstanceId: id },
    orderBy: { sequence: 'asc' },
  });
  assert.equal(ledger.length, 19);
  for (const [index, row] of ledger.entries()) {
    assert.equal(row.sequence, index + 1);
    assert.equal(row.fromVersion, index + 1);
    assert.equal(row.toVersion, index + 2);
    assert.equal(row.previousTransitionHash, index === 0 ? null : ledger[index - 1]?.transitionHash);
    assert.equal(row.definitionHash, FAI_AUDIT_WORKFLOW_DEFINITION_HASH);
    assert.equal(canonicalSha256(row.guardSnapshot), row.guardSnapshotHash);
    assert.equal(asJsonObject(row.metadata, `${row.transitionCode}.metadata`).automaticDispatchAllowed, false);
  }
  assert.equal(await db().auditLog.count({ where: { entityId: id, event: 'ai_workflow_step_completed' } }), 7);
  assert.equal(await db().auditLog.count({ where: { entityId: id, event: 'ai_workflow_state_changed' } }), 12);

  const immutable = ledger[0];
  assert.ok(immutable);
  await assert.rejects(db().aiWorkflowTransition.update({
    where: { id: immutable.id },
    data: { reasonCode: 'TAMPER_ATTEMPT' },
  }));
  await assert.rejects(db().aiWorkflowTransition.delete({ where: { id: immutable.id } }));
});

test('guard snapshot persistito è minimo, ricostruibile, hashato esattamente e immutabile', { skip: !runDbTests }, async () => {
  const created = await createCase();
  const applied = await applyOk(created.value.workflowInstanceId, 'WF-001', human(runnerId));
  const row = await db().aiWorkflowTransition.findUniqueOrThrow({
    where: { id: applied.value.transitionId },
  });
  assert.equal(canonicalSha256(row.guardSnapshot), row.guardSnapshotHash);

  const snapshot = asJsonObject(row.guardSnapshot, 'guardSnapshot');
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.correctionCycle, 0);

  const actorSnapshot = asJsonObject(snapshot.actor, 'guardSnapshot.actor');
  assert.deepEqual(actorSnapshot, { kind: 'HUMAN', humanRole: 'admin' });
  const permission = asJsonObject(snapshot.permission, 'guardSnapshot.permission');
  assert.deepEqual(permission, { required: 'ai.run', granted: true, source: 'ADMIN' });

  const setting = asJsonObject(snapshot.orchestratorSetting, 'guardSnapshot.orchestratorSetting');
  assert.equal(setting.id, 'global');
  assert.equal(setting.stateMachineEnabled, true);
  assert.equal(setting.dispatchEnabled, false);
  assert.equal(setting.syntheticDataOnly, true);
  assert.equal(setting.provider, 'mock');
  assert.equal(typeof setting.version, 'number');
  assert.equal(typeof setting.updatedAt, 'string');

  const gate = asJsonObject(snapshot.gate, 'guardSnapshot.gate');
  assert.deepEqual(gate, { code: 'G0_ORDER', result: 'PASS', passed: true });
  const preconditions = asJsonArray(snapshot.preconditions, 'guardSnapshot.preconditions')
    .map((item, index) => asJsonObject(item, `guardSnapshot.preconditions[${index}]`));
  assert.deepEqual(preconditions, [
    { code: 'ORDER_ACTIVE', result: true, passed: true },
    { code: 'CONTRACT_COHERENT', result: true, passed: true },
  ]);

  const milestone = asJsonObject(snapshot.milestone, 'guardSnapshot.milestone');
  assert.equal(milestone.decision, 'NOT_REQUIRED');
  assert.deepEqual(milestone.completedTransitionCodes, []);
  const separationChecks = asJsonArray(snapshot.separationChecks, 'guardSnapshot.separationChecks')
    .map((item, index) => asJsonObject(item, `guardSnapshot.separationChecks[${index}]`));
  assert.deepEqual(separationChecks, [
    { code: 'HUMAN_REVIEW_BOUNDARY', applied: false, result: 'NOT_APPLICABLE' },
    {
      code: 'REVIEWER_APPROVER_SEPARATION',
      applied: false,
      result: 'NOT_APPLICABLE_FOUNDATION_SCOPE',
    },
    {
      code: 'APPROVER_RELEASE_SEPARATION',
      applied: false,
      result: 'NOT_APPLICABLE_FOUNDATION_SCOPE',
    },
  ]);
  const foundationPolicy = asJsonObject(snapshot.foundationPolicy, 'guardSnapshot.foundationPolicy');
  assert.deepEqual(foundationPolicy, { transitionInScope: true, automaticDispatchAllowed: false });

  const providerPolicy = asJsonObject(snapshot.providerPolicy, 'guardSnapshot.providerPolicy');
  assert.deepEqual(providerPolicy, {
    databaseExternalProvidersEnabled: false,
    environmentExternalProvidersEnabled: false,
    effectiveExternalProvidersEnabled: false,
  });
  const metadata = asJsonObject(row.metadata, 'transition.metadata');
  assert.equal(metadata.automaticDispatchAllowed, false);

  const forbiddenKey = /^(?:clientId|companyId|projectId|clientServiceId|document|documents|prompt|output|cookie|password|token|apiKey|credentials?|secrets?)$/i;
  for (const key of collectJsonKeys(snapshot)) assert.doesNotMatch(key, forbiddenKey);
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes(runnerId), false);
  assert.equal(serialized.includes(runId), false);
  assert.equal(serialized.includes(passwordHash), false);

  await assert.rejects(db().aiWorkflowTransition.update({
    where: { id: row.id },
    data: { guardSnapshot: { tampered: true } },
  }));
});

test('guard snapshot distingue la fonte effettiva ROLE e OVERRIDE', { skip: !runDbTests }, async () => {
  const fixtures = [
    { userId: roleRunnerId, expectedRole: 'consulente', expectedSource: 'ROLE' },
    { userId: overrideRunnerId, expectedRole: 'collaboratore_limitato', expectedSource: 'OVERRIDE' },
  ] as const;

  for (const fixture of fixtures) {
    const created = await createCase(fixture.userId);
    const applied = await applyOk(created.value.workflowInstanceId, 'WF-001', human(fixture.userId));
    const row = await db().aiWorkflowTransition.findUniqueOrThrow({ where: { id: applied.value.transitionId } });
    assert.equal(canonicalSha256(row.guardSnapshot), row.guardSnapshotHash);
    const snapshot = asJsonObject(row.guardSnapshot, `${fixture.expectedSource}.guardSnapshot`);
    const actorSnapshot = asJsonObject(snapshot.actor, `${fixture.expectedSource}.actor`);
    const permissionSnapshot = asJsonObject(snapshot.permission, `${fixture.expectedSource}.permission`);
    assert.equal(actorSnapshot.humanRole, fixture.expectedRole);
    assert.deepEqual(permissionSnapshot, {
      required: 'ai.run',
      granted: true,
      source: fixture.expectedSource,
    });
  }
});

test('due comandi concorrenti sulla stessa stateVersion producono un solo vincitore', { skip: !runDbTests }, async () => {
  const created = await createCase();
  const id = created.value.workflowInstanceId;
  await advanceToDataValidation(id);
  const [firstInput, secondInput] = await Promise.all([
    transitionInput(id, 'WF-005', agent()),
    transitionInput(id, 'WF-005', agent()),
  ]);
  const settled = await Promise.allSettled([
    applyAuditWorkflowTransition(db(), firstInput, { env: safeEnv }),
    applyAuditWorkflowTransition(db(), secondInput, { env: safeEnv }),
  ]);
  assert.equal(settled.every((item) => item.status === 'fulfilled'), true);
  const results = settled.flatMap((item) => item.status === 'fulfilled' ? [item.value] : []);
  assert.equal(results.filter((item) => item.ok).length, 1);
  assert.equal(results.filter((item) => !item.ok && item.code === 'STATE_VERSION_MISMATCH').length, 1);
  const instance = await db().aiWorkflowInstance.findUniqueOrThrow({ where: { id } });
  assert.equal(instance.currentState, 'DATA_VALIDATION');
  assert.equal(instance.stateVersion, 6);
  assert.equal(await db().aiWorkflowTransition.count({ where: { workflowInstanceId: id } }), 5);
  const concurrentJobs = await db().aiWorkflowJob.findMany({
    where: { workflowInstanceId: id, sourceTransitionCode: 'WF-005' },
  });
  assert.equal(concurrentJobs.length, 1);
  assert.equal(await db().aiWorkflowJobOutboxEvent.count({
    where: { sourceTransitionId: concurrentJobs[0]?.sourceTransitionId },
  }), 1);
});

test('vincoli e trigger DB chiudono NULL bypass, stato diretto e riscrittura idempotenza', { skip: !runDbTests }, async () => {
  const created = await createCase();
  const id = created.value.workflowInstanceId;
  const now = new Date();
  const baseCommand = {
    workflowInstanceId: id,
    transitionCode: 'WF-001',
    eventType: 'CASE_STARTED',
    requestHash: 'a'.repeat(64),
    definitionHash: FAI_AUDIT_WORKFLOW_DEFINITION_HASH,
    expectedState: 'CREATED',
    expectedStateVersion: 1,
    correlationId: randomUUID(),
    createdAt: now,
  };

  await assert.rejects(db().aiWorkflowInstance.create({
    data: {
      creationKey: randomUUID(),
      creationRequestHash: '1'.repeat(64),
      workflowCode: 'FAI-AUDIT-WORKFLOW',
      workflowVersion: '1.1',
      definitionHash: FAI_AUDIT_WORKFLOW_DEFINITION_HASH,
      dataMode: 'synthetic',
      currentState: 'APPROVED',
      stateVersion: 2,
      correctionCycle: 0,
      lastTransitionAt: now,
      createdById: runnerId,
    },
  }));
  await assert.rejects(db().aiWorkflowInstance.create({
    data: {
      creationKey: randomUUID(),
      creationRequestHash: '2'.repeat(64),
      workflowCode: 'FAI-AUDIT-WORKFLOW',
      workflowVersion: '1.1',
      definitionHash: '0'.repeat(64),
      dataMode: 'synthetic',
      currentState: 'CREATED',
      stateVersion: 1,
      correctionCycle: 0,
      createdById: runnerId,
    },
  }));
  const linkedClient = await db().client.create({
    data: { type: 'societa', displayName: `synthetic-link-rejected-${runId}` },
  });
  await assert.rejects(db().aiWorkflowInstance.create({
    data: {
      creationKey: randomUUID(),
      creationRequestHash: '3'.repeat(64),
      workflowCode: 'FAI-AUDIT-WORKFLOW',
      workflowVersion: '1.1',
      definitionHash: FAI_AUDIT_WORKFLOW_DEFINITION_HASH,
      dataMode: 'synthetic',
      clientId: linkedClient.id,
      currentState: 'CREATED',
      stateVersion: 1,
      correctionCycle: 0,
      createdById: runnerId,
    },
  }));
  await db().client.delete({ where: { id: linkedClient.id } });

  await assert.rejects(db().aiWorkflowCommand.create({
    data: {
      ...baseCommand,
      transitionCode: 'WF-005',
      eventType: 'DOCUMENT_INGESTED',
      expectedState: 'DATA_VALIDATION',
      idempotencyKey: randomUUID(),
      actorKind: 'AGENT',
      requestedByAgentId: agentId,
      requestedByAgentConfigVersion: null,
      status: 'PENDING',
    },
  }));
  await assert.rejects(db().aiWorkflowCommand.create({
    data: {
      ...baseCommand,
      idempotencyKey: randomUUID(),
      actorKind: 'HUMAN',
      requestedByUserId: runnerId,
      status: 'APPLIED',
      resultState: 'WAITING_FOR_PAYMENT',
      resultStateVersion: null,
      resolvedAt: now,
    },
  }));
  await assert.rejects(db().aiWorkflowCommand.create({
    data: {
      ...baseCommand,
      idempotencyKey: randomUUID(),
      actorKind: 'SYSTEM',
      requestedBySystemCode: 'AI_ORCHESTRATOR',
      status: 'PENDING',
    },
  }), /actor/i);

  await assert.rejects(db().aiWorkflowInstance.update({
    where: { id },
    data: {
      currentState: 'WAITING_FOR_PAYMENT',
      stateVersion: 2,
      lastTransitionAt: now,
    },
  }));
  await assert.rejects(db().aiWorkflowInstance.update({
    where: { id },
    data: { creationKey: randomUUID() },
  }));

  const pending = await db().aiWorkflowCommand.create({
    data: {
      ...baseCommand,
      idempotencyKey: randomUUID(),
      actorKind: 'HUMAN',
      requestedByUserId: runnerId,
      status: 'PENDING',
    },
  });
  await assert.rejects(db().aiWorkflowCommand.update({
    where: { id: pending.id },
    data: {
      status: 'APPLIED',
      resultState: 'WAITING_FOR_PAYMENT',
      resultStateVersion: 2,
      resolvedAt: now,
    },
  }));
  await assert.rejects(db().aiWorkflowCommand.update({
    where: { id: pending.id },
    data: { requestHash: 'b'.repeat(64) },
  }));
  await assert.rejects(db().aiWorkflowCommand.delete({ where: { id: pending.id } }));
  await assert.rejects(db().aiWorkflowInstance.delete({ where: { id } }));
});

test('i vincoli DB impediscono il bypass diretto delle milestone e del limite Foundation', { skip: !runDbTests }, async () => {
  const milestoneCase = await createCase();
  const milestoneId = milestoneCase.value.workflowInstanceId;
  await advanceToDataValidation(milestoneId);
  await assert.rejects(
    db().$transaction((tx) => attemptDirectLedgerAppend(
      tx,
      milestoneId,
      'WF-006',
      { kind: 'AGENT', agentId, version: 1 },
    )),
    /MILESTONE_OUT_OF_ORDER/i,
  );
  assert.deepEqual(
    await db().aiWorkflowInstance.findUniqueOrThrow({
      where: { id: milestoneId },
      select: { currentState: true, stateVersion: true, correctionCycle: true },
    }),
    { currentState: 'DATA_VALIDATION', stateVersion: 5, correctionCycle: 0 },
  );
  assert.equal(await db().aiWorkflowTransition.count({ where: { workflowInstanceId: milestoneId } }), 4);

  const scopeCase = await createCase();
  const scopeId = scopeCase.value.workflowInstanceId;
  await advanceToIndependentReview(scopeId);
  await applyOk(scopeId, 'WF-014', system());
  await applyOk(scopeId, 'WF-017', human(reviewerId));
  const boundary = await db().aiWorkflowInstance.findUniqueOrThrow({ where: { id: scopeId } });
  assert.equal(boundary.currentState, 'HUMAN_APPROVAL');
  const boundaryLedgerCount = await db().aiWorkflowTransition.count({ where: { workflowInstanceId: scopeId } });
  await assert.rejects(
    db().$transaction((tx) => attemptDirectLedgerAppend(
      tx,
      scopeId,
      'WF-018',
      { kind: 'HUMAN', userId: runnerId },
    )),
    /foundation|scope|constraint/i,
  );
  assert.deepEqual(
    await db().aiWorkflowInstance.findUniqueOrThrow({
      where: { id: scopeId },
      select: { currentState: true, stateVersion: true, correctionCycle: true },
    }),
    {
      currentState: 'HUMAN_APPROVAL',
      stateVersion: boundary.stateVersion,
      correctionCycle: boundary.correctionCycle,
    },
  );
  assert.equal(
    await db().aiWorkflowTransition.count({ where: { workflowInstanceId: scopeId } }),
    boundaryLedgerCount,
  );
});

test('il DB rifiuta snapshot guard incompleti e hash non calcolati sul JSON persistito', { skip: !runDbTests }, async () => {
  const created = await createCase();
  const id = created.value.workflowInstanceId;
  const actor: DirectActor = { kind: 'HUMAN', userId: runnerId };

  const malformedSnapshot: Prisma.InputJsonObject = {
    schemaVersion: 1,
    fixture: 'synthetic-malformed-guard',
  };
  await assert.rejects(
    db().$transaction((tx) => attemptDirectLedgerAppend(tx, id, 'WF-001', actor, {
      guardSnapshot: malformedSnapshot,
      guardSnapshotHash: canonicalSha256(malformedSnapshot),
    })),
    /guard|snapshot|constraint/i,
  );

  const validSnapshot = directGuardSnapshot('WF-001', 'HUMAN');
  const numericAlias = await db().$queryRaw<Array<{ valid: boolean }>>(Prisma.sql`
    SELECT "validate_ai_workflow_guard_snapshot"(
      JSONB_SET(
        CAST(${JSON.stringify(validSnapshot)} AS JSONB),
        '{schemaVersion}',
        '1.0'::JSONB
      ),
      'WF-001',
      'HUMAN'
    ) AS "valid"
  `);
  assert.equal(numericAlias[0]?.valid, false, 'schemaVersion 1.0 non deve aliasare la versione intera 1');
  const unsafeInteger = await db().$queryRaw<Array<{ valid: boolean }>>(Prisma.sql`
    SELECT "validate_ai_workflow_guard_snapshot"(
      JSONB_SET(
        CAST(${JSON.stringify(validSnapshot)} AS JSONB),
        '{orchestratorSetting,version}',
        '9007199254740993'::JSONB
      ),
      'WF-001',
      'HUMAN'
    ) AS "valid"
  `);
  assert.equal(unsafeInteger[0]?.valid, false, 'interi oltre il range PostgreSQL non devono essere accettati');

  await assert.rejects(
    db().$transaction((tx) => attemptDirectLedgerAppend(tx, id, 'WF-001', actor, {
      guardSnapshot: validSnapshot,
      guardSnapshotHash: 'f'.repeat(64),
    })),
    /guard|snapshot|constraint/i,
  );

  assert.deepEqual(
    await db().aiWorkflowInstance.findUniqueOrThrow({
      where: { id },
      select: { currentState: true, stateVersion: true, correctionCycle: true },
    }),
    { currentState: 'CREATED', stateVersion: 1, correctionCycle: 0 },
  );
  assert.equal(await db().aiWorkflowTransition.count({ where: { workflowInstanceId: id } }), 0);
});

test('trigger ledger rifiuta command cross-workflow e predecessore non immediato', { skip: !runDbTests }, async () => {
  const firstCase = await createCase();
  const secondCase = await createCase();
  const firstId = firstCase.value.workflowInstanceId;
  const secondId = secondCase.value.workflowInstanceId;
  const crossNow = new Date();
  await assert.rejects(db().$transaction(async (tx) => {
    const guardSnapshot = directGuardSnapshot('WF-001', 'HUMAN');
    const command = await tx.aiWorkflowCommand.create({
      data: {
        workflowInstanceId: firstId,
        transitionCode: 'WF-001',
        eventType: 'CASE_STARTED',
        idempotencyKey: randomUUID(),
        requestHash: '4'.repeat(64),
        definitionHash: FAI_AUDIT_WORKFLOW_DEFINITION_HASH,
        expectedState: 'CREATED',
        expectedStateVersion: 1,
        actorKind: 'HUMAN',
        requestedByUserId: runnerId,
        correlationId: randomUUID(),
        status: 'PENDING',
        createdAt: crossNow,
      },
    });
    await tx.aiWorkflowInstance.update({
      where: { id: secondId },
      data: { currentState: 'WAITING_FOR_PAYMENT', stateVersion: 2, lastTransitionAt: crossNow },
    });
    await tx.aiWorkflowTransition.create({
      data: {
        workflowInstanceId: secondId,
        commandId: command.id,
        transitionCode: 'WF-001',
        eventType: 'CASE_STARTED',
        sequence: 1,
        fromState: 'CREATED',
        toState: 'WAITING_FOR_PAYMENT',
        fromVersion: 1,
        toVersion: 2,
        definitionHash: FAI_AUDIT_WORKFLOW_DEFINITION_HASH,
        guardSnapshot,
        guardSnapshotHash: canonicalSha256(guardSnapshot),
        previousTransitionHash: null,
        transitionHash: '6'.repeat(64),
        actorKind: 'HUMAN',
        actorUserId: runnerId,
        correlationId: command.correlationId,
        metadata: { automaticDispatchAllowed: false, fixture: 'synthetic-db-negative-test' },
        createdAt: crossNow,
      },
    });
  }));
  assert.deepEqual(
    await db().aiWorkflowInstance.findUniqueOrThrow({
      where: { id: secondId },
      select: { currentState: true, stateVersion: true },
    }),
    { currentState: 'CREATED', stateVersion: 1 },
  );

  await applyOk(firstId, 'WF-001', human(runnerId));
  await applyOk(firstId, 'WF-002', human(runnerId));
  const chain = await db().aiWorkflowTransition.findMany({
    where: { workflowInstanceId: firstId },
    orderBy: { sequence: 'asc' },
  });
  assert.equal(chain.length, 2);
  const gapNow = new Date();
  await assert.rejects(db().$transaction(async (tx) => {
    const guardSnapshot = directGuardSnapshot('WF-003', 'HUMAN');
    const command = await tx.aiWorkflowCommand.create({
      data: {
        workflowInstanceId: firstId,
        transitionCode: 'WF-003',
        eventType: 'AUTHORITY_VERIFIED',
        idempotencyKey: randomUUID(),
        requestHash: '7'.repeat(64),
        definitionHash: FAI_AUDIT_WORKFLOW_DEFINITION_HASH,
        expectedState: 'WAITING_FOR_AUTHORITY',
        expectedStateVersion: 3,
        actorKind: 'HUMAN',
        requestedByUserId: runnerId,
        correlationId: randomUUID(),
        status: 'PENDING',
        createdAt: gapNow,
      },
    });
    await tx.aiWorkflowInstance.update({
      where: { id: firstId },
      data: { currentState: 'NEEDS_DOCUMENTS', stateVersion: 4, lastTransitionAt: gapNow },
    });
    await tx.aiWorkflowTransition.create({
      data: {
        workflowInstanceId: firstId,
        commandId: command.id,
        transitionCode: 'WF-003',
        eventType: 'AUTHORITY_VERIFIED',
        sequence: 3,
        fromState: 'WAITING_FOR_AUTHORITY',
        toState: 'NEEDS_DOCUMENTS',
        fromVersion: 3,
        toVersion: 4,
        definitionHash: FAI_AUDIT_WORKFLOW_DEFINITION_HASH,
        guardSnapshot,
        guardSnapshotHash: canonicalSha256(guardSnapshot),
        previousTransitionHash: chain[0]?.transitionHash ?? null,
        transitionHash: '9'.repeat(64),
        actorKind: 'HUMAN',
        actorUserId: runnerId,
        correlationId: command.correlationId,
        metadata: { automaticDispatchAllowed: false, fixture: 'synthetic-db-negative-test' },
        createdAt: gapNow,
      },
    });
  }));
  assert.deepEqual(
    await db().aiWorkflowInstance.findUniqueOrThrow({
      where: { id: firstId },
      select: { currentState: true, stateVersion: true },
    }),
    { currentState: 'WAITING_FOR_AUTHORITY', stateVersion: 3 },
  );
});

test('upgrade reale PR74→PR75→PR76→PR77→PR79 preserva replay legacy, barriera dispatch e bootstrap fail-closed', { skip: !runDbTests }, async () => {
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl);
  const schemaName = `orchestrator_upgrade_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  assert.match(schemaName, /^[a-z0-9_]+$/);
  await db().$executeRawUnsafe(`CREATE SCHEMA "${schemaName}"`);

  const upgradeUrl = new URL(databaseUrl);
  upgradeUrl.searchParams.set('schema', schemaName);
  const tempRoot = mkdtempSync(join(tmpdir(), 'crm-orchestrator-upgrade-test-'));
  const tempPrisma = join(tempRoot, 'prisma');
  const tempMigrations = join(tempPrisma, 'migrations');
  mkdirSync(tempMigrations, { recursive: true });
  cpSync(resolve(process.cwd(), 'prisma/schema.prisma'), join(tempPrisma, 'schema.prisma'));

  const migrationRoot = resolve(process.cwd(), 'prisma/migrations');
  const pr74Migration = '20260717120000_ai_orchestrator_state_machine_foundation';
  const pr75Migration = '20260717180000_ai_orchestrator_persistent_job_queue_foundation';
  const workerRuntimeMigration = '20260718220000_ai_orchestrator_worker_runtime_foundation';
  const resultArtifactMigration = '20260719120000_ai_orchestrator_result_artifact_contract_foundation_v1';
  // PR78 is TypeScript-only and deliberately has no database migration.
  const adminControlPlaneMigration = '20260720170000_ai_orchestrator_admin_control_plane_foundation_v1';
  for (const migrationName of readdirSync(migrationRoot).sort()) {
    if (/^\d/.test(migrationName) && migrationName <= pr74Migration) {
      cpSync(join(migrationRoot, migrationName), join(tempMigrations, migrationName), { recursive: true });
    }
  }
  const deploy = () => execFileSync(
    resolve(process.cwd(), 'node_modules/.bin/prisma'),
    ['migrate', 'deploy', '--schema', join(tempPrisma, 'schema.prisma')],
    {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: upgradeUrl.toString() },
      stdio: 'pipe',
    },
  );
  deploy();

  const upgradePrisma = new PrismaClient({
    datasources: { db: { url: upgradeUrl.toString() } },
  });
  try {
    const legacyUser = await upgradePrisma.user.create({
      data: {
        email: `legacy-upgrade-${runId}@example.test`,
        name: 'Legacy upgrade synthetic admin',
        passwordHash,
        role: 'admin',
        active: true,
      },
    });
    await upgradePrisma.aiOrchestratorSetting.update({
      where: { id: 'global' },
      data: {
        stateMachineEnabled: true,
        dispatchEnabled: false,
        syntheticDataOnly: true,
        provider: 'mock',
      },
    });
    await upgradePrisma.aiControlSetting.upsert({
      where: { id: 'global' },
      create: { id: 'global', externalProvidersEnabled: false, maxExternalRunsPerUserPerHour: 10 },
      update: { externalProvidersEnabled: false },
    });
    const created = await createAuditWorkflowInstance(upgradePrisma, {
      creationKey: randomUUID(),
      expectedDefinitionHash: FAI_AUDIT_WORKFLOW_DEFINITION_HASH,
      actor: { kind: 'HUMAN', userId: legacyUser.id },
    }, { env: safeEnv });
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const legacyInput: ApplyAuditWorkflowTransitionInput = {
      workflowInstanceId: created.value.workflowInstanceId,
      transitionCode: 'WF-001',
      idempotencyKey: randomUUID(),
      correlationId: randomUUID(),
      expectedDefinitionHash: FAI_AUDIT_WORKFLOW_DEFINITION_HASH,
      expectedState: 'CREATED',
      expectedStateVersion: 1,
      actor: { kind: 'HUMAN', userId: legacyUser.id },
      gateResults: { G0_ORDER: 'PASS' },
      preconditions: { ORDER_ACTIVE: true, CONTRACT_COHERENT: true },
    };
    const setting = await upgradePrisma.aiOrchestratorSetting.findUniqueOrThrow({ where: { id: 'global' } });
    const guardSnapshot: Prisma.InputJsonObject = {
      schemaVersion: 1,
      actor: { kind: 'HUMAN', humanRole: 'admin' },
      permission: { required: 'ai.run', granted: true, source: 'ADMIN' },
      correctionCycle: 0,
      orchestratorSetting: {
        id: 'global',
        stateMachineEnabled: true,
        dispatchEnabled: false,
        provider: 'mock',
        syntheticDataOnly: true,
        version: setting.version,
        updatedAt: setting.updatedAt.toISOString(),
      },
      providerPolicy: {
        databaseExternalProvidersEnabled: false,
        environmentExternalProvidersEnabled: false,
        effectiveExternalProvidersEnabled: false,
      },
      foundationPolicy: { transitionInScope: true, automaticDispatchAllowed: false },
      gate: { code: 'G0_ORDER', result: 'PASS', passed: true },
      preconditions: [
        { code: 'ORDER_ACTIVE', result: true, passed: true },
        { code: 'CONTRACT_COHERENT', result: true, passed: true },
      ],
      milestone: {
        phase: null,
        phaseEntrySequence: null,
        canonicalTransitionCodes: [],
        requiredTransitionCodes: [],
        completedTransitionCodes: [],
        decision: 'NOT_REQUIRED',
      },
      separationChecks: [
        { code: 'HUMAN_REVIEW_BOUNDARY', applied: false, result: 'NOT_APPLICABLE' },
        { code: 'REVIEWER_APPROVER_SEPARATION', applied: false, result: 'NOT_APPLICABLE_FOUNDATION_SCOPE' },
        { code: 'APPROVER_RELEASE_SEPARATION', applied: false, result: 'NOT_APPLICABLE_FOUNDATION_SCOPE' },
      ],
    };
    const legacyMetadata: Prisma.InputJsonObject = {
      automaticDispatchAllowed: false,
      effect: 'STATE_CHANGED',
      stateChanged: true,
    };
    const transitionId = randomUUID();
    const transitionHash = canonicalSha256({ fixture: 'pr74-legacy-upgrade', transitionId });
    const createdAt = new Date();
    const requestHash = createAuditWorkflowCommandRequestHash(legacyInput);
    await upgradePrisma.$transaction(async (tx) => {
      const command = await tx.aiWorkflowCommand.create({
        data: {
          workflowInstanceId: legacyInput.workflowInstanceId,
          transitionCode: 'WF-001',
          eventType: 'CASE_STARTED',
          idempotencyKey: legacyInput.idempotencyKey,
          requestHash,
          definitionHash: FAI_AUDIT_WORKFLOW_DEFINITION_HASH,
          expectedState: 'CREATED',
          expectedStateVersion: 1,
          actorKind: 'HUMAN',
          requestedByUserId: legacyUser.id,
          correlationId: legacyInput.correlationId,
          status: 'PENDING',
          createdAt,
        },
      });
      await tx.aiWorkflowInstance.update({
        where: { id: legacyInput.workflowInstanceId },
        data: { currentState: 'WAITING_FOR_PAYMENT', stateVersion: 2, lastTransitionAt: createdAt },
      });
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "AiWorkflowTransition" (
          "id", "workflowInstanceId", "commandId", "transitionCode", "eventType",
          "sequence", "fromState", "toState", "fromVersion", "toVersion", "definitionHash",
          "guardSnapshot", "guardSnapshotHash", "previousTransitionHash", "transitionHash",
          "actorKind", "actorUserId", "actorAgentId", "actorAgentConfigVersion", "actorSystemCode",
          "reasonCode", "correlationId", "metadata", "createdAt"
        ) VALUES (
          ${transitionId}, ${legacyInput.workflowInstanceId}, ${command.id}, 'WF-001', 'CASE_STARTED',
          1, 'CREATED', 'WAITING_FOR_PAYMENT', 1, 2, ${FAI_AUDIT_WORKFLOW_DEFINITION_HASH},
          ${JSON.stringify(guardSnapshot)}::JSONB, ${canonicalSha256(guardSnapshot)}, NULL, ${transitionHash},
          'HUMAN', ${legacyUser.id}, NULL, NULL, NULL,
          NULL, ${legacyInput.correlationId}, ${JSON.stringify(legacyMetadata)}::JSONB, ${createdAt}
        )
      `);
      await tx.aiWorkflowCommand.update({
        where: { id: command.id },
        data: {
          status: 'APPLIED',
          resultState: 'WAITING_FOR_PAYMENT',
          resultStateVersion: 2,
          resolvedAt: createdAt,
        },
      });
    });

    cpSync(join(migrationRoot, pr75Migration), join(tempMigrations, pr75Migration), { recursive: true });
    deploy();

    const beforeReplay = await upgradePrisma.aiWorkflowTransition.findUniqueOrThrow({ where: { id: transitionId } });
    assert.equal(beforeReplay.jobPlanningVersion, null);
    assert.deepEqual(beforeReplay.metadata, legacyMetadata);
    const replay = await applyAuditWorkflowTransition(upgradePrisma, legacyInput, { env: safeEnv });
    assert.equal(replay.ok, true);
    if (!replay.ok) return;
    assert.equal(replay.replayed, true);
    assert.equal(replay.value.jobPlanningStatus, 'LEGACY_NOT_PLANNED');
    assert.equal(replay.value.jobPlanHash, null);
    assert.equal(replay.value.plannedJobCount, 0);
    const afterReplay = await upgradePrisma.aiWorkflowTransition.findUniqueOrThrow({ where: { id: transitionId } });
    assert.equal(afterReplay.transitionHash, beforeReplay.transitionHash);
    assert.equal(afterReplay.guardSnapshotHash, beforeReplay.guardSnapshotHash);
    assert.deepEqual(afterReplay.metadata, beforeReplay.metadata);
    assert.equal(afterReplay.jobPlanningVersion, null);
    assert.equal(await upgradePrisma.aiWorkflowTransition.count({
      where: { workflowInstanceId: legacyInput.workflowInstanceId },
    }), 1);
    assert.equal(await upgradePrisma.aiWorkflowJob.count({
      where: { workflowInstanceId: legacyInput.workflowInstanceId },
    }), 0);
    assert.equal(await upgradePrisma.aiWorkflowJobOutboxEvent.count({
      where: { workflowInstanceId: legacyInput.workflowInstanceId },
    }), 0);

    cpSync(
      join(migrationRoot, workerRuntimeMigration),
      join(tempMigrations, workerRuntimeMigration),
      { recursive: true },
    );
    deploy();
    const upgradeConstraint = await upgradePrisma.$queryRaw<Array<{ validated: boolean }>>(Prisma.sql`
      SELECT constraint_row."convalidated" AS "validated"
      FROM pg_constraint constraint_row
      JOIN pg_class table_row ON table_row.oid = constraint_row."conrelid"
      WHERE table_row."relname" = 'AiOrchestratorSetting'
        AND table_row."relnamespace" = TO_REGNAMESPACE(CURRENT_SCHEMA())
        AND constraint_row."conname" = 'AiOrchestratorSetting_dispatch_disabled_check'
    `);
    assert.deepEqual(upgradeConstraint, [{ validated: true }]);
    await assert.rejects(upgradePrisma.$executeRawUnsafe(
      'UPDATE "AiOrchestratorSetting" SET "dispatchEnabled" = true WHERE "id" = \'global\'',
    ));
    assert.equal(await upgradePrisma.aiWorkflowJobRuntime.count({
      where: { workflowInstanceId: legacyInput.workflowInstanceId },
    }), 0);
    assert.equal(await upgradePrisma.aiOrchestratorWorkerCapabilitySetting.count(), 13);
    assert.equal(await upgradePrisma.aiOrchestratorWorkerCapabilitySetting.count({
      where: { enabled: true },
    }), 0);
    assert.equal(await upgradePrisma.aiWorkflowJobAttempt.count(), 0);
    assert.equal(await upgradePrisma.aiWorkflowOutboxConsumption.count(), 0);
    const replayAfterWorkerUpgrade = await applyAuditWorkflowTransition(
      upgradePrisma,
      legacyInput,
      { env: safeEnv },
    );
    assert.equal(replayAfterWorkerUpgrade.ok, true);
    if (replayAfterWorkerUpgrade.ok) {
      assert.equal(replayAfterWorkerUpgrade.replayed, true);
      assert.equal(replayAfterWorkerUpgrade.value.jobPlanningStatus, 'LEGACY_NOT_PLANNED');
      assert.equal(replayAfterWorkerUpgrade.value.plannedJobCount, 0);
    }

    cpSync(
      join(migrationRoot, resultArtifactMigration),
      join(tempMigrations, resultArtifactMigration),
      { recursive: true },
    );
    deploy();
    const resultTables = await upgradePrisma.$queryRaw<Array<{
      resultTable: string | null;
      artifactTable: string | null;
      sourceTable: string | null;
    }>>(Prisma.sql`
      SELECT
        TO_REGCLASS('"AiWorkflowJobResult"')::TEXT AS "resultTable",
        TO_REGCLASS('"AiWorkflowJobArtifact"')::TEXT AS "artifactTable",
        TO_REGCLASS('"AiWorkflowJobSourceArtifact"')::TEXT AS "sourceTable"
    `);
    assert.deepEqual(resultTables, [{
      resultTable: '"AiWorkflowJobResult"',
      artifactTable: '"AiWorkflowJobArtifact"',
      sourceTable: '"AiWorkflowJobSourceArtifact"',
    }]);
    assert.equal(await upgradePrisma.aiWorkflowJobResult.count(), 0);
    assert.equal(await upgradePrisma.aiWorkflowJobArtifact.count(), 0);
    assert.equal(await upgradePrisma.aiWorkflowJobSourceArtifact.count(), 0);

    // PR79 requires the exact dormant PR78-era base. Preserve that base and
    // prove the admin ledger migration does not rewrite it.
    await upgradePrisma.aiOrchestratorSetting.update({
      where: { id: 'global' },
      data: { stateMachineEnabled: false },
    });
    const beforeAdminUpgradeSetting = await upgradePrisma.aiOrchestratorSetting.findUniqueOrThrow({
      where: { id: 'global' },
    });
    const beforeAdminUpgradeCounts = {
      jobs: await upgradePrisma.aiWorkflowJob.count(),
      outboxEvents: await upgradePrisma.aiWorkflowJobOutboxEvent.count(),
      runtimes: await upgradePrisma.aiWorkflowJobRuntime.count(),
      attempts: await upgradePrisma.aiWorkflowJobAttempt.count(),
      results: await upgradePrisma.aiWorkflowJobResult.count(),
      artifacts: await upgradePrisma.aiWorkflowJobArtifact.count(),
      sources: await upgradePrisma.aiWorkflowJobSourceArtifact.count(),
      aiRuns: await upgradePrisma.aiRun.count(),
      aiOutputs: await upgradePrisma.aiOutput.count(),
    };

    cpSync(
      join(migrationRoot, adminControlPlaneMigration),
      join(tempMigrations, adminControlPlaneMigration),
      { recursive: true },
    );
    deploy();

    const bootstrap = await upgradePrisma.$queryRaw<Array<{
      total: number;
      genesis: number;
      foundationLocked: number;
      globalSafe: number;
      scopesSafe: number;
      globalScopes: number;
      providerScopes: number;
      agentScopes: number;
      capabilityScopes: number;
      jobScopes: number;
      workflowScopes: number;
    }>>(Prisma.sql`
      SELECT
        COUNT(*)::INTEGER AS "total",
        COUNT(*) FILTER (
          WHERE "version" = 1
            AND "operationCode" = 'GENESIS'
            AND "previousRevisionHash" IS NULL
            AND "actorUserId" IS NULL
            AND "actorRole" IS NULL
            AND "requestId" IS NULL
        )::INTEGER AS "genesis",
        COUNT(*) FILTER (
          WHERE "policy" ->> 'activationEpoch' = 'FOUNDATION_LOCKED_V1'
        )::INTEGER AS "foundationLocked",
        COUNT(*) FILTER (
          WHERE "scopeType" = 'GLOBAL'
            AND "policy" ->> 'policyCode' = 'AI_ORCHESTRATOR_ADMIN_GLOBAL_POLICY'
            AND "policy" ->> 'desiredMode' = 'STOPPED'
            AND "policy" -> 'desiredStateMachineEnabled' = 'false'::JSONB
            AND "policy" -> 'desiredDispatchEnabled' = 'false'::JSONB
            AND "policy" -> 'emergencyStopEngaged' = 'true'::JSONB
            AND "policy" -> 'globalKillSwitch' = 'true'::JSONB
        )::INTEGER AS "globalSafe",
        COUNT(*) FILTER (
          WHERE "scopeType" <> 'GLOBAL'
            AND "policy" ->> 'policyCode' = 'AI_ORCHESTRATOR_ADMIN_SCOPE_POLICY'
            AND "policy" -> 'desiredEnabled' = 'false'::JSONB
            AND "policy" -> 'killSwitch' = 'true'::JSONB
        )::INTEGER AS "scopesSafe",
        COUNT(*) FILTER (WHERE "scopeType" = 'GLOBAL')::INTEGER AS "globalScopes",
        COUNT(*) FILTER (WHERE "scopeType" = 'PROVIDER')::INTEGER AS "providerScopes",
        COUNT(*) FILTER (WHERE "scopeType" = 'AGENT')::INTEGER AS "agentScopes",
        COUNT(*) FILTER (WHERE "scopeType" = 'CAPABILITY')::INTEGER AS "capabilityScopes",
        COUNT(*) FILTER (WHERE "scopeType" = 'JOB')::INTEGER AS "jobScopes",
        COUNT(*) FILTER (WHERE "scopeType" = 'WORKFLOW')::INTEGER AS "workflowScopes"
      FROM "AiOrchestratorAdminPolicyRevision"
    `);
    assert.deepEqual(bootstrap, [{
      total: 36,
      genesis: 36,
      foundationLocked: 36,
      globalSafe: 1,
      scopesSafe: 35,
      globalScopes: 1,
      providerScopes: 1,
      agentScopes: 7,
      capabilityScopes: 13,
      jobScopes: 13,
      workflowScopes: 1,
    }]);

    assert.deepEqual(
      await upgradePrisma.aiOrchestratorSetting.findUniqueOrThrow({
        where: { id: 'global' },
      }),
      beforeAdminUpgradeSetting,
    );
    assert.equal(await upgradePrisma.aiOrchestratorWorkerCapabilitySetting.count(), 13);
    assert.equal(await upgradePrisma.aiOrchestratorWorkerCapabilitySetting.count({
      where: { enabled: true },
    }), 0);
    assert.deepEqual({
      jobs: await upgradePrisma.aiWorkflowJob.count(),
      outboxEvents: await upgradePrisma.aiWorkflowJobOutboxEvent.count(),
      runtimes: await upgradePrisma.aiWorkflowJobRuntime.count(),
      attempts: await upgradePrisma.aiWorkflowJobAttempt.count(),
      results: await upgradePrisma.aiWorkflowJobResult.count(),
      artifacts: await upgradePrisma.aiWorkflowJobArtifact.count(),
      sources: await upgradePrisma.aiWorkflowJobSourceArtifact.count(),
      aiRuns: await upgradePrisma.aiRun.count(),
      aiOutputs: await upgradePrisma.aiOutput.count(),
    }, beforeAdminUpgradeCounts);

    const adminUpgradeConstraint = await upgradePrisma.$queryRaw<Array<{
      validated: boolean;
      definition: string;
    }>>(Prisma.sql`
      SELECT constraint_row."convalidated" AS "validated",
             PG_GET_CONSTRAINTDEF(constraint_row.oid) AS "definition"
      FROM pg_constraint constraint_row
      JOIN pg_class table_row ON table_row.oid = constraint_row."conrelid"
      WHERE table_row."relname" = 'AiOrchestratorSetting'
        AND table_row."relnamespace" = TO_REGNAMESPACE(CURRENT_SCHEMA())
        AND constraint_row."conname" = 'AiOrchestratorSetting_dispatch_disabled_check'
    `);
    assert.deepEqual(adminUpgradeConstraint, [{
      validated: true,
      definition: 'CHECK (("dispatchEnabled" = false))',
    }]);
    await assert.rejects(upgradePrisma.$executeRawUnsafe(
      'UPDATE "AiOrchestratorSetting" SET "dispatchEnabled" = true WHERE "id" = \'global\'',
    ));
  } finally {
    await upgradePrisma.$disconnect();
  }
});

// WORKER RUNTIME FOUNDATION TESTS: positive runtime paths may open dispatch
// only through withTemporaryDispatchFixture in the confirmed ephemeral DB.
async function setWorkerRuntimeGates(stateMachineEnabled: boolean, dispatchEnabled: boolean) {
  if (dispatchEnabled && !workerRuntimeDispatchFixtureOpen) {
    throw new Error('dispatchEnabled=true è consentito soltanto nella fixture DDL runtime confermata.');
  }
  await db().aiOrchestratorSetting.update({
    where: { id: 'global' },
    data: { stateMachineEnabled, dispatchEnabled, syntheticDataOnly: true, provider: 'mock' },
  });
  await db().aiControlSetting.update({
    where: { id: 'global' },
    data: { externalProvidersEnabled: false },
  });
}

async function setWorkerCapabilityGates(enabledJobCodes: readonly string[]) {
  const requested = new Set(enabledJobCodes);
  if (requested.size > 0 && !workerRuntimeDispatchFixtureOpen) {
    throw new Error('Capability runtime positive consentite soltanto nella fixture DDL confermata.');
  }
  for (const jobCode of FAI_AUDIT_JOB_CODES) {
    const setting = await db().aiOrchestratorWorkerCapabilitySetting.findUniqueOrThrow({
      where: { jobCode },
    });
    const enabled = requested.has(jobCode);
    if (setting.enabled === enabled) continue;
    await db().aiOrchestratorWorkerCapabilitySetting.update({
      where: { jobCode },
      data: { enabled, version: { increment: 1 } },
    });
  }
}

async function createDataValidationRuntimeCase() {
  await setWorkerRuntimeGates(true, false);
  const created = await createCase();
  await advanceToDataValidation(created.value.workflowInstanceId);
  const job = await db().aiWorkflowJob.findFirstOrThrow({
    where: { workflowInstanceId: created.value.workflowInstanceId },
  });
  const outbox = await db().aiWorkflowJobOutboxEvent.findFirstOrThrow({
    where: { jobId: job.id },
  });
  return { workflowInstanceId: created.value.workflowInstanceId, job, outbox };
}

async function rawAdmissionWithoutAdmittedEvent(
  tx: Prisma.TransactionClient,
  job: AiWorkflowJob,
  outbox: AiWorkflowJobOutboxEvent,
) {
  const capability = getAiOrchestratorWorkerCapability(job.jobCode);
  assert.ok(capability);
  const nowRows = await tx.$queryRaw<Array<{ now: Date }>>(Prisma.sql`
    SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "now"
  `);
  const now = nowRows[0]?.now;
  assert.ok(now);
  const runtimeId = randomUUID();
  const capabilityHash = AI_ORCHESTRATOR_WORKER_CAPABILITY_HASHES[capability.jobCode];
  await tx.aiWorkflowJobRuntime.create({
    data: {
      id: runtimeId,
      jobId: job.id,
      workflowInstanceId: job.workflowInstanceId,
      runtimePolicyCode: AI_ORCHESTRATOR_WORKER_RUNTIME_POLICY_CODE,
      runtimePolicyVersion: AI_ORCHESTRATOR_WORKER_RUNTIME_POLICY_VERSION,
      runtimePolicyHash: AI_ORCHESTRATOR_WORKER_RUNTIME_POLICY_HASH,
      capabilityCode: capability.capabilityCode,
      capabilityVersion: capability.capabilityVersion,
      capabilityHash,
      handlerCode: capability.handlerCode,
      handlerVersion: capability.handlerVersion,
      state: 'AVAILABLE',
      effectiveAvailableAt: job.availableAt,
      createdAt: now,
      updatedAt: now,
    },
  });
  await tx.aiWorkflowOutboxConsumption.create({
    data: {
      id: randomUUID(),
      outboxEventId: outbox.id,
      jobId: job.id,
      runtimeId,
      consumerCode: 'AI_ORCHESTRATOR_JOB_PLANNED_CONSUMER',
      consumerVersion: '1.0',
      runtimePolicyHash: AI_ORCHESTRATOR_WORKER_RUNTIME_POLICY_HASH,
      capabilityHash,
      eventKey: outbox.eventKey,
      eventPayloadHash: outbox.payloadHash,
      jobDedupeKey: job.dedupeKey,
      jobPayloadHash: job.payloadHash,
      workflowDefinitionHash: job.workflowDefinitionHash,
      phaseCode: job.phaseCode,
      phaseEntrySequence: job.phaseEntrySequence,
      correctionCycle: job.correctionCycle,
      executorAgentId: job.executorAgentId,
      executorAgentConfigVersion: job.executorAgentConfigVersion,
      executorAgentConfigHash: job.executorAgentConfigHash,
      consumedAt: now,
    },
  });
}

async function insertRawRuntimeEvent(
  tx: Prisma.TransactionClient,
  runtimeId: string,
  input: {
    eventType: string;
    attemptSequence: number | null;
    fencingToken: bigint | null;
    reasonCode: string | null;
    payload: Record<string, string | number | boolean | null>;
    occurredAt?: Date;
  },
) {
  const runtime = await tx.aiWorkflowJobRuntime.findUniqueOrThrow({ where: { id: runtimeId } });
  const previous = await tx.aiWorkflowJobRuntimeEvent.findFirstOrThrow({
    where: { runtimeId },
    orderBy: { sequence: 'desc' },
  });
  const occurredAt = input.occurredAt ?? (await tx.$queryRaw<Array<{ now: Date }>>(Prisma.sql`
    SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "now"
  `))[0]?.now;
  assert.ok(occurredAt);
  const payload = {
    schemaVersion: 1,
    runtimePolicyHash: AI_ORCHESTRATOR_WORKER_RUNTIME_POLICY_HASH,
    ...input.payload,
  };
  const payloadHash = canonicalSha256(payload);
  const sequence = previous.sequence + 1;
  const eventHash = canonicalSha256({
    schemaVersion: 1,
    runtimeId,
    jobId: runtime.jobId,
    workflowInstanceId: runtime.workflowInstanceId,
    sequence,
    eventType: input.eventType,
    attemptSequence: input.attemptSequence,
    fencingToken: input.fencingToken === null ? null : String(input.fencingToken),
    reasonCode: input.reasonCode,
    payloadHash,
    previousEventHash: previous.eventHash,
    occurredAt: occurredAt.toISOString(),
  });
  await tx.aiWorkflowJobRuntimeEvent.create({
    data: {
      id: randomUUID(),
      runtimeId,
      jobId: runtime.jobId,
      workflowInstanceId: runtime.workflowInstanceId,
      sequence,
      eventType: input.eventType,
      attemptSequence: input.attemptSequence,
      fencingToken: input.fencingToken,
      reasonCode: input.reasonCode,
      payload,
      payloadHash,
      previousEventHash: previous.eventHash,
      eventHash,
      occurredAt,
    },
  });
}

async function insertSemanticallyFalseSucceededEvent(
  tx: Prisma.TransactionClient,
  runtimeId: string,
) {
  const runtime = await tx.aiWorkflowJobRuntime.findUniqueOrThrow({ where: { id: runtimeId } });
  await insertRawRuntimeEvent(tx, runtimeId, {
    eventType: 'SUCCEEDED',
    attemptSequence: runtime.attemptSequence,
    fencingToken: runtime.fencingToken,
    reasonCode: 'SUCCEEDED',
    payload: {
      resultHash: '9'.repeat(64),
      provider: 'mock',
      workflowTransitionApplied: false,
    },
  });
}

test('Worker Runtime resta fail-closed, senza backfill e con dispatch fisicamente chiuso', { skip: !runDbTests }, async () => {
  const created = await createDataValidationRuntimeCase();
  const capabilitySettings = await db().aiOrchestratorWorkerCapabilitySetting.findMany({
    orderBy: { jobCode: 'asc' },
  });
  assert.equal(capabilitySettings.length, 13);
  assert.ok(capabilitySettings.every((setting) => setting.enabled === false));
  assert.equal(await db().aiWorkflowJobRuntime.count({
    where: { workflowInstanceId: created.workflowInstanceId },
  }), 0);
  assert.equal(await db().aiWorkflowOutboxConsumption.count({ where: { jobId: created.job.id } }), 0);

  delete process.env.AI_ORCHESTRATOR_WORKER_ENABLED;
  await assert.rejects(
    admitAiWorkflowJobOutbox({ workflowInstanceId: created.workflowInstanceId }),
    AiOrchestratorWorkerDisabledError,
  );
  process.env.AI_ORCHESTRATOR_WORKER_ENABLED = '1';
  await assert.rejects(
    admitAiWorkflowJobOutbox({ workflowInstanceId: created.workflowInstanceId }),
    AiOrchestratorWorkerDisabledError,
  );
  await assert.rejects(setWorkerRuntimeGates(true, true), /fixture DDL runtime/);
  await withTemporaryDispatchFixture(async () => {
    assert.equal(await admitAiWorkflowJobOutbox({
      workflowInstanceId: created.workflowInstanceId,
    }), 0);
    await assert.rejects(db().$transaction(async (tx) => {
      await rawAdmissionWithoutAdmittedEvent(tx, created.job, created.outbox);
    }), /capability|disabled/i);
  }, { enabledJobCodes: [] });
  assert.deepEqual(await dispatchConstraintState(), { present: true, validated: true });
  assert.equal(await db().aiOrchestratorWorkerCapabilitySetting.count({ where: { enabled: true } }), 0);
  assert.equal(await db().aiWorkflowJobRuntime.count({ where: { jobId: created.job.id } }), 0);
});

test('catalogo capability SQL e TypeScript coincidono per tutti i 13 job e ogni famiglia è ammissibile', { skip: !runDbTests }, async () => {
  assert.equal(AI_ORCHESTRATOR_WORKER_CAPABILITIES.length, 13);
  for (const jobCode of FAI_AUDIT_JOB_CODES) {
    const sqlRows = await db().$queryRaw<Array<{
      capabilityCode: string;
      capabilityHash: string;
      handlerCode: string;
      jobDefinitionHash: string;
      executorAgentCode: string;
      executorAgentConfigVersion: number;
      executorAgentConfigHash: string;
    }>>(Prisma.sql`
      SELECT * FROM "expected_ai_workflow_worker_capability"(${jobCode})
    `);
    const sql = sqlRows[0];
    const capability = getAiOrchestratorWorkerCapability(jobCode);
    const executor = FAI_AUDIT_JOB_EXECUTOR_BINDINGS.find((entry) => entry.jobCode === jobCode);
    const setting = await db().aiOrchestratorWorkerCapabilitySetting.findUnique({
      where: { jobCode },
    });
    assert.ok(sql && capability && executor);
    assert.deepEqual(sql, {
      capabilityCode: capability.capabilityCode,
      capabilityHash: AI_ORCHESTRATOR_WORKER_CAPABILITY_HASHES[jobCode],
      handlerCode: capability.handlerCode,
      jobDefinitionHash: FAI_AUDIT_JOB_DEFINITION_HASHES[jobCode],
      executorAgentCode: executor.executorAgentCode,
      executorAgentConfigVersion: executor.executorAgentConfigVersion,
      executorAgentConfigHash: executor.executorAgentConfigHash,
    });
    assert.deepEqual(setting && {
      capabilityCode: setting.capabilityCode,
      capabilityVersion: setting.capabilityVersion,
      capabilityHash: setting.capabilityHash,
      enabled: setting.enabled,
    }, {
      capabilityCode: capability.capabilityCode,
      capabilityVersion: capability.capabilityVersion,
      capabilityHash: AI_ORCHESTRATOR_WORKER_CAPABILITY_HASHES[jobCode],
      enabled: false,
    });
  }

  process.env.AI_ORCHESTRATOR_WORKER_ENABLED = '1';
  await setWorkerRuntimeGates(true, false);
  const created = await createCase();
  const id = created.value.workflowInstanceId;
  await applyOk(id, 'WF-001', human(runnerId));
  await applyOk(id, 'WF-002', human(runnerId));
  await applyOk(id, 'WF-003', human(runnerId));
  await applyOk(id, 'WF-004', human(runnerId));
  assert.equal(await withTemporaryDispatchFixture(
    () => admitAiWorkflowJobOutbox({ workflowInstanceId: id }),
  ), 1);
  await applyOk(id, 'WF-005', agent());
  assert.equal(await withTemporaryDispatchFixture(
    () => admitAiWorkflowJobOutbox({ workflowInstanceId: id }),
  ), 1);
  await applyOk(id, 'WF-006', agent());
  assert.equal(await withTemporaryDispatchFixture(
    () => admitAiWorkflowJobOutbox({ workflowInstanceId: id }),
  ), 1);
  await applyOk(id, 'WF-007', agent());
  await applyOk(id, 'WF-010', human(runnerId));
  assert.equal(await withTemporaryDispatchFixture(
    () => admitAiWorkflowJobOutbox({ workflowInstanceId: id }),
  ), 3);
  await applyOk(id, 'WF-011', system());
  assert.equal(await withTemporaryDispatchFixture(
    () => admitAiWorkflowJobOutbox({ workflowInstanceId: id }),
  ), 1);
  await applyOk(id, 'WF-012', agent());
  assert.equal(await withTemporaryDispatchFixture(
    () => admitAiWorkflowJobOutbox({ workflowInstanceId: id }),
  ), 1);
  await applyOk(id, 'WF-013', agent());
  assert.equal(await withTemporaryDispatchFixture(
    () => admitAiWorkflowJobOutbox({ workflowInstanceId: id }),
  ), 4);
  await applyOk(id, 'WF-014', system());
  await applyOk(id, 'WF-015', system());
  assert.equal(await withTemporaryDispatchFixture(
    () => admitAiWorkflowJobOutbox({ workflowInstanceId: id }),
  ), 1);
  await applyOk(id, 'WF-016', agent());
  assert.equal(await withTemporaryDispatchFixture(
    () => admitAiWorkflowJobOutbox({ workflowInstanceId: id }),
  ), 4);
  const admittedCodes = new Set((await db().aiWorkflowJobRuntime.findMany({
    where: { workflowInstanceId: id },
    select: { job: { select: { jobCode: true } } },
  })).map((runtime) => runtime.job.jobCode));
  assert.deepEqual([...admittedCodes].sort(), [...FAI_AUDIT_JOB_CODES].sort());
});

test('constraint differiti rifiutano admission, claim, success, attempt ed evento semanticamente incompleti', { skip: !runDbTests }, async () => {
  process.env.AI_ORCHESTRATOR_WORKER_ENABLED = '1';
  const admissionCase = await createDataValidationRuntimeCase();
  await withTemporaryDispatchFixture(async () => {
    await assert.rejects(db().$transaction(async (tx) => {
      await rawAdmissionWithoutAdmittedEvent(tx, admissionCase.job, admissionCase.outbox);
      await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
    }), /ADMITTED|consistency|canonical/);
    assert.equal(await db().aiWorkflowJobRuntime.count({ where: { jobId: admissionCase.job.id } }), 0);
    assert.equal(await admitAiWorkflowJobOutbox({
      workflowInstanceId: admissionCase.workflowInstanceId,
    }), 1);
    const runtime = await db().aiWorkflowJobRuntime.findUniqueOrThrow({
      where: { jobId: admissionCase.job.id },
    });

    await assert.rejects(db().$transaction(async (tx) => {
      await insertRawRuntimeEvent(tx, runtime.id, {
        eventType: 'ADMITTED',
        attemptSequence: null,
        fencingToken: null,
        reasonCode: null,
        payload: {
          jobCode: admissionCase.job.jobCode,
          capabilityCode: runtime.capabilityCode,
          capabilityHash: runtime.capabilityHash,
          eventKey: admissionCase.outbox.eventKey,
          provider: 'mock',
          dataMode: 'synthetic',
          networkAccessAllowed: false,
          crmDataAccessAllowed: false,
          providerCallAllowed: false,
          workflowTransitionWriteAllowed: false,
        },
      });
    }), /one_admitted|duplicate key|unique constraint failed/i);

    await assert.rejects(db().$transaction(async (tx) => {
      const nowRows = await tx.$queryRaw<Array<{ now: Date }>>(Prisma.sql`
        SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "now"
      `);
      const now = nowRows[0]?.now;
      assert.ok(now);
      await tx.$executeRaw(Prisma.sql`
        UPDATE "AiWorkflowJobRuntime"
        SET "state" = 'LEASED',
          "attemptSequence" = 1,
          "fencingToken" = 1,
          "leaseOwnerId" = 'raw-missing-attempt',
          "leaseTokenHash" = ${'1'.repeat(64)},
          "leaseClaimedAt" = ${now},
          "leaseExpiresAt" = ${new Date(now.getTime() + 120_000)},
          "leaseMaxExpiresAt" = ${new Date(now.getTime() + 600_000)},
          "updatedAt" = ${now}
        WHERE "id" = ${runtime.id}
      `);
      await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
    }), /attempt|CLAIMED|consistency/);

    const claim = await claimNextAiWorkflowJob({
      workerInstanceId: 'semantic-negative-worker',
      workerBuildHash: '2'.repeat(64),
      workflowInstanceId: admissionCase.workflowInstanceId,
    });
    assert.ok(claim);
    const claimedRuntime = await db().aiWorkflowJobRuntime.findUniqueOrThrow({
      where: { id: claim.runtimeId },
    });
    const claimedAttempt = await db().aiWorkflowJobAttempt.findFirstOrThrow({
      where: { runtimeId: claim.runtimeId, attemptSequence: claim.attemptSequence },
    });

    await assert.rejects(db().$transaction(async (tx) => {
      await insertRawRuntimeEvent(tx, claim.runtimeId, {
        eventType: 'CLAIMED',
        attemptSequence: claim.attemptSequence,
        fencingToken: claim.fencingToken,
        reasonCode: null,
        occurredAt: claimedAttempt.claimedAt,
        payload: {
          workerInstanceId: claimedAttempt.workerInstanceId,
          workerBuildHash: claimedAttempt.workerBuildHash,
          leaseExpiresAt: claimedAttempt.leaseExpiresAt.toISOString(),
          leaseMaxExpiresAt: claimedAttempt.leaseMaxExpiresAt.toISOString(),
          capabilityHash: claimedAttempt.capabilityHash,
        },
      });
    }), /one_claimed|duplicate key|unique constraint failed/i);

    await assert.rejects(db().$transaction(async (tx) => {
      const nowRows = await tx.$queryRaw<Array<{ now: Date }>>(Prisma.sql`
        SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "now"
      `);
      const now = nowRows[0]?.now;
      assert.ok(now);
      await tx.$executeRaw(Prisma.sql`
        UPDATE "AiWorkflowJobRuntime"
        SET "state" = 'SUCCEEDED',
          "leaseOwnerId" = NULL,
          "leaseTokenHash" = NULL,
          "leaseClaimedAt" = NULL,
          "leaseExpiresAt" = NULL,
          "leaseMaxExpiresAt" = NULL,
          "terminalAt" = ${now},
          "terminalReasonCode" = 'SUCCEEDED',
          "resultHash" = ${'3'.repeat(64)},
          "lastFailureCode" = NULL,
          "updatedAt" = ${now}
        WHERE "id" = ${claim.runtimeId}
      `);
      await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
    }), /SUCCEEDED|attempt|audit|consistency/);

    await assert.rejects(db().$transaction(async (tx) => {
      const nowRows = await tx.$queryRaw<Array<{ now: Date }>>(Prisma.sql`
        SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "now"
      `);
      const now = nowRows[0]?.now;
      assert.ok(now);
      await tx.aiWorkflowJobAttempt.update({
        where: {
          runtimeId_attemptSequence: {
            runtimeId: claim.runtimeId,
            attemptSequence: claim.attemptSequence,
          },
        },
        data: {
          finishedAt: now,
          outcome: 'FAILED_TERMINAL',
          failureCode: 'CAPABILITY_DENIED',
          retryable: false,
          retryBudgetConsumed: false,
        },
      });
      await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
    }), /LEASED|attempt|consistency/);

    await assert.rejects(db().$transaction(async (tx) => {
      await insertSemanticallyFalseSucceededEvent(tx, claim.runtimeId);
      await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
    }), /semantically|cardinality|SUCCEEDED|consistency/);
    assert.deepEqual(
      await db().aiWorkflowJobRuntime.findUniqueOrThrow({ where: { id: claim.runtimeId } }),
      claimedRuntime,
    );
    await surrenderAiWorkflowJobLease(claim.lease);
  });
});

test('audit differito rifiuta un attempt precedente concluso senza il proprio evento terminale', { skip: !runDbTests }, async () => {
  process.env.AI_ORCHESTRATOR_WORKER_ENABLED = '1';
  const created = await createDataValidationRuntimeCase();
  await withTemporaryDispatchFixture(async () => {
    await admitAiWorkflowJobOutbox({ workflowInstanceId: created.workflowInstanceId });
    const runtime = await db().aiWorkflowJobRuntime.findUniqueOrThrow({
      where: { jobId: created.job.id },
    });
    await assert.rejects(db().$transaction(async (tx) => {
      const now = (await tx.$queryRaw<Array<{ now: Date }>>(Prisma.sql`
        SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "now"
      `))[0]?.now;
      assert.ok(now);

      const claimRawAttempt = async (attemptSequence: number) => {
        const fencingToken = BigInt(attemptSequence);
        const leaseTokenHash = String.fromCharCode(96 + attemptSequence).repeat(64);
        const leaseExpiresAt = new Date(now.getTime() + 120_000);
        const leaseMaxExpiresAt = new Date(now.getTime() + 600_000);
        await tx.aiWorkflowJobRuntime.update({
          where: { id: runtime.id },
          data: {
            state: 'LEASED',
            attemptSequence,
            fencingToken,
            leaseOwnerId: `raw-audit-worker-${attemptSequence}`,
            leaseTokenHash,
            leaseClaimedAt: now,
            leaseExpiresAt,
            leaseMaxExpiresAt,
            lastFailureCode: null,
            updatedAt: now,
          },
        });
        await tx.aiWorkflowJobAttempt.create({
          data: {
            id: randomUUID(),
            runtimeId: runtime.id,
            jobId: created.job.id,
            attemptSequence,
            fencingToken,
            workerInstanceId: `raw-audit-worker-${attemptSequence}`,
            workerBuildHash: String(attemptSequence).repeat(64),
            leaseTokenHash,
            claimedAt: now,
            leaseExpiresAt,
            leaseMaxExpiresAt,
            runtimePolicyHash: runtime.runtimePolicyHash,
            capabilityHash: runtime.capabilityHash,
            handlerCode: runtime.handlerCode,
            handlerVersion: runtime.handlerVersion,
            workflowDefinitionHash: created.job.workflowDefinitionHash,
            phaseCode: created.job.phaseCode,
            phaseEntrySequence: created.job.phaseEntrySequence,
            correctionCycle: created.job.correctionCycle,
            executorAgentId: created.job.executorAgentId,
            executorAgentConfigVersion: created.job.executorAgentConfigVersion,
            executorAgentConfigHash: created.job.executorAgentConfigHash,
            jobPayloadHash: created.job.payloadHash,
          },
        });
        await insertRawRuntimeEvent(tx, runtime.id, {
          eventType: 'CLAIMED',
          attemptSequence,
          fencingToken,
          reasonCode: null,
          occurredAt: now,
          payload: {
            workerInstanceId: `raw-audit-worker-${attemptSequence}`,
            workerBuildHash: String(attemptSequence).repeat(64),
            leaseExpiresAt: leaseExpiresAt.toISOString(),
            leaseMaxExpiresAt: leaseMaxExpiresAt.toISOString(),
            capabilityHash: runtime.capabilityHash,
          },
        });
      };

      const surrenderRawAttempt = async (attemptSequence: number, appendTerminalEvent: boolean) => {
        await tx.aiWorkflowJobRuntime.update({
          where: { id: runtime.id },
          data: {
            state: 'RETRY_WAIT',
            effectiveAvailableAt: now,
            leaseOwnerId: null,
            leaseTokenHash: null,
            leaseClaimedAt: null,
            leaseExpiresAt: null,
            leaseMaxExpiresAt: null,
            lastFailureCode: null,
            updatedAt: now,
          },
        });
        await tx.aiWorkflowJobAttempt.update({
          where: { runtimeId_attemptSequence: { runtimeId: runtime.id, attemptSequence } },
          data: {
            finishedAt: now,
            outcome: 'SURRENDERED',
            retryable: true,
            retryBudgetConsumed: false,
          },
        });
        if (appendTerminalEvent) {
          await insertRawRuntimeEvent(tx, runtime.id, {
            eventType: 'SURRENDERED',
            attemptSequence,
            fencingToken: BigInt(attemptSequence),
            reasonCode: 'WORKER_SURRENDERED',
            occurredAt: now,
            payload: { retryBudgetConsumed: false },
          });
        }
      };

      await claimRawAttempt(1);
      await surrenderRawAttempt(1, false);
      await claimRawAttempt(2);
      await surrenderRawAttempt(2, true);
      await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
    }), /cardinality|terminal|consistency/i);
    const persisted = await db().aiWorkflowJobRuntime.findUniqueOrThrow({ where: { id: runtime.id } });
    assert.equal(persisted.state, 'AVAILABLE');
    assert.equal(persisted.attemptSequence, 0);
  });
});

test('doppio claim concorrente produce un vincitore e receipt/attempt/audit canonici', { skip: !runDbTests }, async () => {
  process.env.AI_ORCHESTRATOR_WORKER_ENABLED = '1';
  const created = await createDataValidationRuntimeCase();
  await withTemporaryDispatchFixture(async () => {
    assert.equal(await admitAiWorkflowJobOutbox({ workflowInstanceId: created.workflowInstanceId }), 1);
    assert.equal(await admitAiWorkflowJobOutbox({ workflowInstanceId: created.workflowInstanceId }), 0);
    const claims = await Promise.all([
      claimNextAiWorkflowJob({
        workerInstanceId: 'concurrent-worker-a',
        workerBuildHash: 'a'.repeat(64),
        workflowInstanceId: created.workflowInstanceId,
      }),
      claimNextAiWorkflowJob({
        workerInstanceId: 'concurrent-worker-b',
        workerBuildHash: 'b'.repeat(64),
        workflowInstanceId: created.workflowInstanceId,
      }),
    ]);
    assert.equal(claims.filter(Boolean).length, 1);
    const claim = claims.find(Boolean);
    assert.ok(claim);
    assert.equal(claim.fencingToken, 1n);
    assert.equal(await db().aiWorkflowJobAttempt.count({ where: { runtimeId: claim.runtimeId } }), 1);
    assert.equal(await db().aiWorkflowOutboxConsumption.count({ where: { runtimeId: claim.runtimeId } }), 1);
    assert.equal(await db().aiWorkflowJobRuntimeEvent.count({ where: { runtimeId: claim.runtimeId } }), 2);
    await surrenderAiWorkflowJobLease(claim.lease);
  });
});

test('recovery scaduta è singola e il vecchio fence non torna utilizzabile', { skip: !runDbTests }, async () => {
  process.env.AI_ORCHESTRATOR_WORKER_ENABLED = '1';
  const created = await createDataValidationRuntimeCase();
  const oldClaim = await withTemporaryDispatchFixture(async () => {
    await admitAiWorkflowJobOutbox({ workflowInstanceId: created.workflowInstanceId });
    const claimed = await claimNextAiWorkflowJob({
      workerInstanceId: 'expired-worker',
      workerBuildHash: 'c'.repeat(64),
      workflowInstanceId: created.workflowInstanceId,
    });
    assert.ok(claimed);
    return claimed;
  });
  await expireLeaseForTest(oldClaim.runtimeId);
  const recoveries = await Promise.all([
    recoverExpiredAiWorkflowJobLeases({ batchSize: 1 }),
    recoverExpiredAiWorkflowJobLeases({ batchSize: 1 }),
  ]);
  assert.equal(recoveries.reduce((sum, value) => sum + value, 0), 1);
  assert.equal(await recoverExpiredAiWorkflowJobLeases({ batchSize: 1 }), 0);
  await makeRetryImmediatelyAvailableForTest(oldClaim.runtimeId);

  await withTemporaryDispatchFixture(async () => {
    await assertRuntimeReadyForRetryClaim(oldClaim.runtimeId);
    const newClaim = await claimNextAiWorkflowJob({
      workerInstanceId: 'reclaimed-worker',
      workerBuildHash: 'd'.repeat(64),
      workflowInstanceId: created.workflowInstanceId,
    });
    assert.ok(newClaim);
    assert.equal(newClaim.fencingToken, oldClaim.fencingToken + 1n);
    await assert.rejects(
      heartbeatAiWorkflowJobLease(oldClaim.lease),
      AiOrchestratorLeaseLostError,
    );
    await assert.rejects(
      completeAiWorkflowJob(oldClaim.lease, { resultDraft: createSyntheticAiResultDraft(oldClaim.jobCode) }),
      AiOrchestratorLeaseLostError,
    );
    const winningDraft = createSyntheticAiResultDraft(newClaim.jobCode);
    await completeAiWorkflowJob(newClaim.lease, { resultDraft: winningDraft });
    await assert.rejects(
      completeAiWorkflowJob(oldClaim.lease, { resultDraft: winningDraft }),
      AiOrchestratorLeaseLostError,
    );
    assert.equal(await db().aiWorkflowJobRuntimeEvent.count({
      where: { runtimeId: oldClaim.runtimeId, eventType: 'LEASE_RECOVERED' },
    }), 1);
  });
});

test('recovery usa la causa canonica esatta e non ritenta un executor diventato inattivo', { skip: !runDbTests }, async () => {
  process.env.AI_ORCHESTRATOR_WORKER_ENABLED = '1';
  const created = await createDataValidationRuntimeCase();
  const claim = await withTemporaryDispatchFixture(async () => {
    await admitAiWorkflowJobOutbox({ workflowInstanceId: created.workflowInstanceId });
    const claimed = await claimNextAiWorkflowJob({
      workerInstanceId: 'executor-invalid-recovery-worker',
      workerBuildHash: 'e'.repeat(64),
      workflowInstanceId: created.workflowInstanceId,
    });
    assert.ok(claimed);
    return claimed;
  });
  await expireLeaseForTest(claim.runtimeId);
  try {
    await db().aiAgent.update({ where: { id: created.job.executorAgentId }, data: { active: false } });
    assert.equal(await recoverExpiredAiWorkflowJobLeases({ batchSize: 1 }), 1);
    const [runtime, attempt, event] = await Promise.all([
      db().aiWorkflowJobRuntime.findUniqueOrThrow({ where: { id: claim.runtimeId } }),
      db().aiWorkflowJobAttempt.findFirstOrThrow({ where: { runtimeId: claim.runtimeId } }),
      db().aiWorkflowJobRuntimeEvent.findFirstOrThrow({
        where: { runtimeId: claim.runtimeId, eventType: 'LEASE_RECOVERED' },
      }),
    ]);
    assert.equal(runtime.state, 'SUPERSEDED');
    assert.equal(runtime.terminalReasonCode, 'EXECUTOR_INACTIVE');
    assert.equal(runtime.retryFailureCount, 0);
    assert.equal(attempt.outcome, 'SUPERSEDED');
    assert.equal(attempt.failureCode, 'EXECUTOR_INACTIVE');
    assert.equal(attempt.retryBudgetConsumed, false);
    assert.equal(event.reasonCode, 'EXECUTOR_INACTIVE');
  } finally {
    await db().aiAgent.update({ where: { id: created.job.executorAgentId }, data: { active: true } });
  }
});

test('il worker non può inventare una causa strutturale di supersession', { skip: !runDbTests }, async () => {
  process.env.AI_ORCHESTRATOR_WORKER_ENABLED = '1';
  const created = await createDataValidationRuntimeCase();
  await withTemporaryDispatchFixture(async () => {
    await admitAiWorkflowJobOutbox({ workflowInstanceId: created.workflowInstanceId });
    const claim = await claimNextAiWorkflowJob({
      workerInstanceId: 'false-causal-reason-worker',
      workerBuildHash: 'd'.repeat(64),
      workflowInstanceId: created.workflowInstanceId,
    });
    assert.ok(claim);
    await assert.rejects(
      failAiWorkflowJob(claim.lease, { failureCode: 'HUMAN_APPROVAL_REACHED' }),
      AiOrchestratorWorkerDisabledError,
    );
    assert.equal((await db().aiWorkflowJobRuntime.findUniqueOrThrow({
      where: { id: claim.runtimeId },
    })).state, 'LEASED');
    await surrenderAiWorkflowJobLease(claim.lease);
  });
});

test('heartbeat e success sono negati a gate chiusi e la durata massima non è superabile', { skip: !runDbTests }, async () => {
  process.env.AI_ORCHESTRATOR_WORKER_ENABLED = '1';
  const closedCase = await createDataValidationRuntimeCase();
  const claim = await withTemporaryDispatchFixture(async () => {
    await admitAiWorkflowJobOutbox({ workflowInstanceId: closedCase.workflowInstanceId });
    const claimed = await claimNextAiWorkflowJob({
      workerInstanceId: 'closed-gate-worker',
      workerBuildHash: 'e'.repeat(64),
      workflowInstanceId: closedCase.workflowInstanceId,
    });
    assert.ok(claimed);
    await assert.rejects(db().aiWorkflowJobRuntime.update({
      where: { id: claimed.runtimeId },
      data: {
        leaseExpiresAt: new Date(
          claimed.leaseExpiresAt.getTime() + AI_ORCHESTRATOR_WORKER_RUNTIME_LIMITS.maxAttemptDurationMs,
        ),
      },
    }));
    return claimed;
  });
  await assert.rejects(heartbeatAiWorkflowJobLease(claim.lease), AiOrchestratorWorkerDisabledError);
  await assert.rejects(
    completeAiWorkflowJob(claim.lease, { resultDraft: createSyntheticAiResultDraft(claim.jobCode) }),
    AiOrchestratorWorkerDisabledError,
  );
  await surrenderAiWorkflowJobLease(claim.lease);
});

test('kill switch capability è selettivo e blocca heartbeat/success senza impedire surrender', { skip: !runDbTests }, async () => {
  process.env.AI_ORCHESTRATOR_WORKER_ENABLED = '1';
  const created = await createDataValidationRuntimeCase();
  await withTemporaryDispatchFixture(async () => {
    const enabled = await db().aiOrchestratorWorkerCapabilitySetting.findMany({
      where: { enabled: true },
      select: { jobCode: true },
    });
    assert.deepEqual(enabled, [{ jobCode: created.job.jobCode }]);
    assert.equal(await admitAiWorkflowJobOutbox({
      workflowInstanceId: created.workflowInstanceId,
    }), 1);
    const claim = await claimNextAiWorkflowJob({
      workerInstanceId: 'capability-kill-switch-worker',
      workerBuildHash: 'f'.repeat(64),
      workflowInstanceId: created.workflowInstanceId,
    });
    assert.ok(claim);
    await setWorkerCapabilityGates([]);
    await assert.rejects(heartbeatAiWorkflowJobLease(claim.lease), AiOrchestratorWorkerDisabledError);
    await assert.rejects(
      completeAiWorkflowJob(claim.lease, { resultDraft: createSyntheticAiResultDraft(claim.jobCode) }),
      AiOrchestratorWorkerDisabledError,
    );
    await surrenderAiWorkflowJobLease(claim.lease);
  }, { enabledJobCodes: [created.job.jobCode] });
  assert.equal(await db().aiOrchestratorWorkerCapabilitySetting.count({ where: { enabled: true } }), 0);
});

test('retry budget: prime due failure ritentano, terza termina, non-retryable e surrender non consumano budget', { skip: !runDbTests }, async () => {
  process.env.AI_ORCHESTRATOR_WORKER_ENABLED = '1';
  const retryCase = await createDataValidationRuntimeCase();
  const terminalCase = await createDataValidationRuntimeCase();
  const surrenderCase = await createDataValidationRuntimeCase();
  await withTemporaryDispatchFixture(async () => {
    await admitAiWorkflowJobOutbox({ workflowInstanceId: retryCase.workflowInstanceId });
    for (let failure = 1; failure <= 3; failure += 1) {
      const claim = await claimNextAiWorkflowJob({
        workerInstanceId: `retry-worker-${failure}`,
        workerBuildHash: String(failure).repeat(64),
        workflowInstanceId: retryCase.workflowInstanceId,
      });
      assert.ok(claim);
      const result = await failAiWorkflowJob(claim.lease, {
        failureCode: 'MOCK_HANDLER_TRANSIENT',
      });
      assert.equal(result.retryFailureCount, failure);
      assert.equal(result.state, failure < 3 ? 'RETRY_WAIT' : 'FAILED_TERMINAL');
      if (failure < 3) {
        await makeRetryImmediatelyAvailableForTest(claim.runtimeId);
        await assertRuntimeReadyForRetryClaim(claim.runtimeId);
      }
    }
    const retryRuntime = await db().aiWorkflowJobRuntime.findUniqueOrThrow({
      where: { jobId: retryCase.job.id },
    });
    assert.equal(retryRuntime.retryFailureCount, 3);
    assert.equal(retryRuntime.state, 'FAILED_TERMINAL');

    await admitAiWorkflowJobOutbox({ workflowInstanceId: terminalCase.workflowInstanceId });
    const terminalClaim = await claimNextAiWorkflowJob({
      workerInstanceId: 'terminal-worker',
      workerBuildHash: '7'.repeat(64),
      workflowInstanceId: terminalCase.workflowInstanceId,
    });
    assert.ok(terminalClaim);
    const terminal = await failAiWorkflowJob(terminalClaim.lease, {
      failureCode: 'CAPABILITY_DENIED',
    });
    assert.equal(terminal.state, 'FAILED_TERMINAL');
    assert.equal(terminal.retryFailureCount, 0);

    await admitAiWorkflowJobOutbox({ workflowInstanceId: surrenderCase.workflowInstanceId });
    const surrenderClaim = await claimNextAiWorkflowJob({
      workerInstanceId: 'surrender-worker',
      workerBuildHash: '8'.repeat(64),
      workflowInstanceId: surrenderCase.workflowInstanceId,
    });
    assert.ok(surrenderClaim);
    await surrenderAiWorkflowJobLease(surrenderClaim.lease);
    const surrendered = await db().aiWorkflowJobRuntime.findUniqueOrThrow({
      where: { id: surrenderClaim.runtimeId },
    });
    assert.equal(surrendered.state, 'RETRY_WAIT');
    assert.equal(surrendered.retryFailureCount, 0);
    const attempt = await db().aiWorkflowJobAttempt.findFirstOrThrow({
      where: { runtimeId: surrenderClaim.runtimeId },
    });
    assert.equal(attempt.outcome, 'SURRENDERED');
    assert.equal(attempt.retryBudgetConsumed, false);
  });
});

test('supersession terminalizza AVAILABLE e RETRY_WAIT fuori fase anche con gate chiusi', { skip: !runDbTests }, async () => {
  process.env.AI_ORCHESTRATOR_WORKER_ENABLED = '1';
  const availableCase = await createDataValidationRuntimeCase();
  const retryCase = await createDataValidationRuntimeCase();
  let retryRuntimeId = '';
  await withTemporaryDispatchFixture(async () => {
    await admitAiWorkflowJobOutbox({ workflowInstanceId: availableCase.workflowInstanceId });
    await admitAiWorkflowJobOutbox({ workflowInstanceId: retryCase.workflowInstanceId });
    const retryClaim = await claimNextAiWorkflowJob({
      workerInstanceId: 'supersession-retry-worker',
      workerBuildHash: 'a'.repeat(64),
      workflowInstanceId: retryCase.workflowInstanceId,
    });
    assert.ok(retryClaim);
    retryRuntimeId = retryClaim.runtimeId;
    await failAiWorkflowJob(retryClaim.lease, { failureCode: 'WORKER_TRANSIENT' });
  });
  const availableJobBefore = await db().aiWorkflowJob.findUniqueOrThrow({
    where: { id: availableCase.job.id },
  });
  const availableOutboxBefore = await db().aiWorkflowJobOutboxEvent.findUniqueOrThrow({
    where: { id: availableCase.outbox.id },
  });
  for (const workflowInstanceId of [availableCase.workflowInstanceId, retryCase.workflowInstanceId]) {
    await applyOk(workflowInstanceId, 'WF-005', agent());
    await applyOk(workflowInstanceId, 'WF-006', agent());
    await applyOk(workflowInstanceId, 'WF-007', agent());
    await applyOk(workflowInstanceId, 'WF-010', human(runnerId));
  }
  const aiRunBefore = await db().aiRun.count();
  const ledgerBefore = await db().aiWorkflowTransition.count();
  await setWorkerRuntimeGates(true, false);
  assert.equal(await supersedeIneligibleAiWorkflowJobRuntimes({
    workflowInstanceId: availableCase.workflowInstanceId,
  }), 1);
  assert.equal(await supersedeIneligibleAiWorkflowJobRuntimes({
    workflowInstanceId: retryCase.workflowInstanceId,
  }), 1);
  assert.equal(await supersedeIneligibleAiWorkflowJobRuntimes({
    workflowInstanceId: retryCase.workflowInstanceId,
  }), 0);
  const [availableRuntime, retryRuntime] = await Promise.all([
    db().aiWorkflowJobRuntime.findUniqueOrThrow({ where: { jobId: availableCase.job.id } }),
    db().aiWorkflowJobRuntime.findUniqueOrThrow({ where: { id: retryRuntimeId } }),
  ]);
  assert.equal(availableRuntime.state, 'SUPERSEDED');
  assert.equal(retryRuntime.state, 'SUPERSEDED');
  assert.equal(availableRuntime.terminalReasonCode, 'PHASE_SUPERSEDED');
  assert.equal(retryRuntime.terminalReasonCode, 'PHASE_SUPERSEDED');
  assert.equal(await db().aiWorkflowJobRuntimeEvent.count({
    where: { runtimeId: availableRuntime.id, eventType: 'SUPERSEDED_IDLE' },
  }), 1);
  assert.equal(await db().aiWorkflowJobRuntimeEvent.count({
    where: { runtimeId: retryRuntime.id, eventType: 'SUPERSEDED_IDLE' },
  }), 1);
  assert.deepEqual(
    await db().aiWorkflowJob.findUniqueOrThrow({ where: { id: availableCase.job.id } }),
    availableJobBefore,
  );
  assert.deepEqual(
    await db().aiWorkflowJobOutboxEvent.findUniqueOrThrow({ where: { id: availableCase.outbox.id } }),
    availableOutboxBefore,
  );
  assert.equal(await db().aiRun.count(), aiRunBefore);
  assert.equal(await db().aiWorkflowTransition.count(), ledgerBefore);
});

test('HUMAN_APPROVAL blocca admission, claim, heartbeat e successo e supersede gli idle', { skip: !runDbTests }, async () => {
  process.env.AI_ORCHESTRATOR_WORKER_ENABLED = '1';
  await setWorkerRuntimeGates(true, false);
  const created = await createCase();
  const id = created.value.workflowInstanceId;
  await advanceToIndependentReview(id);
  const claim = await withTemporaryDispatchFixture(async () => {
    assert.equal(await admitAiWorkflowJobOutbox({ workflowInstanceId: id }), 4);
    const claimed = await claimNextAiWorkflowJob({
      workerInstanceId: 'human-boundary-worker',
      workerBuildHash: 'b'.repeat(64),
      workflowInstanceId: id,
    });
    assert.ok(claimed);
    return claimed;
  });
  await applyOk(id, 'WF-014', system());
  await applyOk(id, 'WF-017', human(reviewerId));
  await withTemporaryDispatchFixture(async () => {
    assert.equal((await db().aiWorkflowInstance.findUniqueOrThrow({ where: { id } })).currentState, 'HUMAN_APPROVAL');
    assert.equal(await admitAiWorkflowJobOutbox({ workflowInstanceId: id }), 0);
    assert.equal(await claimNextAiWorkflowJob({
      workerInstanceId: 'human-boundary-second-worker',
      workerBuildHash: 'c'.repeat(64),
      workflowInstanceId: id,
    }), null);
    await assert.rejects(heartbeatAiWorkflowJobLease(claim.lease));
    const completion = await completeAiWorkflowJob(claim.lease, { resultDraft: createSyntheticAiResultDraft(claim.jobCode) });
    assert.deepEqual(completion, { replay: false, state: 'SUPERSEDED' });
  });
  await setWorkerRuntimeGates(true, false);
  assert.equal(await supersedeIneligibleAiWorkflowJobRuntimes({
    workflowInstanceId: id,
    batchSize: 25,
  }), 3);
  const runtimes = await db().aiWorkflowJobRuntime.findMany({ where: { workflowInstanceId: id } });
  assert.equal(runtimes.length, 4);
  assert.ok(runtimes.every((runtime) => (
    runtime.state === 'SUPERSEDED'
    && runtime.terminalReasonCode === 'HUMAN_APPROVAL_REACHED'
  )));
  assert.equal(await db().aiRun.count({ where: { id: { startsWith: id } } }), 0);
});

test('recovery dopo HUMAN_APPROVAL conserva la causa umana esatta senza retry', { skip: !runDbTests }, async () => {
  process.env.AI_ORCHESTRATOR_WORKER_ENABLED = '1';
  await setWorkerRuntimeGates(true, false);
  const created = await createCase();
  const id = created.value.workflowInstanceId;
  await advanceToIndependentReview(id);
  const claim = await withTemporaryDispatchFixture(async () => {
    await admitAiWorkflowJobOutbox({ workflowInstanceId: id });
    const claimed = await claimNextAiWorkflowJob({
      workerInstanceId: 'human-recovery-worker',
      workerBuildHash: '1'.repeat(64),
      workflowInstanceId: id,
    });
    assert.ok(claimed);
    return claimed;
  });
  await applyOk(id, 'WF-014', system());
  await applyOk(id, 'WF-017', human(reviewerId));
  await expireLeaseForTest(claim.runtimeId);
  assert.equal(await recoverExpiredAiWorkflowJobLeases({ batchSize: 1 }), 1);
  const [runtime, attempt, event] = await Promise.all([
    db().aiWorkflowJobRuntime.findUniqueOrThrow({ where: { id: claim.runtimeId } }),
    db().aiWorkflowJobAttempt.findFirstOrThrow({ where: { runtimeId: claim.runtimeId } }),
    db().aiWorkflowJobRuntimeEvent.findFirstOrThrow({
      where: { runtimeId: claim.runtimeId, eventType: 'LEASE_RECOVERED' },
    }),
  ]);
  assert.equal(runtime.state, 'SUPERSEDED');
  assert.equal(runtime.terminalReasonCode, 'HUMAN_APPROVAL_REACHED');
  assert.equal(runtime.retryFailureCount, 0);
  assert.equal(attempt.outcome, 'SUPERSEDED');
  assert.equal(attempt.failureCode, 'HUMAN_APPROVAL_REACHED');
  assert.equal(attempt.retryBudgetConsumed, false);
  assert.equal(event.reasonCode, 'HUMAN_APPROVAL_REACHED');
});
