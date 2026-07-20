import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Prisma, PrismaClient } from '@prisma/client';
import { canonicalJson, canonicalSha256, sha256 } from '../../src/lib/canonical-json';
import {
  FAI_AUDIT_WORKFLOW_DEFINITION_HASH,
  getAuditWorkflowTransition,
} from '../../src/lib/ai-orchestrator/audit-workflow-v1-1';
import { FAI_AUDIT_JOB_CODES } from '../../src/lib/ai-orchestrator/job-catalog-v1';
import {
  AI_RESULT_LIMITS,
  createSyntheticAiResultDraft,
  getAiResultContract,
  validateAiResultJsonValue,
  validateAndHashAiResultDraft,
  type AiResultArtifactDraft,
  type AiResultProvenance,
} from '../../src/lib/ai-orchestrator/result-artifact-contract-v1';
import {
  admitAiWorkflowJobOutbox,
  AiOrchestratorLeaseLostError,
  claimNextAiWorkflowJob,
  completeAiWorkflowJob,
  surrenderAiWorkflowJobLease,
  type ClaimedAiWorkflowJob,
} from '../../src/lib/ai-orchestrator/worker-runtime';
import {
  applyAuditWorkflowTransition,
  createAuditWorkflowInstance,
  type ApplyAuditWorkflowTransitionInput,
  type AuditWorkflowActor,
} from '../../src/lib/ai-orchestrator/workflow-service';

const migrationPath = 'prisma/migrations/20260719120000_ai_orchestrator_result_artifact_contract_foundation_v1/migration.sql';
const dbTestsRequested = process.env.RUN_DB_TESTS === '1';
const destructiveDbTestsConfirmed = process.env.AI_ORCHESTRATOR_DB_TESTS_CONFIRMED === '1';
const runDbTests = dbTestsRequested && destructiveDbTestsConfirmed;
const prisma = runDbTests ? new PrismaClient() : null;
const runId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const safeEnv = { ...process.env, AI_EXTERNAL_PROVIDERS_ENABLED: 'false' };
const originalWorkerGate = process.env.AI_ORCHESTRATOR_WORKER_ENABLED;

let adminId = '';
let dispatchFixtureOpen = false;
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

