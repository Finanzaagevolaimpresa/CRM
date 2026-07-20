import assert from 'node:assert/strict';
import test from 'node:test';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  FAI_AUDIT_WORKFLOW_DEFINITION_HASH,
  FAI_AUDIT_WORKFLOW_ID,
  FAI_AUDIT_WORKFLOW_VERSION,
  FAI_AUDIT_TRANSITIONS,
  getAuditWorkflowTransition,
} from '../../src/lib/ai-orchestrator/audit-workflow-v1-1';
import {
  FAI_AUDIT_JOB_CATALOG_HASH,
  FAI_AUDIT_JOB_CODES,
  FAI_AUDIT_JOB_PLANNING_RULES,
  getFaiAuditExecutorBinding,
  type FaiAuditJobCode,
} from '../../src/lib/ai-orchestrator/job-catalog-v1';
import {
  createFaiAuditJobPlan,
  type FaiAuditJobIntent,
} from '../../src/lib/ai-orchestrator/job-planner';
import {
  AI_ORCHESTRATOR_MOCK_HANDLER_DEFINITIONS,
  AI_ORCHESTRATOR_MOCK_HANDLER_INPUT_SCHEMA_CODE,
  AI_ORCHESTRATOR_MOCK_HANDLER_INPUT_SCHEMA_HASH,
  AI_ORCHESTRATOR_MOCK_HANDLER_INPUT_SCHEMA_IDENTITY,
  AI_ORCHESTRATOR_MOCK_HANDLER_INPUT_SCHEMA_VERSION,
  AI_ORCHESTRATOR_MOCK_HANDLER_LIMITS,
  AI_ORCHESTRATOR_MOCK_HANDLER_REGISTRY_CODE,
  AI_ORCHESTRATOR_MOCK_HANDLER_REGISTRY_HASH,
  AI_ORCHESTRATOR_MOCK_HANDLER_REGISTRY_VERSION,
  createAiOrchestratorMockHandlerInvocation,
  executeAiOrchestratorMockHandler,
} from '../../src/lib/ai-orchestrator/mock-handler-registry-v1';
import {
  AI_RESULT_CONTRACT_CATALOG_HASH,
  validateAiResultJsonValue,
} from '../../src/lib/ai-orchestrator/result-artifact-contract-v1';
import {
  AI_ORCHESTRATOR_WORKER_RUNTIME_POLICY_HASH,
} from '../../src/lib/ai-orchestrator/worker-runtime-policy-v1';

const dbTestsRequested = process.env.RUN_DB_TESTS === '1';
const destructiveDbTestsConfirmed = process.env.AI_ORCHESTRATOR_DB_TESTS_CONFIRMED === '1';
const runDbTests = dbTestsRequested && destructiveDbTestsConfirmed;
const prisma = runDbTests ? new PrismaClient() : null;

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

function canonicalIntents() {
  const intents = new Map<FaiAuditJobCode, FaiAuditJobIntent>();
  for (const rule of FAI_AUDIT_JOB_PLANNING_RULES) {
    const transition = getAuditWorkflowTransition(rule.sourceTransitionCode);
    assert.ok(transition);
    const phaseEntrySequence = transition.from === transition.to
      ? FAI_AUDIT_TRANSITIONS.filter((candidate) => (
        candidate.sequence < transition.sequence
        && candidate.from !== candidate.to
        && candidate.to === transition.to
      )).at(-1)?.sequence
      : transition.sequence;
    assert.ok(phaseEntrySequence);
    const plan = createFaiAuditJobPlan({
      workflowInstanceId: `synthetic-db-${rule.sourceTransitionCode}`,
      workflowCode: FAI_AUDIT_WORKFLOW_ID,
      workflowVersion: FAI_AUDIT_WORKFLOW_VERSION,
      workflowDefinitionHash: FAI_AUDIT_WORKFLOW_DEFINITION_HASH,
      phaseCode: transition.to,
      phaseEntrySequence,
      sourceCommandIdempotencyKey: `synthetic-db-idempotency-${rule.sourceTransitionCode}`,
      sourceTransitionCode: rule.sourceTransitionCode,
      sourceTransitionSequence: transition.sequence,
      sourceState: transition.from,
      sourceStateVersion: transition.sequence,
      targetState: transition.to,
      correlationId: `synthetic-db-correlation-${rule.sourceTransitionCode}`,
      correctionCycle: ['WF-015', 'WF-016'].includes(rule.sourceTransitionCode) ? 1 : 0,
      availableAt: '2026-01-01T00:00:00.000Z',
      resolvedExecutors: rule.jobCodes.map((jobCode) => {
        const executor = getFaiAuditExecutorBinding(jobCode);
        assert.ok(executor);
        return {
          jobCode,
          executorAgentId: `synthetic-db-agent-${jobCode.toLowerCase()}`,
          executorAgentCode: executor.executorAgentCode,
          executorAgentConfigVersion: executor.executorAgentConfigVersion,
          executorAgentConfigHash: executor.executorAgentConfigHash,
        };
      }),
    });
    for (const intent of plan.jobs) {
      if (!intents.has(intent.jobCode)) intents.set(intent.jobCode, intent);
    }
  }
  assert.equal(intents.size, FAI_AUDIT_JOB_CODES.length);
  return intents;
}

