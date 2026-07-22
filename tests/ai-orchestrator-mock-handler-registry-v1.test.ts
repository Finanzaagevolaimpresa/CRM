import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { canonicalJson, canonicalSha256 } from '../src/lib/canonical-json';
import {
  FAI_AUDIT_MAX_CORRECTION_CYCLES,
  FAI_AUDIT_STATES,
  FAI_AUDIT_TRANSITIONS,
  FAI_AUDIT_WORKFLOW_DEFINITION_HASH,
  FAI_AUDIT_WORKFLOW_ID,
  FAI_AUDIT_WORKFLOW_VERSION,
  getAuditWorkflowTransition,
} from '../src/lib/ai-orchestrator/audit-workflow-v1-1';
import {
  FAI_AUDIT_JOB_CODES,
  FAI_AUDIT_JOB_CATALOG_HASH,
  FAI_AUDIT_JOB_CATALOG_KEY,
  FAI_AUDIT_JOB_DEFINITION_HASHES,
  FAI_AUDIT_JOB_PLANNING_RULES,
  getFaiAuditExecutorBinding,
  getFaiAuditJobDefinition,
  type FaiAuditJobCode,
} from '../src/lib/ai-orchestrator/job-catalog-v1';
import {
  createFaiAuditJobPlan,
  type FaiAuditJobIntent,
} from '../src/lib/ai-orchestrator/job-planner';
import {
  AI_ORCHESTRATOR_MOCK_HANDLER_DEFINITIONS,
  AI_ORCHESTRATOR_MOCK_HANDLER_INPUT_SCHEMA_HASH,
  AI_ORCHESTRATOR_MOCK_HANDLER_LIMITS,
  AI_ORCHESTRATOR_MOCK_HANDLER_REGISTRY_HASH,
  AI_ORCHESTRATOR_MOCK_HANDLER_SIDE_EFFECT_POLICY,
  AiOrchestratorMockHandlerError,
  createAiOrchestratorMockHandlerDefinitionHash,
  createAiOrchestratorMockHandlerInputSchemaHash,
  createAiOrchestratorMockHandlerInvocation,
  createAiOrchestratorMockHandlerRegistryHash,
  executeAiOrchestratorMockHandler,
  getAiOrchestratorMockHandlerDefinition,
  getAiOrchestratorMockHandlerDefinitionByCode,
  getAiOrchestratorMockHandlerRegistryInvariantErrors,
  listAiOrchestratorMockHandlerDefinitions,
  type AiOrchestratorMockHandlerErrorCode,
  type AiOrchestratorMockHandlerInvocation,
} from '../src/lib/ai-orchestrator/mock-handler-registry-v1';
import {
  AI_RESULT_CONTRACT_CATALOG_HASH,
  getAiResultContract,
  validateAndHashAiResultDraft,
  type AiResultProvenance,
} from '../src/lib/ai-orchestrator/result-artifact-contract-v1';
import {
  AI_ORCHESTRATOR_WORKER_CAPABILITY_HASHES,
  AI_ORCHESTRATOR_WORKER_RUNTIME_LIMITS,
  AI_ORCHESTRATOR_WORKER_RUNTIME_POLICY_HASH,
  getAiOrchestratorWorkerCapability,
} from '../src/lib/ai-orchestrator/worker-runtime-policy-v1';

const EXPECTED_ARTIFACT_TYPES = Object.freeze({
  DOCUMENT_INGESTION: ['DOCUMENT_MANIFEST'],
  DOCUMENT_CLASSIFICATION: ['DOCUMENT_CLASSIFICATION'],
  EVIDENCE_EXTRACTION: ['EVIDENCE_SET'],
  FINANCIAL_ANALYSIS: ['FINANCIAL_ANALYSIS'],
  CREDIT_ANALYSIS: ['CREDIT_ANALYSIS'],
  CALCULATIONS: ['CALCULATION_SET'],
  FINDINGS_DRAFTING: ['FINDINGS_DRAFT'],
  REPORT_COMPOSITION: ['REPORT_DRAFT'],
  SCHEMA_REVIEW: ['SCHEMA_REVIEW_REPORT'],
  NUMERIC_REVIEW: ['NUMERIC_REVIEW_REPORT'],
  SOURCE_REVIEW: ['SOURCE_REVIEW_REPORT'],
  RED_TEAM_REVIEW: ['RED_TEAM_REVIEW_REPORT'],
  CORRECTION: ['CORRECTED_REPORT', 'CORRECTION_MANIFEST'],
} as const satisfies Readonly<Record<FaiAuditJobCode, readonly string[]>>);