function assertDedicatedTestDatabase(databaseUrl: string | undefined) {
  if (!databaseUrl) throw new Error('DATABASE_URL obbligatorio per i test DB AI Orchestrator.');
  const parsed = new URL(databaseUrl);
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
if (runDbTests) assertDedicatedTestDatabase(process.env.DATABASE_URL);

async function dispatchConstraintState() {
  const rows = await db().$queryRaw<Array<{ present: boolean; validated: boolean }>>(Prisma.sql`
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

async function setCapabilityGates(enabledJobCodes: readonly string[]) {
  const requested = new Set(enabledJobCodes);
  if (requested.size > 0 && !dispatchFixtureOpen) {
    throw new Error('Capability positive consentite soltanto nella fixture dispatch confermata.');
  }
  const settings = await db().aiOrchestratorWorkerCapabilitySetting.findMany({
    select: { jobCode: true, enabled: true },
  });
  for (const setting of settings) {
    const enabled = requested.has(setting.jobCode);
    if (setting.enabled === enabled) continue;
    await db().aiOrchestratorWorkerCapabilitySetting.update({
      where: { jobCode: setting.jobCode },
      data: { enabled, version: { increment: 1 } },
    });
  }
}

async function withTemporaryDispatchFixture<T>(
  enabledJobCodes: readonly string[],
  callback: () => Promise<T>,
) {
  if (!runDbTests || dispatchFixtureOpen) throw new Error('Fixture dispatch non disponibile.');
  await restorePhysicalDispatchBarrier();
  await db().$executeRawUnsafe(
    'ALTER TABLE "AiOrchestratorSetting" DROP CONSTRAINT "AiOrchestratorSetting_dispatch_disabled_check"',
  );
  dispatchFixtureOpen = true;
  try {
    await db().aiOrchestratorSetting.update({
      where: { id: 'global' },
      data: {
        stateMachineEnabled: true,
        dispatchEnabled: true,
        syntheticDataOnly: true,
        provider: 'mock',
      },
    });
    await db().aiControlSetting.update({
      where: { id: 'global' },
      data: { externalProvidersEnabled: false },
    });
    await setCapabilityGates(enabledJobCodes);
    return await callback();
  } finally {
    try {
      await setCapabilityGates([]);
    } finally {
      dispatchFixtureOpen = false;
      await restorePhysicalDispatchBarrier();
    }
  }
}

const human = (): Extract<AuditWorkflowActor, { kind: 'HUMAN' }> => ({
  kind: 'HUMAN',
  userId: adminId,
});

async function transitionInput(
  workflowInstanceId: string,
  transitionCode: string,
): Promise<ApplyAuditWorkflowTransitionInput> {
  const definition = getAuditWorkflowTransition(transitionCode);
  assert.ok(definition, `Transizione ${transitionCode} non trovata.`);
  const instance = await db().aiWorkflowInstance.findUniqueOrThrow({
    where: { id: workflowInstanceId },
  });
  assert.equal(instance.currentState, definition.from);
  return {
    workflowInstanceId,
    transitionCode,
    idempotencyKey: randomUUID(),
    correlationId: randomUUID(),
    expectedDefinitionHash: FAI_AUDIT_WORKFLOW_DEFINITION_HASH,
    expectedState: definition.from,
    expectedStateVersion: instance.stateVersion,
    actor: human(),
    gateResults: { [definition.gate]: 'PASS' },
    preconditions: Object.fromEntries(definition.preconditions.map((item) => [item, true])),
    manualReleaseConfirmed: definition.manualReleaseOnly ? true : undefined,
    reasonCode: definition.reasonCodeRequired ? 'SYNTHETIC_RESULT_DB_TEST' : undefined,
  };
}

async function applyTransition(workflowInstanceId: string, transitionCode: string) {
  const result = await applyAuditWorkflowTransition(
    db(),
    await transitionInput(workflowInstanceId, transitionCode),
    { env: safeEnv },
  );
  if (!result.ok) assert.fail(`${result.code}: ${result.message}`);
}

async function createDataValidationCase() {
  const created = await createAuditWorkflowInstance(db(), {
    creationKey: randomUUID(),
    expectedDefinitionHash: FAI_AUDIT_WORKFLOW_DEFINITION_HASH,
    actor: human(),
  }, { env: safeEnv });
  if (!created.ok) assert.fail(`${created.code}: ${created.message}`);
  const workflowInstanceId = created.value.workflowInstanceId;
  for (const transitionCode of ['WF-001', 'WF-002', 'WF-003', 'WF-004']) {
    await applyTransition(workflowInstanceId, transitionCode);
  }
  const jobs = await db().aiWorkflowJob.findMany({
    where: { workflowInstanceId },
    orderBy: [{ availableAt: 'asc' }, { id: 'asc' }],
  });
  assert.equal(jobs.length, 1, 'WF-004 deve pianificare un solo DOCUMENT_INGESTION.');
  assert.equal(jobs[0].jobCode, 'DOCUMENT_INGESTION');
  return { workflowInstanceId, job: jobs[0] };
}

function mutateValidMonoArtifactDraft(draft: AiResultArtifactDraft) {
  const changed = structuredClone(draft);
  const artifactPayload = changed.artifacts[0]?.payload as Record<string, unknown>;
  assert.equal(typeof artifactPayload.summary, 'string');
  artifactPayload.summary = `${artifactPayload.summary} changed`;
  const resultPayload = changed.resultPayload as Record<string, unknown>;
  assert.equal(typeof resultPayload.summary, 'string');
  resultPayload.summary = artifactPayload.summary;
  return changed;
}

function buildProvenance(
  claim: ClaimedAiWorkflowJob,
  runtime: {
    runtimePolicyHash: string;
    capabilityCode: string;
    capabilityVersion: string;
    capabilityHash: string;
    handlerCode: string;
    handlerVersion: string;
  },
  attempt: { id: string; workerInstanceId: string; workerBuildHash: string },
): AiResultProvenance {
  return {
    runtimeId: claim.runtimeId,
    jobId: claim.jobId,
    attemptId: attempt.id,
    attemptSequence: claim.attemptSequence,
    fencingToken: claim.fencingToken.toString(),
    workerInstanceId: attempt.workerInstanceId,
    workerBuildHash: attempt.workerBuildHash,
    runtimePolicyHash: runtime.runtimePolicyHash,
    capabilityCode: runtime.capabilityCode,
    capabilityVersion: runtime.capabilityVersion as '1.0',
    capabilityHash: runtime.capabilityHash,
    handlerCode: runtime.handlerCode,
    handlerVersion: runtime.handlerVersion as '1.0',
    jobPayloadHash: claim.jobPayloadHash,
    workflowInstanceId: claim.workflowInstanceId,
    workflowDefinitionHash: claim.workflowDefinitionHash,
    phaseCode: claim.phaseCode,
    phaseEntrySequence: claim.phaseEntrySequence,
    correctionCycle: claim.correctionCycle,
    executorAgentId: claim.executorAgentId,
    executorAgentCode: claim.executorAgentCode,
    executorAgentConfigVersion: claim.executorAgentConfigVersion,
    executorAgentConfigHash: claim.executorAgentConfigHash,
    provider: 'mock',
    dataMode: 'synthetic',
  };
}

class RollbackSentinel extends Error {}

async function expectDatabaseRejection(
  operation: (tx: Prisma.TransactionClient) => Promise<void>,
  expected: RegExp,
) {
  const sentinel = new RollbackSentinel('ROLLBACK_IF_DATABASE_ACCEPTED_INVALID_RESULT');
  try {
    await db().$transaction(async (tx) => {
      await operation(tx);
      await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
      throw sentinel;
    });
    assert.fail('La transazione negativa avrebbe dovuto essere rifiutata.');
  } catch (error) {
    if (error === sentinel || error instanceof RollbackSentinel) {
      assert.fail('PostgreSQL ha accettato un bypass PR77 non valido.');
    }
    assert.match(String(error), expected);
  }
}

async function insertRawResult(
  tx: Prisma.TransactionClient,
  claim: ClaimedAiWorkflowJob,
  resultHashOverride: string,
) {
  const [runtime, attempt] = await Promise.all([
    tx.aiWorkflowJobRuntime.findUniqueOrThrow({ where: { id: claim.runtimeId } }),
    tx.aiWorkflowJobAttempt.findFirstOrThrow({
      where: { runtimeId: claim.runtimeId, attemptSequence: claim.attemptSequence },
    }),
  ]);
  const draft = createSyntheticAiResultDraft(claim.jobCode);
  const hashed = validateAndHashAiResultDraft(
    claim.jobCode,
    draft,
    buildProvenance(claim, runtime, attempt),
  );
  const retainUntil = hashed.retention.retainUntil
    ? new Date(hashed.retention.retainUntil)
    : null;
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "AiWorkflowJobResult" (
      "id", "runtimeId", "jobId", "attemptId", "attemptSequence", "fencingToken",
      "workerInstanceId", "workerBuildHash", "runtimePolicyHash", "capabilityCode",
      "capabilityVersion", "capabilityHash", "handlerCode", "handlerVersion",
      "resultContractCode", "resultContractVersion", "resultContractHash", "jobPayloadHash",
      "workflowInstanceId", "workflowDefinitionHash", "phaseCode", "phaseEntrySequence",
      "correctionCycle", "executorAgentId", "executorAgentCode", "executorAgentConfigVersion",
      "executorAgentConfigHash", "provider", "dataMode", "payload", "payloadHash",
      "manifestHash", "resultHash", "artifactCount", "totalPayloadBytes",
      "retentionPolicyCode", "retentionPolicyVersion", "retentionPolicyHash",
      "retentionClass", "retainUntil"
    ) VALUES (
      ${randomUUID()}, ${claim.runtimeId}, ${claim.jobId}, ${attempt.id},
      ${claim.attemptSequence}, ${claim.fencingToken}, ${attempt.workerInstanceId},
      ${attempt.workerBuildHash}, ${runtime.runtimePolicyHash}, ${runtime.capabilityCode},
      ${runtime.capabilityVersion}, ${runtime.capabilityHash}, ${runtime.handlerCode},
      ${runtime.handlerVersion}, ${hashed.contract.resultContractCode},
      ${hashed.contract.resultContractVersion}, ${hashed.resultContractHash}, ${claim.jobPayloadHash},
      ${claim.workflowInstanceId}, ${claim.workflowDefinitionHash}, ${claim.phaseCode},
      ${claim.phaseEntrySequence}, ${claim.correctionCycle}, ${claim.executorAgentId},
      ${claim.executorAgentCode}, ${claim.executorAgentConfigVersion},
      ${claim.executorAgentConfigHash}, 'mock', 'synthetic',
      CAST(${JSON.stringify(hashed.resultPayload)} AS JSONB), ${hashed.resultPayloadHash},
      ${hashed.manifestHash}, ${resultHashOverride}, ${hashed.artifacts.length},
      ${hashed.totalPayloadBytes}, ${hashed.retention.policyCode},
      ${hashed.retention.policyVersion}, ${hashed.retention.retentionPolicyHash},
      ${hashed.retention.retentionClass}, ${retainUntil}
    )
  `);
}

function assertCorrectionSupersessionPolicy(sql: string) {
  const compact = sql.replace(/\s+/g, ' ');
  assert.match(
    compact,
    /result_row\."correctionCycle"\s*=\s*1\s+AND\s+source_row\."artifactType"\s*=\s*'REPORT_DRAFT'/i,
  );
  assert.match(
    compact,
    /result_row\."correctionCycle"\s*>\s*1\s+AND\s+source_row\."artifactType"\s*=\s*'CORRECTED_REPORT'/i,
  );
  assert.match(
    compact,
    /NEW\."artifactType"\s+IS\s+DISTINCT\s+FROM\s+'CORRECTED_REPORT'/i,
  );
  assert.match(
    compact,
    /source_result\."correctionCycle"\s+IS\s+DISTINCT\s+FROM\s+result_row\."correctionCycle"\s*-\s*1/i,
  );
}

test('la migration PR77 dichiara hash DB, aggregati differiti, lineage/supersession e append-only', () => {
  const sql = readFileSync(migrationPath, 'utf8');
  assert.match(sql, /^--[^\n]+\n\s*BEGIN;/);
  assert.match(sql, /COMMIT;\s*$/);
  assert.match(sql, /ai_result_artifact_canonical_hash/);
  assert.match(sql, /canonicalize_ai_result_float8_number_v1/);
  assert.match(sql, /canonicalize_ai_result_jsonb_v1/);
  assert.match(sql, /expected_ai_workflow_result_contract_hash/);
  assert.match(sql, /expected_ai_workflow_artifact_schema_hash/);
  assert.match(sql, /assert_ai_workflow_result_json_policy/);
  assert.match(sql, /assert_ai_workflow_artifact_payload_shape/);
  assert.match(sql, /assert_ai_workflow_result_payload_shape/);
  assert.match(sql, /table_row\.relnamespace = TO_REGNAMESPACE\(CURRENT_SCHEMA\(\)\)/);
  assert.match(sql, /node_count > 512/);
  assert.match(sql, /maximum_depth > 8/);
  assert.match(sql, /maximum_string_bytes > 4096/);
  assert.match(sql, /9007199254740991/);
  assert.match(sql, /artifact\."payload" IS DISTINCT FROM result_row\."payload"/);
  assert.match(sql, /artifactSchemaHash[^;]+mismatch/is);
  assert.match(sql, /artifactHash[^;]+mismatch/is);
  assert.match(sql, /manifestHash[^;]+mismatch/is);
  assert.match(sql, /resultHash[^;]+mismatch/is);
  assert.match(
    sql,
    /event\."payload"\s*=\s*JSONB_BUILD_OBJECT\([^;]+'schemaVersion'\s*,\s*1[^;]+'runtimePolicyHash'/is,
  );
  assert.match(sql, /retentionPolicyHash[^;]+mismatch/is);
  assert.match(sql, /totalPayloadBytes[^;]+mismatch/is);
  assert.match(sql, /DEFERRABLE INITIALLY DEFERRED/g);
  assert.match(sql, /supersedesArtifactId/is);
  assertCorrectionSupersessionPolicy(sql);
  assert.match(sql, /terminalAt[^;]+claimedAt/is);
  assert.match(sql, /cross-workflow/i);
  assert.match(sql, /self\/future|self.*future/is);
  assert.match(
    sql,
    /CREATE UNIQUE INDEX "AiWorkflowJobSourceArtifact_resultId_sourceArtifactId_key" ON "AiWorkflowJobSourceArtifact"\("resultId", "sourceArtifactId"\);/,
  );
  assert.doesNotMatch(sql, /AiWorkflowJobSourceArtifact_resultId_sourceArtifactId_role_key/);
  for (const table of [
    'AiWorkflowJobResult',
    'AiWorkflowJobArtifact',
    'AiWorkflowJobSourceArtifact',
  ]) {
    assert.match(sql, new RegExp(`CREATE TRIGGER "${table}_[^"]+" BEFORE UPDATE`, 'i'));
    assert.match(sql, new RegExp(`CREATE TRIGGER "${table}_[^"]+" BEFORE DELETE`, 'i'));
  }
  assert.doesNotMatch(
    sql,
    /CREATE\s+UNIQUE\s+INDEX\s+"[^"]+"\s+ON\s+"AiWorkflowJobArtifact"\s*\(\s*"artifactHash"\s*\)/i,
  );
});

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
  await db().aiControlSetting.update({
    where: { id: 'global' },
    data: { externalProvidersEnabled: false },
  });
  const admin = await db().user.create({
    data: {
      email: `result-contract-${runId}@example.test`,
      name: `Result contract ${runId}`,
      passwordHash: 'not-a-real-login-hash',
      role: 'admin',
      active: true,
    },
  });
  adminId = admin.id;
  process.env.AI_ORCHESTRATOR_WORKER_ENABLED = '1';
});