async function canonicalJsonHashInPostgres(value: unknown) {
  const rows = await db().$queryRaw<Array<{ hash: string }>>(Prisma.sql`
    SELECT "ai_result_artifact_canonical_json_hash"(
      CAST(${JSON.stringify(value)} AS JSONB)
    ) AS "hash"
  `);
  assert.equal(rows.length, 1);
  return rows[0].hash;
}

async function runtimeTableCounts() {
  const rows = await db().$queryRaw<Array<{
    jobs: bigint;
    outboxEvents: bigint;
    runtimes: bigint;
    attempts: bigint;
    receipts: bigint;
    runtimeEvents: bigint;
    results: bigint;
    artifacts: bigint;
    sources: bigint;
    aiRuns: bigint;
    aiOutputs: bigint;
  }>>(Prisma.sql`
    SELECT
      (SELECT COUNT(*) FROM "AiWorkflowJob") AS "jobs",
      (SELECT COUNT(*) FROM "AiWorkflowJobOutboxEvent") AS "outboxEvents",
      (SELECT COUNT(*) FROM "AiWorkflowJobRuntime") AS "runtimes",
      (SELECT COUNT(*) FROM "AiWorkflowJobAttempt") AS "attempts",
      (SELECT COUNT(*) FROM "AiWorkflowOutboxConsumption") AS "receipts",
      (SELECT COUNT(*) FROM "AiWorkflowJobRuntimeEvent") AS "runtimeEvents",
      (SELECT COUNT(*) FROM "AiWorkflowJobResult") AS "results",
      (SELECT COUNT(*) FROM "AiWorkflowJobArtifact") AS "artifacts",
      (SELECT COUNT(*) FROM "AiWorkflowJobSourceArtifact") AS "sources",
      (SELECT COUNT(*) FROM "AiRun") AS "aiRuns",
      (SELECT COUNT(*) FROM "AiOutput") AS "aiOutputs"
  `);
  assert.equal(rows.length, 1);
  return rows[0];
}

test.after(async () => {
  await prisma?.$disconnect();
});

test('PostgreSQL mirrors all 13 capability/handler identities and PR78 definition hashes', {
  skip: !runDbTests,
}, async () => {
  for (const definition of AI_ORCHESTRATOR_MOCK_HANDLER_DEFINITIONS) {
    const capabilityRows = await db().$queryRaw<Array<{
      capabilityCode: string;
      capabilityVersion: string;
      capabilityHash: string;
      handlerCode: string;
      jobDefinitionHash: string;
      executorAgentCode: string;
      executorAgentConfigVersion: number;
      executorAgentConfigHash: string;
      enabled: boolean;
    }>>(Prisma.sql`
      SELECT expected."capabilityCode",
             setting."capabilityVersion",
             expected."capabilityHash",
             expected."handlerCode",
             expected."jobDefinitionHash",
             expected."executorAgentCode",
             expected."executorAgentConfigVersion",
             expected."executorAgentConfigHash",
             setting."enabled"
      FROM "expected_ai_workflow_worker_capability"(${definition.jobCode}) expected
      JOIN "AiOrchestratorWorkerCapabilitySetting" setting
        ON setting."jobCode" = ${definition.jobCode}
    `);
    assert.deepEqual(capabilityRows, [{
      capabilityCode: definition.capabilityCode,
      capabilityVersion: definition.capabilityVersion,
      capabilityHash: definition.capabilityHash,
      handlerCode: definition.handlerCode,
      jobDefinitionHash: definition.jobDefinitionHash,
      executorAgentCode: definition.executorAgentCode,
      executorAgentConfigVersion: definition.executorAgentConfigVersion,
      executorAgentConfigHash: definition.executorAgentConfigHash,
      enabled: false,
    }]);

    const { definitionHash, ...identity } = definition;
    assert.equal(
      await canonicalJsonHashInPostgres({
        domain: 'ai.mockHandlerDefinition.v1',
        ...identity,
      }),
      definitionHash,
    );
  }
});