const EXPECTED_BUNDLE_CARDINALITY = Object.freeze({
  DOCUMENT_PIPELINE: 3,
  ANALYSIS_BUNDLE: 3,
  DRAFTING_PIPELINE: 2,
  REVIEW_BUNDLE: 4,
  CORRECTION_PIPELINE: 1,
} as const);

const GOLDEN_HASHES = Object.freeze({
  inputSchemaHash: 'bc31984dbf1c35c62506c1a393b840e2627e02d8bfac0715d6e693ff5180c76d',
  registryHash: '956156efd44f5bff08763bcdd08d5d37df92a883d5d45df63603675518e80c24',
  definitions: Object.freeze({
    DOCUMENT_INGESTION: ['860d85fe4ccfe5022013dbd8b7eb84cef83afc7f73ecf05171426ddc9020c771', '6c94f15ab8e0e42a31afb3e42ae74ae14a7f9a79b2c3a5b448efbe612bd9be91'],
    DOCUMENT_CLASSIFICATION: ['c56c690e15129b1e6d90669de20e70ec2fad7d3524f3e3a42b78e1d8912187fd', '20e6a765ed3e22a141a34a6ccc98cd958f56d4d74a80c6c93821bf45043f49ce'],
    EVIDENCE_EXTRACTION: ['d37edc411b1b46edf18f70df7de85169a02ba66e7ef9d95b925c260cff6b3eb1', 'bd3291c9402aef5dc32c1641ae777417ec1b81a075adfcfeccb7f01270aa6c9f'],
    FINANCIAL_ANALYSIS: ['8f57f7faf44dc38effccf18cbb6756b92a715968ef5e6210ecf98c76aa0a75ce', '7034b73d1a4deb39a22fd0a78c5e291748ef63e06cd493a022e9fbad45e10493'],
    CREDIT_ANALYSIS: ['e0de3573760b9d5918b5b1adc27079868e70d8c73def8fd238812a9c230f87ec', '4be2703c6117ea0c23606775d59da18ce189b185e7401ae98883450c05cf0a8f'],
    CALCULATIONS: ['7cc5aae68fb227ce0b256cd23fec7e3cbc28d4e2634ad3574262fc8b59e8ff7b', 'fc2bc8ad5a60ab297343a9ed36e7ea0c0ab6b5e5d172981d5064fadbc62716d3'],
    FINDINGS_DRAFTING: ['262124095452be50607fd73600dac72cb858e081bccb3f470a4a2693247723d9', 'c6c3f291bc47b4551d60f753b671ea3ef70baa99581fb662e0051481db38ab40'],
    REPORT_COMPOSITION: ['742ed580e25dc9fc6f1207bf893be321a54b63a7ad6d1242264a56f72a1bdecb', '0247e6161ec035cdd433ffecc9b33cf0c9c87e0bf2215de7f429b9b99c8bc764'],
    SCHEMA_REVIEW: ['d77139b4a02019e81a6d938b6f8e4b912b8f098dca9169d2cf297868342bb575', 'b96d586283c321683c095ecb4ab1e9fa228f673ddeabd0cad6415fa10cac5303'],
    NUMERIC_REVIEW: ['fed77d818cecd77eb58625447afae54a0a2defb9283243e13ecfd92f186d8648', '8f3993ed007d1db8afd50b46e4e0812ed5cc54a7bbaecaa22f0e34362ebe174a'],
    SOURCE_REVIEW: ['891c809e82738823065180cf4f5ea27dafe1a57a7348213bb76500c04915018f', '1e248a74b624ac90dd33613e6208cc75d9d451476da5390bf8c3d59fdf6776ec'],
    RED_TEAM_REVIEW: ['d13208b3fd0c8888e78aa600603f6f167a7a7b55733ef13bf2b736851eaa72e0', '628e7496ab73152d02978a2ef246a920a37c1e4f474ee27bc010bd86e22087cb'],
    CORRECTION: ['7e6572530a1137582f6ca654bc357fd5545e3a866a1c56468a046a1727203ac4', '84a49a707070bb4af03fcfc04cd41ec3a0bb061316962a39a816726a1b2dadd4'],
  } as const satisfies Readonly<Record<FaiAuditJobCode, readonly [string, string]>>),
} as const);