test.after(async () => {
  if (!runDbTests || !prisma) return;
  dispatchFixtureOpen = false;
  try {
    await setCapabilityGates([]);
  } finally {
    await restorePhysicalDispatchBarrier();
  }
  if (migrationDefaults) {
    await db().aiOrchestratorSetting.update({ where: { id: 'global' }, data: migrationDefaults });
  }
  await db().aiControlSetting.updateMany({
    where: { id: 'global' },
    data: { externalProvidersEnabled: false },
  });
  if (originalWorkerGate === undefined) delete process.env.AI_ORCHESTRATOR_WORKER_ENABLED;
  else process.env.AI_ORCHESTRATOR_WORKER_ENABLED = originalWorkerGate;
  await prisma.$disconnect();
});

test('PostgreSQL espone trigger e constraint trigger PR77 nel namespace corrente', { skip: !runDbTests }, async () => {
  const triggers = await db().$queryRaw<Array<{
    tableName: string;
    triggerName: string;
    constraintTrigger: boolean;
    deferrable: boolean;
    initiallyDeferred: boolean;
  }>>(Prisma.sql`
    SELECT
      table_row.relname AS "tableName",
      trigger_row.tgname AS "triggerName",
      trigger_row.tgconstraint <> 0 AS "constraintTrigger",
      COALESCE(constraint_row.condeferrable, false) AS "deferrable",
      COALESCE(constraint_row.condeferred, false) AS "initiallyDeferred"
    FROM pg_trigger trigger_row
    JOIN pg_class table_row ON table_row.oid = trigger_row.tgrelid
    LEFT JOIN pg_constraint constraint_row ON constraint_row.oid = trigger_row.tgconstraint
    WHERE NOT trigger_row.tgisinternal
      AND table_row.relnamespace = TO_REGNAMESPACE(CURRENT_SCHEMA())
      AND table_row.relname IN (
        'AiWorkflowJobResult',
        'AiWorkflowJobArtifact',
        'AiWorkflowJobSourceArtifact'
      )
  `);
  for (const tableName of [
    'AiWorkflowJobResult',
    'AiWorkflowJobArtifact',
    'AiWorkflowJobSourceArtifact',
  ]) {
    const tableTriggers = triggers.filter((trigger) => trigger.tableName === tableName);
    assert.ok(tableTriggers.some((trigger) => /no_update/.test(trigger.triggerName)));
    assert.ok(tableTriggers.some((trigger) => /no_delete/.test(trigger.triggerName)));
    assert.ok(tableTriggers.some((trigger) => (
      trigger.constraintTrigger && trigger.deferrable && trigger.initiallyDeferred
    )));
  }

  const functionDefinitions = await db().$queryRaw<Array<{ definition: string }>>(Prisma.sql`
    SELECT PG_GET_FUNCTIONDEF(proc_row.oid) AS "definition"
    FROM pg_proc proc_row
    WHERE proc_row.pronamespace = TO_REGNAMESPACE(CURRENT_SCHEMA())
      AND proc_row.proname = 'validate_ai_workflow_job_artifact_insert'
  `);
  assert.equal(functionDefinitions.length, 1);
  assertCorrectionSupersessionPolicy(functionDefinitions[0].definition);

  const sourceIndexes = await db().$queryRaw<Array<{ indexName: string; indexDefinition: string }>>(Prisma.sql`
    SELECT indexname AS "indexName", indexdef AS "indexDefinition"
    FROM pg_indexes
    WHERE schemaname = CURRENT_SCHEMA()
      AND tablename = 'AiWorkflowJobSourceArtifact'
  `);
  assert.ok(sourceIndexes.some((index) => (
    index.indexName === 'AiWorkflowJobSourceArtifact_resultId_sourceArtifactId_key'
    && /UNIQUE INDEX[^]+\("resultId", "sourceArtifactId"\)$/i.test(index.indexDefinition)
  )));
  assert.ok(sourceIndexes.every((index) => !/\("resultId", "sourceArtifactId", "role"\)$/i.test(
    index.indexDefinition,
  )));
});