test('PostgreSQL canonical JSON reproduces the PR78 input-schema and registry hashes', {
  skip: !runDbTests,
}, async () => {
  assert.equal(
    await canonicalJsonHashInPostgres({
      domain: 'ai.mockHandlerInputSchema.v1',
      ...AI_ORCHESTRATOR_MOCK_HANDLER_INPUT_SCHEMA_IDENTITY,
    }),
    AI_ORCHESTRATOR_MOCK_HANDLER_INPUT_SCHEMA_HASH,
  );
  assert.equal(
    await canonicalJsonHashInPostgres({
      domain: 'ai.mockHandlerRegistry.v1',
      registryCode: AI_ORCHESTRATOR_MOCK_HANDLER_REGISTRY_CODE,
      registryVersion: AI_ORCHESTRATOR_MOCK_HANDLER_REGISTRY_VERSION,
      jobCatalogHash: FAI_AUDIT_JOB_CATALOG_HASH,
      runtimePolicyHash: AI_ORCHESTRATOR_WORKER_RUNTIME_POLICY_HASH,
      resultContractCatalogHash: AI_RESULT_CONTRACT_CATALOG_HASH,
      inputSchemaCode: AI_ORCHESTRATOR_MOCK_HANDLER_INPUT_SCHEMA_CODE,
      inputSchemaVersion: AI_ORCHESTRATOR_MOCK_HANDLER_INPUT_SCHEMA_VERSION,
      inputSchemaHash: AI_ORCHESTRATOR_MOCK_HANDLER_INPUT_SCHEMA_HASH,
      limits: AI_ORCHESTRATOR_MOCK_HANDLER_LIMITS,
      handlers: AI_ORCHESTRATOR_MOCK_HANDLER_DEFINITIONS,
    }),
    AI_ORCHESTRATOR_MOCK_HANDLER_REGISTRY_HASH,
  );
});

test('all 13 mock outputs pass PostgreSQL shape, canonicalization and payload-hash mirrors read-only', {
  skip: !runDbTests,
}, async () => {
  const before = await runtimeTableCounts();
  const intents = canonicalIntents();
  for (const jobCode of FAI_AUDIT_JOB_CODES) {
    const intent = intents.get(jobCode);
    assert.ok(intent);
    const output = executeAiOrchestratorMockHandler(
      createAiOrchestratorMockHandlerInvocation(intent),
    );
    await db().$queryRaw<Array<{ validated: string }>>(Prisma.sql`
      SELECT "assert_ai_workflow_result_payload_shape"(
        ${jobCode}, CAST(${JSON.stringify(output.resultPayload)} AS JSONB)
      )::TEXT AS "validated"
    `);
    const resultValidation = validateAiResultJsonValue(
      output.resultPayload,
      AI_ORCHESTRATOR_MOCK_HANDLER_LIMITS.maxOutputPayloadBytes,
    );
    const resultRows = await db().$queryRaw<Array<{
      canonical: string;
      payloadHash: string;
      payloadBytes: number;
    }>>(Prisma.sql`
      SELECT
        "canonicalize_ai_result_jsonb_v1"(
          CAST(${JSON.stringify(output.resultPayload)} AS JSONB)
        ) AS "canonical",
        "ai_result_artifact_canonical_hash"(
          'ai.payload.v1', CAST(${JSON.stringify(output.resultPayload)} AS JSONB)
        ) AS "payloadHash",
        OCTET_LENGTH(CONVERT_TO(
          "canonicalize_ai_result_jsonb_v1"(
            CAST(${JSON.stringify(output.resultPayload)} AS JSONB)
          ), 'UTF8'
        ))::INTEGER AS "payloadBytes"
    `);
    assert.deepEqual(resultRows, [{
      canonical: resultValidation.canonical,
      payloadHash: resultValidation.payloadHash,
      payloadBytes: resultValidation.bytes,
    }]);

    for (const artifact of output.artifacts) {
      await db().$queryRaw<Array<{ validated: string }>>(Prisma.sql`
        SELECT "assert_ai_workflow_artifact_payload_shape"(
          ${artifact.artifactType}, CAST(${JSON.stringify(artifact.payload)} AS JSONB)
        )::TEXT AS "validated"
      `);
      const validation = validateAiResultJsonValue(
        artifact.payload,
        AI_ORCHESTRATOR_MOCK_HANDLER_LIMITS.maxOutputPayloadBytes,
      );
      const hashRows = await db().$queryRaw<Array<{ payloadHash: string }>>(Prisma.sql`
        SELECT "ai_result_artifact_canonical_hash"(
          'ai.payload.v1', CAST(${JSON.stringify(artifact.payload)} AS JSONB)
        ) AS "payloadHash"
      `);
      assert.deepEqual(hashRows, [{ payloadHash: validation.payloadHash }]);
    }
  }
  assert.deepEqual(await runtimeTableCounts(), before);
});