function plannedIntents(suffix = 'a') {
  const planned: FaiAuditJobIntent[] = [];
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
      workflowInstanceId: `synthetic-workflow-${suffix}-${rule.sourceTransitionCode}`,
      workflowCode: FAI_AUDIT_WORKFLOW_ID,
      workflowVersion: FAI_AUDIT_WORKFLOW_VERSION,
      workflowDefinitionHash: FAI_AUDIT_WORKFLOW_DEFINITION_HASH,
      phaseCode: transition.to,
      phaseEntrySequence,
      sourceCommandIdempotencyKey: `synthetic-idempotency-${suffix}-${rule.sourceTransitionCode}`,
      sourceTransitionCode: rule.sourceTransitionCode,
      sourceTransitionSequence: transition.sequence,
      sourceState: transition.from,
      sourceStateVersion: transition.sequence,
      targetState: transition.to,
      correlationId: `synthetic-correlation-${suffix}-${rule.sourceTransitionCode}`,
      correctionCycle: ['WF-015', 'WF-016'].includes(rule.sourceTransitionCode) ? 1 : 0,
      availableAt: '2026-01-01T00:00:00.000Z',
      resolvedExecutors: rule.jobCodes.map((jobCode) => {
        const executor = getFaiAuditExecutorBinding(jobCode);
        assert.ok(executor);
        return {
          jobCode,
          executorAgentId: `synthetic-agent-${jobCode.toLowerCase()}`,
          executorAgentCode: executor.executorAgentCode,
          executorAgentConfigVersion: executor.executorAgentConfigVersion,
          executorAgentConfigHash: executor.executorAgentConfigHash,
        };
      }),
    });
    planned.push(...plan.jobs);
  }
  return planned;
}

function canonicalIntents(suffix = 'a') {
  const intents = new Map<FaiAuditJobCode, FaiAuditJobIntent>();
  for (const intent of plannedIntents(suffix)) {
    if (!intents.has(intent.jobCode)) intents.set(intent.jobCode, intent);
  }
  assert.equal(intents.size, FAI_AUDIT_JOB_CODES.length);
  return intents;
}

const intents = canonicalIntents();

function refreshBundleAndPayloadHash(invocation: AiOrchestratorMockHandlerInvocation) {
  const payload = invocation.jobPayload;
  payload.job.bundleKey = canonicalSha256({
    schemaVersion: 2,
    catalogKey: FAI_AUDIT_JOB_CATALOG_KEY,
    catalogHash: FAI_AUDIT_JOB_CATALOG_HASH,
    workflowInstanceId: payload.workflow.workflowInstanceId,
    workflowDefinitionHash: payload.workflow.workflowDefinitionHash,
    phaseCode: payload.phase.phaseCode,
    phaseEntrySequence: payload.phase.phaseEntrySequence,
    sourceCommandIdempotencyKey: payload.sourceTransition.idempotencyKey,
    sourceTransitionCode: payload.sourceTransition.transitionCode,
    sourceTransitionSequence: payload.sourceTransition.sequence,
    sourceState: payload.sourceTransition.sourceState,
    sourceStateVersion: payload.sourceTransition.sourceStateVersion,
    correctionCycle: payload.phase.correctionCycle,
    bundleCode: payload.job.bundleCode,
  });
  invocation.jobPayloadHash = canonicalSha256(payload);
}

function invocationFor(jobCode: FaiAuditJobCode, suffix = 'a') {
  const source = suffix === 'a' ? intents : canonicalIntents(suffix);
  const intent = source.get(jobCode);
  assert.ok(intent);
  return createAiOrchestratorMockHandlerInvocation(intent);
}