test('PostgreSQL rispecchia i digest TypeScript e rifiuta i bypass della policy JSON', { skip: !runDbTests }, async () => {
  const artifactSchemas = new Map<string, string>();
  for (const jobCode of FAI_AUDIT_JOB_CODES) {
    const contract = getAiResultContract(jobCode);
    assert.ok(contract);
    const draft = createSyntheticAiResultDraft(jobCode);
    const resultRows = await db().$queryRaw<Array<{ hash: string }>>(Prisma.sql`
      SELECT "expected_ai_workflow_result_contract_hash"(${jobCode}) AS "hash"
    `);
    assert.equal(resultRows[0]?.hash, contract.resultContractHash);
    await db().$queryRaw(Prisma.sql`
      SELECT "assert_ai_workflow_result_payload_shape"(
        ${jobCode},
        CAST(${JSON.stringify(draft.resultPayload)} AS JSONB)
      )
    `);
    for (const artifactType of contract.requiredArtifactTypes) {
      const schemaHash = contract.artifactSchemas[artifactType]?.artifactSchemaHash;
      assert.ok(schemaHash);
      artifactSchemas.set(artifactType, schemaHash);
      const artifact = draft.artifacts.find((candidate) => candidate.artifactType === artifactType);
      assert.ok(artifact);
      await db().$queryRaw(Prisma.sql`
        SELECT "assert_ai_workflow_artifact_payload_shape"(
          ${artifactType},
          CAST(${JSON.stringify(artifact.payload)} AS JSONB)
        )
      `);
    }
  }
  assert.equal(artifactSchemas.size, 14);
  for (const [artifactType, expectedHash] of artifactSchemas) {
    const schemaRows = await db().$queryRaw<Array<{ hash: string }>>(Prisma.sql`
      SELECT "expected_ai_workflow_artifact_schema_hash"(${artifactType}) AS "hash"
    `);
    assert.equal(schemaRows[0]?.hash, expectedHash);
  }

  const assertPolicyRejects = async (value: unknown, expected: RegExp) => {
    await assert.rejects(
      db().$queryRaw(Prisma.sql`
        SELECT "assert_ai_workflow_result_json_policy"(
          CAST(${JSON.stringify(value)} AS JSONB)
        )
      `),
      expected,
    );
  };

  let tooDeep: unknown = { synthetic: true, summary: 'synthetic' };
  for (let depth = 0; depth < 8; depth += 1) {
    tooDeep = { synthetic: true, summary: 'synthetic', nested: tooDeep };
  }
  await assertPolicyRejects(tooDeep, /depth|limit exceeded/i);
  await assertPolicyRejects(
    { synthetic: true, summary: 'synthetic', items: Array.from({ length: 511 }, () => null) },
    /node|limit exceeded/i,
  );
  await assertPolicyRejects(
    { synthetic: true, summary: 'x'.repeat(4097) },
    /string limit|limit exceeded/i,
  );
  await assertPolicyRejects(
    { synthetic: true, summary: 'https://example.test' },
    /forbidden content/i,
  );
  await assertPolicyRejects(
    { synthetic: true, summary: 'synthetic', value: 9007199254740992 },
    /safe range/i,
  );
  await assertPolicyRejects(
    { synthetic: false, summary: 'synthetic' },
    /explicitly synthetic/i,
  );
  await assert.rejects(
    db().$queryRaw(Prisma.sql`
      SELECT "assert_ai_workflow_artifact_payload_shape"(
        'DOCUMENT_MANIFEST',
        '{"synthetic":true}'::JSONB
      )
    `),
    /payload shape|schema/i,
  );
  await assert.rejects(
    db().$queryRaw(Prisma.sql`
      SELECT "assert_ai_workflow_artifact_payload_shape"(
        'DOCUMENT_MANIFEST',
        '{"synthetic":true,"summary":"synthetic","documentCount":1,"extra":"synthetic"}'::JSONB
      )
    `),
    /keys mismatch|schema/i,
  );

  const numericPayload = {
    synthetic: true,
    summary: 'synthetic',
    confidence: 1e-7,
    rating: 'synthetic rating',
  };
  const numericValidation = validateAiResultJsonValue(
    numericPayload,
    AI_RESULT_LIMITS.maxArtifactBytes,
  );
  const numericRows = await db().$queryRaw<Array<{
    canonical: string;
    payloadHash: string;
    payloadBytes: number;
  }>>(Prisma.sql`
    SELECT
      "canonicalize_ai_result_jsonb_v1"(CAST(${JSON.stringify(numericPayload)} AS JSONB)) AS "canonical",
      "ai_result_artifact_canonical_hash"(
        'ai.payload.v1',
        CAST(${JSON.stringify(numericPayload)} AS JSONB)
      ) AS "payloadHash",
      OCTET_LENGTH(CONVERT_TO(
        "canonicalize_ai_result_jsonb_v1"(CAST(${JSON.stringify(numericPayload)} AS JSONB)),
        'UTF8'
      ))::INTEGER AS "payloadBytes"
  `);
  assert.deepEqual(numericRows, [{
    canonical: numericValidation.canonical,
    payloadHash: numericValidation.payloadHash,
    payloadBytes: numericValidation.bytes,
  }]);

  const overPreciseRawJson = '{"synthetic":true,"summary":"synthetic","value":0.10000000000000000555}';
  await assert.rejects(
    db().$queryRaw(Prisma.sql`
      SELECT "assert_ai_workflow_result_json_policy"(
        CAST(${overPreciseRawJson} AS JSONB)
      )
    `),
    /exact canonical float8 decimal|numeric canonical/i,
  );

  const underflowRawJson = '{"synthetic":true,"summary":"synthetic","value":1e-1000}';
  await assert.rejects(
    db().$queryRaw(Prisma.sql`
      SELECT "assert_ai_workflow_result_json_policy"(
        CAST(${underflowRawJson} AS JSONB)
      )
    `),
    /exact canonical float8 decimal|numeric canonical|out of range/i,
  );
});