function provenanceFor(invocation: AiOrchestratorMockHandlerInvocation): AiResultProvenance {
  return {
    runtimeId: 'synthetic-runtime',
    jobId: 'synthetic-job',
    attemptId: 'synthetic-attempt',
    attemptSequence: 1,
    fencingToken: '1',
    workerInstanceId: 'synthetic-registry-test',
    workerBuildHash: AI_ORCHESTRATOR_MOCK_HANDLER_REGISTRY_HASH,
    runtimePolicyHash: AI_ORCHESTRATOR_WORKER_RUNTIME_POLICY_HASH,
    capabilityCode: invocation.handler.capabilityCode,
    capabilityVersion: invocation.handler.capabilityVersion,
    capabilityHash: invocation.handler.capabilityHash,
    handlerCode: invocation.handler.handlerCode,
    handlerVersion: invocation.handler.handlerVersion,
    jobPayloadHash: invocation.jobPayloadHash,
    workflowInstanceId: invocation.jobPayload.workflow.workflowInstanceId,
    workflowDefinitionHash: invocation.jobPayload.workflow.workflowDefinitionHash,
    phaseCode: invocation.jobPayload.phase.phaseCode,
    phaseEntrySequence: invocation.jobPayload.phase.phaseEntrySequence,
    correctionCycle: invocation.jobPayload.phase.correctionCycle,
    executorAgentId: invocation.executor.agentId,
    executorAgentCode: invocation.executor.agentCode,
    executorAgentConfigVersion: invocation.executor.configVersion,
    executorAgentConfigHash: invocation.executor.configHash,
    provider: 'mock',
    dataMode: 'synthetic',
  };
}

function assertDeepFrozen(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  assert.equal(Object.isFrozen(value), true);
  for (const item of Object.values(value)) assertDeepFrozen(item);
}

function expectHandlerError(
  code: AiOrchestratorMockHandlerErrorCode,
  callback: () => unknown,
) {
  assert.throws(callback, (error: unknown) => {
    assert.ok(error instanceof AiOrchestratorMockHandlerError);
    assert.equal(error.name, 'AiOrchestratorMockHandlerError');
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    return true;
  });
}

test('mock registry covers exactly the 13 canonical jobs, five bundles and output families', () => {
  assert.deepEqual(
    listAiOrchestratorMockHandlerDefinitions().map(({ jobCode }) => jobCode),
    FAI_AUDIT_JOB_CODES,
  );
  assert.equal(AI_ORCHESTRATOR_MOCK_HANDLER_DEFINITIONS.length, 13);
  assert.equal(new Set(AI_ORCHESTRATOR_MOCK_HANDLER_DEFINITIONS.map((item) => item.jobCode)).size, 13);
  assert.equal(new Set(AI_ORCHESTRATOR_MOCK_HANDLER_DEFINITIONS.map((item) => item.handlerCode)).size, 13);
  assert.deepEqual(getAiOrchestratorMockHandlerRegistryInvariantErrors(), []);
  assert.equal(getAiOrchestratorMockHandlerDefinition('UNKNOWN'), null);
  assert.equal(getAiOrchestratorMockHandlerDefinitionByCode('UNKNOWN'), null);

  const bundleCounts = Object.fromEntries(Object.keys(EXPECTED_BUNDLE_CARDINALITY).map(
    (bundleCode) => [bundleCode, 0],
  )) as Record<keyof typeof EXPECTED_BUNDLE_CARDINALITY, number>;
  for (const jobCode of FAI_AUDIT_JOB_CODES) {
    const definition = getFaiAuditJobDefinition(jobCode);
    const contract = getAiResultContract(jobCode);
    assert.ok(definition);
    assert.ok(contract);
    bundleCounts[definition.bundleCode] += 1;
    assert.deepEqual(contract.requiredArtifactTypes, EXPECTED_ARTIFACT_TYPES[jobCode]);
  }
  assert.deepEqual(bundleCounts, EXPECTED_BUNDLE_CARDINALITY);
});

test('every descriptor is immutable and exactly binds PR75, PR76 and PR77 identities', () => {
  assertDeepFrozen(AI_ORCHESTRATOR_MOCK_HANDLER_DEFINITIONS);
  assertDeepFrozen(AI_ORCHESTRATOR_MOCK_HANDLER_SIDE_EFFECT_POLICY);
  for (const definition of AI_ORCHESTRATOR_MOCK_HANDLER_DEFINITIONS) {
    const job = getFaiAuditJobDefinition(definition.jobCode);
    const capability = getAiOrchestratorWorkerCapability(definition.jobCode);
    const contract = getAiResultContract(definition.jobCode);
    assert.ok(job);
    assert.ok(capability);
    assert.ok(contract);
    assert.equal(definition.jobDefinitionHash, FAI_AUDIT_JOB_DEFINITION_HASHES[definition.jobCode]);
    assert.equal(definition.capabilityCode, capability.capabilityCode);
    assert.equal(definition.capabilityHash, AI_ORCHESTRATOR_WORKER_CAPABILITY_HASHES[definition.jobCode]);
    assert.equal(definition.handlerCode, capability.handlerCode);
    assert.equal(definition.executorAgentCode, job.executorAgentCode);
    assert.equal(definition.executorAgentConfigHash, job.executorAgentConfigHash);
    assert.equal(definition.resultContractCode, contract.resultContractCode);
    assert.equal(definition.resultContractHash, contract.resultContractHash);
    assert.equal(definition.deterministic, true);
    assert.equal(definition.sideEffectsAllowed, false);
    assert.ok(Object.values(definition.sideEffectPolicy).every((allowed) => allowed === false));
    const { definitionHash, ...identity } = definition;
    assert.equal(createAiOrchestratorMockHandlerDefinitionHash(identity), definitionHash);
    assert.equal(getAiOrchestratorMockHandlerDefinitionByCode(definition.handlerCode), definition);
  }
  assert.equal(createAiOrchestratorMockHandlerRegistryHash(), AI_ORCHESTRATOR_MOCK_HANDLER_REGISTRY_HASH);
  assert.equal(
    createAiOrchestratorMockHandlerInputSchemaHash(),
    AI_ORCHESTRATOR_MOCK_HANDLER_INPUT_SCHEMA_HASH,
  );
  assert.match(AI_ORCHESTRATOR_MOCK_HANDLER_INPUT_SCHEMA_HASH, /^[0-9a-f]{64}$/);
  assert.match(AI_ORCHESTRATOR_MOCK_HANDLER_REGISTRY_HASH, /^[0-9a-f]{64}$/);
  assert.ok(AI_ORCHESTRATOR_MOCK_HANDLER_LIMITS.maxInputBytes > 0);
  assert.ok(AI_ORCHESTRATOR_MOCK_HANDLER_LIMITS.maxOutputPayloadBytes > 0);
  assert.ok(AI_ORCHESTRATOR_MOCK_HANDLER_LIMITS.maxObservedExecutionMs > 0);
  assert.ok(
    AI_ORCHESTRATOR_MOCK_HANDLER_LIMITS.maxObservedExecutionMs
      < AI_ORCHESTRATOR_WORKER_RUNTIME_LIMITS.heartbeatIntervalMs,
  );
});

test('literal golden vectors prevent silent semantic changes under registry version 1.0', () => {
  assert.equal(FAI_AUDIT_JOB_CATALOG_HASH, '3e99436a4734323a423907bf742f71e632e433f8d0203f28da0c96bcc44a45f9');
  assert.equal(AI_ORCHESTRATOR_WORKER_RUNTIME_POLICY_HASH, '1d23eae02bdaa6eab422b600b95a50b690e6d7bed518669a811bcfc9ed8bcb4b');
  assert.equal(AI_RESULT_CONTRACT_CATALOG_HASH, 'ad847b572e7c7369249ecdfa63acbfaa8e699b705a9e8623b31d0315c122c9f2');
  assert.equal(AI_ORCHESTRATOR_MOCK_HANDLER_INPUT_SCHEMA_HASH, GOLDEN_HASHES.inputSchemaHash);
  assert.equal(AI_ORCHESTRATOR_MOCK_HANDLER_REGISTRY_HASH, GOLDEN_HASHES.registryHash);
  for (const definition of AI_ORCHESTRATOR_MOCK_HANDLER_DEFINITIONS) {
    assert.deepEqual(
      [definition.definitionHash, definition.mockOutputFixtureHash],
      GOLDEN_HASHES.definitions[definition.jobCode],
      definition.jobCode,
    );
  }
});