test('completion atomica, rollback, replay, conflitto, stale lease e persistenza canonica', { skip: !runDbTests }, async () => {
  const firstCase = await createDataValidationCase();
  const secondCase = await createDataValidationCase();
  const staleCase = await createDataValidationCase();
  const enabledJobCodes = [...new Set([
    firstCase.job.jobCode,
    secondCase.job.jobCode,
    staleCase.job.jobCode,
  ])];

  await withTemporaryDispatchFixture(enabledJobCodes, async () => {
    assert.equal(await admitAiWorkflowJobOutbox({ workflowInstanceId: firstCase.workflowInstanceId }), 1);
    assert.equal(await admitAiWorkflowJobOutbox({ workflowInstanceId: secondCase.workflowInstanceId }), 1);
    assert.equal(await admitAiWorkflowJobOutbox({ workflowInstanceId: staleCase.workflowInstanceId }), 1);

    const firstClaim = await claimNextAiWorkflowJob({
      workerInstanceId: `result-contract-${runId}`,
      workerBuildHash: 'a'.repeat(64),
      workflowInstanceId: firstCase.workflowInstanceId,
    });
    assert.ok(firstClaim);
    const invalidDraft = createSyntheticAiResultDraft(firstClaim.jobCode);
    invalidDraft.artifacts[0].payload = {};
    await assert.rejects(completeAiWorkflowJob(firstClaim.lease, { resultDraft: invalidDraft }));
    assert.equal(await db().aiWorkflowJobResult.count({ where: { runtimeId: firstClaim.runtimeId } }), 0);
    assert.equal((await db().aiWorkflowJobRuntime.findUniqueOrThrow({
      where: { id: firstClaim.runtimeId },
    })).state, 'LEASED');

    const firstDraft = createSyntheticAiResultDraft(firstClaim.jobCode);
    const firstCompletion = await completeAiWorkflowJob(firstClaim.lease, { resultDraft: firstDraft });
    assert.equal(firstCompletion.replay, false);
    assert.equal(firstCompletion.state, 'SUCCEEDED');
    const replay = await completeAiWorkflowJob(firstClaim.lease, { resultDraft: firstDraft });
    assert.deepEqual(replay, { ...firstCompletion, replay: true });
    await assert.rejects(
      completeAiWorkflowJob(firstClaim.lease, {
        resultDraft: mutateValidMonoArtifactDraft(firstDraft),
      }),
      AiOrchestratorLeaseLostError,
    );

    const secondClaim = await claimNextAiWorkflowJob({
      workerInstanceId: `result-contract-${runId}`,
      workerBuildHash: 'b'.repeat(64),
      workflowInstanceId: secondCase.workflowInstanceId,
    });
    assert.ok(secondClaim);
    const secondCompletion = await completeAiWorkflowJob(secondClaim.lease, {
      resultDraft: createSyntheticAiResultDraft(secondClaim.jobCode),
    });
    assert.equal(secondCompletion.state, 'SUCCEEDED');

    const staleClaim = await claimNextAiWorkflowJob({
      workerInstanceId: `result-contract-${runId}`,
      workerBuildHash: 'c'.repeat(64),
      workflowInstanceId: staleCase.workflowInstanceId,
    });
    assert.ok(staleClaim);
    await expectDatabaseRejection(
      (tx) => insertRawResult(tx, staleClaim, '0'.repeat(64)),
      /attempt|SUCCEEDED|resultHash|canonical|consistency/i,
    );
    assert.equal(await db().aiWorkflowJobResult.count({ where: { runtimeId: staleClaim.runtimeId } }), 0);
    await surrenderAiWorkflowJobLease(staleClaim.lease);
    await assert.rejects(
      completeAiWorkflowJob(staleClaim.lease, {
        resultDraft: createSyntheticAiResultDraft(staleClaim.jobCode),
      }),
      AiOrchestratorLeaseLostError,
    );

    const [firstResult, secondResult] = await Promise.all([
      db().aiWorkflowJobResult.findUniqueOrThrow({
        where: { resultHash: firstCompletion.resultHash },
        include: { artifacts: { orderBy: { ordinal: 'asc' } }, sourceReferences: true, job: true },
      }),
      db().aiWorkflowJobResult.findUniqueOrThrow({
        where: { resultHash: secondCompletion.resultHash },
        include: { artifacts: { orderBy: { ordinal: 'asc' } }, sourceReferences: true, job: true },
      }),
    ]);
    assert.equal(firstResult.artifacts.length, firstResult.artifactCount);
    assert.equal(secondResult.artifacts.length, secondResult.artifactCount);
    assert.equal(firstResult.sourceReferences.length, 0);
    assert.equal(secondResult.sourceReferences.length, 0);

    const firstContract = getAiResultContract(firstResult.job.jobCode);
    assert.ok(firstContract);
    assert.equal(firstResult.resultContractHash, firstContract.resultContractHash);
    for (const artifact of firstResult.artifacts) {
      assert.equal(
        artifact.artifactSchemaHash,
        firstContract.artifactSchemas[artifact.artifactType]?.artifactSchemaHash,
      );
    }

    const payloadHashRows = await db().$queryRaw<Array<{ payloadHash: string; payloadBytes: number }>>(Prisma.sql`
      SELECT
        "ai_result_artifact_canonical_hash"('ai.payload.v1', artifact."payload") AS "payloadHash",
        OCTET_LENGTH(CONVERT_TO("canonicalize_ai_result_jsonb_v1"(artifact."payload"), 'UTF8'))::INTEGER AS "payloadBytes"
      FROM "AiWorkflowJobArtifact" artifact
      WHERE artifact."id" = ${firstResult.artifacts[0].id}
    `);
    assert.deepEqual(payloadHashRows, [{
      payloadHash: firstResult.artifacts[0].payloadHash,
      payloadBytes: firstResult.artifacts[0].payloadBytes,
    }]);
    assert.equal(
      firstResult.artifacts[0].payloadHash,
      sha256(`ai.payload.v1\n${canonicalJson(firstResult.artifacts[0].payload)}`),
    );

    const retention = {
      policyCode: firstResult.retentionPolicyCode,
      policyVersion: firstResult.retentionPolicyVersion,
      retentionClass: firstResult.retentionClass,
      retainUntil: firstResult.retainUntil?.toISOString() ?? null,
      retentionPolicyHash: firstResult.retentionPolicyHash,
    };
    const manifestInput = {
      domain: 'ai.manifest.v1',
      artifactHashes: firstResult.artifacts.map((artifact) => artifact.artifactHash),
      sourceReferences: [],
      retention,
    };
    const sqlParity = await db().$queryRaw<Array<{ hash: string }>>(Prisma.sql`
      SELECT "ai_result_artifact_canonical_json_hash"(
        CAST(${JSON.stringify(manifestInput)} AS JSONB)
      ) AS "hash"
    `);
    assert.equal(sqlParity[0]?.hash, canonicalSha256(manifestInput));
    assert.equal(sqlParity[0]?.hash, firstResult.manifestHash);

    const firstArtifact = firstResult.artifacts[0];
    const secondArtifact = secondResult.artifacts[0];
    assert.equal(firstArtifact.artifactHash, secondArtifact.artifactHash);
    assert.notEqual(firstArtifact.id, secondArtifact.id);
    await expectDatabaseRejection(async (tx) => {
      await tx.$executeRaw(Prisma.sql`
        UPDATE "AiWorkflowJobResult" SET "payloadHash" = "payloadHash" WHERE "id" = ${firstResult.id}
      `);
    }, /append-only/i);
    await expectDatabaseRejection(async (tx) => {
      await tx.$executeRaw(Prisma.sql`
        UPDATE "AiWorkflowJobArtifact" SET "payloadBytes" = "payloadBytes" WHERE "id" = ${firstArtifact.id}
      `);
    }, /append-only/i);
    await expectDatabaseRejection(async (tx) => {
      await tx.$executeRaw(Prisma.sql`
        DELETE FROM "AiWorkflowJobArtifact" WHERE "id" = ${firstArtifact.id}
      `);
    }, /cannot be deleted/i);

    const insertSource = async (
      tx: Prisma.TransactionClient,
      input: {
        resultId: string;
        sourceArtifactId: string;
        sourceArtifactHash: string;
        role?: 'PRIMARY' | 'SUPPORTING' | 'SUPERSEDED';
        ordinal: number;
        createdAt: Date;
      },
    ) => {
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "AiWorkflowJobSourceArtifact" (
          "id", "resultId", "sourceArtifactId", "sourceArtifactHash", "role", "ordinal", "createdAt"
        ) VALUES (
          ${randomUUID()}, ${input.resultId}, ${input.sourceArtifactId},
          ${input.sourceArtifactHash}, ${input.role ?? 'PRIMARY'}, ${input.ordinal}, ${input.createdAt}
        )
      `);
    };

    await expectDatabaseRejection(
      (tx) => insertSource(tx, {
        resultId: firstResult.id,
        sourceArtifactId: firstArtifact.id,
        sourceArtifactHash: firstArtifact.artifactHash,
        ordinal: 0,
        createdAt: firstResult.createdAt,
      }),
      /self|causal|lineage/i,
    );
    await expectDatabaseRejection(
      (tx) => insertSource(tx, {
        resultId: secondResult.id,
        sourceArtifactId: firstArtifact.id,
        sourceArtifactHash: 'f'.repeat(64),
        ordinal: 0,
        createdAt: secondResult.createdAt,
      }),
      /source hash|hash mismatch/i,
    );
    await expectDatabaseRejection(
      (tx) => insertSource(tx, {
        resultId: secondResult.id,
        sourceArtifactId: firstArtifact.id,
        sourceArtifactHash: firstArtifact.artifactHash,
        ordinal: 0,
        createdAt: secondResult.createdAt,
      }),
      /cross-workflow|workflow/i,
    );
    await expectDatabaseRejection(async (tx) => {
      const shared = {
        resultId: secondResult.id,
        sourceArtifactId: firstArtifact.id,
        sourceArtifactHash: firstArtifact.artifactHash,
        createdAt: secondResult.createdAt,
      };
      await insertSource(tx, { ...shared, role: 'PRIMARY', ordinal: 0 });
      await insertSource(tx, { ...shared, role: 'SUPPORTING', ordinal: 1 });
    }, /resultId_sourceArtifactId_key|duplicate key|unique constraint/i);

    assert.equal(await db().aiWorkflowJobSourceArtifact.count({
      where: { resultId: { in: [firstResult.id, secondResult.id] } },
    }), 0);
  });
});