test('all 13 explicit handlers are deterministic, isolated, frozen and accepted by PR77', () => {
  for (const jobCode of FAI_AUDIT_JOB_CODES) {
    const invocation = invocationFor(jobCode);
    const mutableInput = structuredClone(invocation);
    const inputBefore = canonicalJson(mutableInput);
    const first = executeAiOrchestratorMockHandler(mutableInput);
    const second = executeAiOrchestratorMockHandler(structuredClone(invocation));
    assert.equal(canonicalJson(mutableInput), inputBefore, `${jobCode} mutated its input`);
    assert.deepEqual(first, second);
    assert.notEqual(first, second);
    assertDeepFrozen(first);
    assert.deepEqual(
      first.artifacts.map(({ artifactType }) => artifactType),
      EXPECTED_ARTIFACT_TYPES[jobCode],
    );
    assert.ok(first.resultPayload && typeof first.resultPayload === 'object');
    const validated = validateAndHashAiResultDraft(jobCode, first, provenanceFor(invocation));
    assert.match(validated.resultHash, /^[0-9a-f]{64}$/);
    assert.ok(validated.totalPayloadBytes <= AI_ORCHESTRATOR_MOCK_HANDLER_LIMITS.maxOutputPayloadBytes);
    assert.equal(
      canonicalSha256({ domain: 'ai.mockHandlerFixture.v1', jobCode, draft: first }),
      getAiOrchestratorMockHandlerDefinition(jobCode)?.mockOutputFixtureHash,
    );
  }
});

test('every canonical planning-rule variant executes, including self transitions and correction review', () => {
  const allPlanned = plannedIntents('all-rules');
  assert.equal(
    allPlanned.length,
    FAI_AUDIT_JOB_PLANNING_RULES.reduce((total, rule) => total + rule.jobCodes.length, 0),
  );
  for (const intent of allPlanned) {
    const invocation = createAiOrchestratorMockHandlerInvocation(intent);
    const output = executeAiOrchestratorMockHandler(invocation);
    assert.deepEqual(
      output.artifacts.map(({ artifactType }) => artifactType),
      EXPECTED_ARTIFACT_TYPES[intent.jobCode],
      `${intent.jobCode} planning variant`,
    );
  }
});

test('input object-key order and unrelated synthetic causal identities cannot alter a handler fixture', () => {
  for (const jobCode of FAI_AUDIT_JOB_CODES) {
    const invocationA = invocationFor(jobCode, 'order-a');
    const invocationB = invocationFor(jobCode, 'order-b');
    const reordered = JSON.parse(canonicalJson(invocationA)) as unknown;
    assert.deepEqual(
      executeAiOrchestratorMockHandler(reordered),
      executeAiOrchestratorMockHandler(invocationA),
    );
    assert.deepEqual(
      executeAiOrchestratorMockHandler(invocationA),
      executeAiOrchestratorMockHandler(invocationB),
    );
    assert.notEqual(invocationA.jobPayloadHash, invocationB.jobPayloadHash);
  }
});

test('strict invocation validation fails closed for every identity boundary without leaking payloads', () => {
  const base = structuredClone(invocationFor('DOCUMENT_INGESTION'));
  const cases: Array<{
    code: AiOrchestratorMockHandlerErrorCode;
    mutate: (value: AiOrchestratorMockHandlerInvocation) => void;
  }> = [
    {
      code: 'AI_MOCK_HANDLER_REGISTRY_MISMATCH',
      mutate: (value) => { value.registry.registryHash = '0'.repeat(64); },
    },
    {
      code: 'AI_MOCK_HANDLER_DEFINITION_MISMATCH',
      mutate: (value) => { value.handler.definitionHash = '0'.repeat(64); },
    },
    {
      code: 'AI_MOCK_HANDLER_JOB_MISMATCH',
      mutate: (value) => { value.handler.jobDefinitionHash = '0'.repeat(64); },
    },
    {
      code: 'AI_MOCK_HANDLER_CAPABILITY_MISMATCH',
      mutate: (value) => { value.handler.capabilityHash = '0'.repeat(64); },
    },
    {
      code: 'AI_MOCK_HANDLER_EXECUTOR_MISMATCH',
      mutate: (value) => { value.executor.configHash = '0'.repeat(64); },
    },
    {
      code: 'AI_MOCK_HANDLER_RESULT_CONTRACT_MISMATCH',
      mutate: (value) => { value.handler.resultContractHash = '0'.repeat(64); },
    },
    {
      code: 'AI_MOCK_HANDLER_JOB_PAYLOAD_HASH_MISMATCH',
      mutate: (value) => { value.jobPayloadHash = '0'.repeat(64); },
    },
    {
      code: 'AI_MOCK_HANDLER_JOB_PAYLOAD_IDENTITY_MISMATCH',
      mutate: (value) => {
        value.jobPayload.job.bundleKey = '0'.repeat(64);
        value.jobPayloadHash = canonicalSha256(value.jobPayload);
      },
    },
    {
      code: 'AI_MOCK_HANDLER_JOB_PAYLOAD_IDENTITY_MISMATCH',
      mutate: (value) => {
        value.jobPayload.sourceTransition.sourceState = FAI_AUDIT_STATES.find(
          (state) => state !== value.jobPayload.sourceTransition.sourceState,
        )!;
        refreshBundleAndPayloadHash(value);
      },
    },
    {
      code: 'AI_MOCK_HANDLER_JOB_PAYLOAD_IDENTITY_MISMATCH',
      mutate: (value) => {
        value.jobPayload.job.slotKey = `99:${value.jobPayload.job.jobCode}`;
        value.jobPayloadHash = canonicalSha256(value.jobPayload);
      },
    },
    {
      code: 'AI_MOCK_HANDLER_JOB_PAYLOAD_IDENTITY_MISMATCH',
      mutate: (value) => {
        value.jobPayload.phase.phaseEntrySequence = value.jobPayload.sourceTransition.sequence - 1;
        refreshBundleAndPayloadHash(value);
      },
    },
    {
      code: 'AI_MOCK_HANDLER_JOB_PAYLOAD_IDENTITY_MISMATCH',
      mutate: (value) => {
        value.jobPayload.sourceTransition.sourceStateVersion += 1;
        refreshBundleAndPayloadHash(value);
      },
    },
  ];
  for (const entry of cases) {
    const changed = structuredClone(base);
    entry.mutate(changed);
    expectHandlerError(entry.code, () => executeAiOrchestratorMockHandler(changed));
  }

  const selfTransition = structuredClone(invocationFor('DOCUMENT_CLASSIFICATION'));
  selfTransition.jobPayload.phase.phaseEntrySequence = selfTransition.jobPayload.sourceTransition.sequence;
  refreshBundleAndPayloadHash(selfTransition);
  expectHandlerError(
    'AI_MOCK_HANDLER_JOB_PAYLOAD_IDENTITY_MISMATCH',
    () => executeAiOrchestratorMockHandler(selfTransition),
  );

  const nonCorrection = structuredClone(base);
  nonCorrection.jobPayload.phase.correctionCycle = 1;
  refreshBundleAndPayloadHash(nonCorrection);
  expectHandlerError(
    'AI_MOCK_HANDLER_JOB_PAYLOAD_IDENTITY_MISMATCH',
    () => executeAiOrchestratorMockHandler(nonCorrection),
  );

  const correction = structuredClone(invocationFor('CORRECTION'));
  correction.jobPayload.phase.correctionCycle = 0;
  refreshBundleAndPayloadHash(correction);
  expectHandlerError(
    'AI_MOCK_HANDLER_JOB_PAYLOAD_IDENTITY_MISMATCH',
    () => executeAiOrchestratorMockHandler(correction),
  );

  const oversizedUtf8Identity = structuredClone(base);
  oversizedUtf8Identity.jobPayload.workflow.workflowInstanceId = '😀'.repeat(51);
  refreshBundleAndPayloadHash(oversizedUtf8Identity);
  expectHandlerError(
    'AI_MOCK_HANDLER_INVOCATION_INVALID',
    () => executeAiOrchestratorMockHandler(oversizedUtf8Identity),
  );

  const extra = structuredClone(base) as AiOrchestratorMockHandlerInvocation & { extra?: string };
  extra.extra = 'synthetic';
  expectHandlerError('AI_MOCK_HANDLER_INVOCATION_INVALID', () => executeAiOrchestratorMockHandler(extra));

  const nonMock = structuredClone(base) as unknown as { provider: string };
  nonMock.provider = 'external';
  expectHandlerError('AI_MOCK_HANDLER_INVOCATION_INVALID', () => executeAiOrchestratorMockHandler(nonMock));

  const sensitive = structuredClone(base) as AiOrchestratorMockHandlerInvocation & {
    unknownField?: string;
  };
  sensitive.unknownField = 'secret-value-that-must-never-appear';
  try {
    executeAiOrchestratorMockHandler(sensitive);
    assert.fail('Sensitive unknown input was accepted.');
  } catch (error) {
    assert.ok(error instanceof AiOrchestratorMockHandlerError);
    assert.equal(error.code, 'AI_MOCK_HANDLER_INVOCATION_INVALID');
    assert.doesNotMatch(error.message, /secret-value/i);
  }
});

test('intent projection rejects inconsistent redundant PR75 row identities before execution', () => {
  const intent = intents.get('DOCUMENT_INGESTION');
  assert.ok(intent);
  const mismatches: FaiAuditJobIntent[] = [
    { ...intent, phaseCode: 'CREATED' },
    { ...intent, bundleKey: '0'.repeat(64) },
    { ...intent, dedupeKey: '0'.repeat(64) },
    { ...intent, availableAt: '2026-01-02T00:00:00.000Z' },
  ];
  for (const mismatch of mismatches) {
    expectHandlerError(
      'AI_MOCK_HANDLER_JOB_PAYLOAD_IDENTITY_MISMATCH',
      () => createAiOrchestratorMockHandlerInvocation(mismatch),
    );
  }
});

test('input byte, JSON-depth, JSON-node and numeric limits are enforced before execution', () => {
  expectHandlerError('AI_MOCK_HANDLER_INPUT_TOO_LARGE', () => executeAiOrchestratorMockHandler({
    padding: Array.from({ length: 100 }, () => 'x'.repeat(400)),
  }));

  let tooDeep: unknown = 'synthetic';
  for (let depth = 0; depth <= 8; depth += 1) tooDeep = { child: tooDeep };
  expectHandlerError('AI_MOCK_HANDLER_INVOCATION_INVALID', () => executeAiOrchestratorMockHandler(tooDeep));
  expectHandlerError('AI_MOCK_HANDLER_INVOCATION_INVALID', () => executeAiOrchestratorMockHandler({
    nodes: Array.from({ length: 520 }, () => null),
  }));
  expectHandlerError('AI_MOCK_HANDLER_INVOCATION_INVALID', () => executeAiOrchestratorMockHandler({
    unsafe: Number.MAX_SAFE_INTEGER + 1,
  }));
  expectHandlerError('AI_MOCK_HANDLER_INVOCATION_INVALID', () => executeAiOrchestratorMockHandler({
    notJson: 1n,
  }));
});

test('source and import boundaries prove no worker, database, network, provider or nondeterministic primitive', () => {
  const source = readFileSync(
    'src/lib/ai-orchestrator/mock-handler-registry-v1.ts',
    'utf8',
  );
  const workerRuntime = readFileSync('src/lib/ai-orchestrator/worker-runtime.ts', 'utf8');
  const dormantWorker = readFileSync(
    'src/lib/ai-orchestrator/dormant-worker-process-v1.ts',
    'utf8',
  );
  const workerScript = readFileSync('scripts/ai-orchestrator-worker.ts', 'utf8');
  const schema = readFileSync('prisma/schema.prisma', 'utf8');

  assert.doesNotMatch(source, /from\s+['"]@prisma\/client['"]/);
  assert.doesNotMatch(source, /from\s+['"](?:node:)?(?:http|https|net|dns|tls|fs|child_process)['"]/);
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /\bOpenAI\b|\baxios\b|\bundici\b/);
  assert.doesNotMatch(source, /\bprocess\.env\b|\bDate\.now\s*\(|\bMath\.random\s*\(|\brandomUUID\s*\(/);
  assert.doesNotMatch(source, /\bsetTimeout\s*\(|\bsetInterval\s*\(|\beval\s*\(|\bnew\s+Function\s*\(/);
  assert.doesNotMatch(source, /worker-runtime['"]/);
  assert.doesNotMatch(workerRuntime, /mock-handler-registry-v1/);
  assert.doesNotMatch(source, /dormant-worker-process-v1/);
  assert.doesNotMatch(dormantWorker, /mock-handler-registry-v1/);
  assert.doesNotMatch(workerScript, /mock-handler-registry-v1/);
  assert.doesNotMatch(schema, /MockHandlerRegistry|MockHandlerDefinition/);
  assert.equal(
    readdirSync('prisma/migrations').some((name) => /mock_handler_registry/i.test(name)),
    false,
  );
  assert.equal(FAI_AUDIT_MAX_CORRECTION_CYCLES, 2);
  assert.match(AI_RESULT_CONTRACT_CATALOG_HASH, /^[0-9a-f]{64}$/);
});
