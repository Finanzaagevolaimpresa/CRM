import { z } from 'zod';
import { canonicalSha256 } from '../canonical-json';
import {
  FAI_AUDIT_MAX_CORRECTION_CYCLES,
  FAI_AUDIT_STATES,
  FAI_AUDIT_TRANSITION_CODES,
  FAI_AUDIT_WORKFLOW_DEFINITION_HASH,
  FAI_AUDIT_WORKFLOW_ID,
  FAI_AUDIT_WORKFLOW_VERSION,
  getAuditWorkflowTransition,
  type FaiAuditState,
  type FaiAuditTransitionCode,
} from './audit-workflow-v1-1';
import {
  FAI_AUDIT_EXECUTOR_BINDING_VERSION,
  FAI_AUDIT_JOB_CATALOG_HASH,
  FAI_AUDIT_JOB_CATALOG_CODE,
  FAI_AUDIT_JOB_CATALOG_KEY,
  FAI_AUDIT_JOB_CATALOG_VERSION,
  FAI_AUDIT_JOB_CODES,
  FAI_AUDIT_JOB_DEFINITION_HASHES,
  getFaiAuditJobDefinition,
  getFaiAuditJobPlanningRule,
  type FaiAuditJobBundleCode,
  type FaiAuditJobCode,
} from './job-catalog-v1';
import type { FaiAuditJobIntent } from './job-planner';
import {
  AI_RESULT_CONTRACT_CATALOG_HASH,
  AI_RESULT_LIMITS,
  createSyntheticAiResultDraft,
  getAiResultContract,
  validateAiResultJsonValue,
  validateAndHashAiResultDraft,
  type AiResultArtifactDraft,
  type AiResultProvenance,
} from './result-artifact-contract-v1';
import {
  AI_ORCHESTRATOR_WORKER_CAPABILITY_HASHES,
  AI_ORCHESTRATOR_WORKER_RUNTIME_POLICY_HASH,
  getAiOrchestratorWorkerCapability,
} from './worker-runtime-policy-v1';

export const AI_ORCHESTRATOR_MOCK_HANDLER_REGISTRY_CODE =
  'FAI-AUDIT-MOCK-HANDLER-REGISTRY' as const;
export const AI_ORCHESTRATOR_MOCK_HANDLER_REGISTRY_VERSION = '1.0' as const;
export const AI_ORCHESTRATOR_MOCK_HANDLER_REGISTRY_KEY =
  `${AI_ORCHESTRATOR_MOCK_HANDLER_REGISTRY_CODE}@${AI_ORCHESTRATOR_MOCK_HANDLER_REGISTRY_VERSION}` as const;
export const AI_ORCHESTRATOR_MOCK_HANDLER_INPUT_SCHEMA_CODE =
  'FAI-AUDIT-MOCK-HANDLER-INVOCATION' as const;
export const AI_ORCHESTRATOR_MOCK_HANDLER_INPUT_SCHEMA_VERSION = '1.0' as const;

export const AI_ORCHESTRATOR_MOCK_HANDLER_LIMITS = Object.freeze({
  maxInputBytes: 32 * 1024,
  maxOutputPayloadBytes: AI_RESULT_LIMITS.maxResultBytes,
  maxObservedExecutionMs: 5_000,
} as const);

const HASH_RE = /^[0-9a-f]{64}$/;
const IDENTITY_RE = /^[A-Za-z0-9][A-Za-z0-9_.:_-]{0,199}$/;
const SLOT_RE = /^\d{2}:[A-Z0-9_]{1,120}$/;
const BUNDLE_CODES = Object.freeze([
  'DOCUMENT_PIPELINE',
  'ANALYSIS_BUNDLE',
  'DRAFTING_PIPELINE',
  'REVIEW_BUNDLE',
  'CORRECTION_PIPELINE',
] as const satisfies readonly FaiAuditJobBundleCode[]);

const hash = z.string().regex(HASH_RE);
const identity = z.string().regex(IDENTITY_RE);
const boundedIdentity = z.string().min(1).max(200).superRefine((value, context) => {
  if (Buffer.byteLength(value, 'utf8') > 200) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'AI_MOCK_HANDLER_IDENTITY_TOO_LARGE',
    });
  }
});
const jobCode = z.enum([...FAI_AUDIT_JOB_CODES] as [FaiAuditJobCode, ...FaiAuditJobCode[]]);
const auditState = z.enum([...FAI_AUDIT_STATES] as [FaiAuditState, ...FaiAuditState[]]);
const transitionCode = z.enum(
  [...FAI_AUDIT_TRANSITION_CODES] as [FaiAuditTransitionCode, ...FaiAuditTransitionCode[]],
);
const bundleCode = z.enum(
  [...BUNDLE_CODES] as [FaiAuditJobBundleCode, ...FaiAuditJobBundleCode[]],
);
const canonicalTimestamp = z.string().datetime({ offset: true }).superRefine((value, context) => {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'AI_MOCK_HANDLER_TIMESTAMP_NOT_CANONICAL',
    });
  }
});

export const AiOrchestratorMockHandlerJobPayloadSchema = z.object({
  schemaVersion: z.literal(2),
  catalogKey: z.literal(FAI_AUDIT_JOB_CATALOG_KEY),
  catalogHash: z.literal(FAI_AUDIT_JOB_CATALOG_HASH),
  workflow: z.object({
    workflowCode: z.literal(FAI_AUDIT_WORKFLOW_ID),
    workflowVersion: z.literal(FAI_AUDIT_WORKFLOW_VERSION),
    workflowDefinitionHash: z.literal(FAI_AUDIT_WORKFLOW_DEFINITION_HASH),
    workflowInstanceId: boundedIdentity,
    dataMode: z.literal('synthetic'),
  }).strict(),
  phase: z.object({
    phaseCode: auditState,
    phaseEntrySequence: z.number().int().min(1),
    correctionCycle: z.number().int().min(0).max(FAI_AUDIT_MAX_CORRECTION_CYCLES),
  }).strict(),
  sourceTransition: z.object({
    transitionCode,
    sequence: z.number().int().min(1),
    idempotencyKey: boundedIdentity,
    correlationId: boundedIdentity,
    sourceState: auditState,
    sourceStateVersion: z.number().int().min(1),
    targetState: auditState,
  }).strict(),
  executor: z.object({
    bindingVersion: z.literal(FAI_AUDIT_EXECUTOR_BINDING_VERSION),
    agentId: boundedIdentity,
    agentCode: identity,
    configVersion: z.literal(1),
    configHash: hash,
  }).strict(),
  job: z.object({
    jobCode,
    jobVersion: z.literal('1.0'),
    jobDefinitionHash: hash,
    completionTransitionCode: transitionCode,
    completionMode: z.enum(['SINGLE', 'ALL_OF_BUNDLE']),
    slotKey: z.string().regex(SLOT_RE),
    bundleCode,
    bundleKey: hash,
    provider: z.literal('mock'),
    automaticDispatchAllowed: z.literal(false),
    availableAt: canonicalTimestamp,
  }).strict(),
}).strict();

export const AI_ORCHESTRATOR_MOCK_HANDLER_INPUT_SCHEMA_IDENTITY = freezeDeep({
  schemaIdentityVersion: 1,
  schemaCode: AI_ORCHESTRATOR_MOCK_HANDLER_INPUT_SCHEMA_CODE,
  schemaVersion: AI_ORCHESTRATOR_MOCK_HANDLER_INPUT_SCHEMA_VERSION,
  objectStrictness: 'reject-unknown-keys-recursively',
  jsonPolicySource: 'AI_RESULT_SCHEMA_POLICY_IDENTITY@1',
  resultContractCatalogHash: AI_RESULT_CONTRACT_CATALOG_HASH,
  canonicalJobPayloadVersion: 2,
  jobPayloadHashBinding: 'canonical-sha256',
  registryBindingRequired: true,
  handlerDefinitionBindingRequired: true,
  provider: 'mock',
  dataMode: 'synthetic',
  sideEffectContext: 'none',
  patterns: {
    hash: HASH_RE.source,
    identity: IDENTITY_RE.source,
    boundedIdentity: 'string:zod-code-units=1..200:utf8-bytes<=200',
    capabilityCode: '^[A-Z0-9_]{1,120}$',
    slot: SLOT_RE.source,
    canonicalTimestamp: 'zod-datetime-offset-and-date-toISOString-exact',
  },
  canonicalWorkflow: {
    workflowCode: FAI_AUDIT_WORKFLOW_ID,
    workflowVersion: FAI_AUDIT_WORKFLOW_VERSION,
    workflowDefinitionHash: FAI_AUDIT_WORKFLOW_DEFINITION_HASH,
  },
  literalVersions: {
    executorBindingVersion: FAI_AUDIT_EXECUTOR_BINDING_VERSION,
    executorConfigVersion: 1,
    jobVersion: '1.0',
    capabilityVersion: '1.0',
    handlerVersion: '1.0',
    resultContractVersion: '1.0',
  },
  enums: {
    jobCodes: FAI_AUDIT_JOB_CODES,
    auditStates: FAI_AUDIT_STATES,
    transitionCodes: FAI_AUDIT_TRANSITION_CODES,
    bundleCodes: BUNDLE_CODES,
    completionModes: ['SINGLE', 'ALL_OF_BUNDLE'],
  },
  fieldTree: {
    invocation: {
      schemaVersion: 'literal:1',
      registry: 'strict:{registryCode,registryVersion,registryHash}',
      handler: 'strict:{definitionHash,inputSchemaHash,jobCode,jobVersion,jobDefinitionHash,capabilityCode,capabilityVersion,capabilityHash,handlerCode,handlerVersion,resultContractCode,resultContractVersion,resultContractHash}',
      executor: 'strict:{agentId,agentCode,configVersion,configHash}',
      jobPayload: 'AiOrchestratorMockHandlerJobPayloadSchema@2',
      jobPayloadHash: 'sha256',
      provider: 'literal:mock',
      dataMode: 'literal:synthetic',
    },
    jobPayload: {
      schemaVersion: 'literal:2',
      catalogKey: `literal:${FAI_AUDIT_JOB_CATALOG_KEY}`,
      catalogHash: `literal:${FAI_AUDIT_JOB_CATALOG_HASH}`,
      workflow: 'strict:{workflowCode,workflowVersion,workflowDefinitionHash,workflowInstanceId,dataMode}',
      phase: 'strict:{phaseCode,phaseEntrySequence,correctionCycle}',
      sourceTransition: 'strict:{transitionCode,sequence,idempotencyKey,correlationId,sourceState,sourceStateVersion,targetState}',
      executor: 'strict:{bindingVersion,agentId,agentCode,configVersion,configHash}',
      job: 'strict:{jobCode,jobVersion,jobDefinitionHash,completionTransitionCode,completionMode,slotKey,bundleCode,bundleKey,provider,automaticDispatchAllowed,availableAt}',
    },
  },
  numericConstraints: {
    phaseEntrySequence: 'safe-int>=1',
    sourceTransitionSequence: 'safe-int>=1',
    sourceStateVersion: 'safe-int>=1',
    correctionCycle: `safe-int:0..${FAI_AUDIT_MAX_CORRECTION_CYCLES}`,
    executorConfigVersion: 'literal:1',
  },
  crossFieldInvariants: [
    'canonical-job-payload-hash',
    'canonical-job-capability-handler-executor-result-contract-bindings',
    'canonical-transition-from-to',
    'phase-code-equals-transition-target',
    'state-change-phase-entry-equals-source-sequence;self-transition-phase-entry-lt-source-sequence',
    'source-state-version-equals-source-transition-sequence',
    'correction-cycle-wf015-wf016=1..max;all-other-planning-transitions=0',
    'exact-planning-rule-slot-ordinal-and-job-code',
    'canonical-bundle-key',
    'provider-mock-data-mode-synthetic-no-automatic-dispatch',
  ],
  limits: AI_ORCHESTRATOR_MOCK_HANDLER_LIMITS,
});

export function createAiOrchestratorMockHandlerInputSchemaHash() {
  return canonicalSha256({
    domain: 'ai.mockHandlerInputSchema.v1',
    ...AI_ORCHESTRATOR_MOCK_HANDLER_INPUT_SCHEMA_IDENTITY,
  });
}

export const AI_ORCHESTRATOR_MOCK_HANDLER_INPUT_SCHEMA_HASH =
  createAiOrchestratorMockHandlerInputSchemaHash();

export const AiOrchestratorMockHandlerInvocationSchema = z.object({
  schemaVersion: z.literal(1),
  registry: z.object({
    registryCode: z.literal(AI_ORCHESTRATOR_MOCK_HANDLER_REGISTRY_CODE),
    registryVersion: z.literal(AI_ORCHESTRATOR_MOCK_HANDLER_REGISTRY_VERSION),
    registryHash: hash,
  }).strict(),
  handler: z.object({
    definitionHash: hash,
    inputSchemaHash: z.literal(AI_ORCHESTRATOR_MOCK_HANDLER_INPUT_SCHEMA_HASH),
    jobCode,
    jobVersion: z.literal('1.0'),
    jobDefinitionHash: hash,
    capabilityCode: z.string().regex(/^[A-Z0-9_]{1,120}$/),
    capabilityVersion: z.literal('1.0'),
    capabilityHash: hash,
    handlerCode: identity,
    handlerVersion: z.literal('1.0'),
    resultContractCode: identity,
    resultContractVersion: z.literal('1.0'),
    resultContractHash: hash,
  }).strict(),
  executor: z.object({
    agentId: boundedIdentity,
    agentCode: identity,
    configVersion: z.literal(1),
    configHash: hash,
  }).strict(),
  jobPayload: AiOrchestratorMockHandlerJobPayloadSchema,
  jobPayloadHash: hash,
  provider: z.literal('mock'),
  dataMode: z.literal('synthetic'),
}).strict();

export type AiOrchestratorMockHandlerInvocation = z.infer<
  typeof AiOrchestratorMockHandlerInvocationSchema
>;

export const AI_ORCHESTRATOR_MOCK_HANDLER_SIDE_EFFECT_POLICY = Object.freeze({
  networkAccessAllowed: false,
  fetchAllowed: false,
  providerCallAllowed: false,
  crmDataAccessAllowed: false,
  databaseAccessAllowed: false,
  fileSystemAccessAllowed: false,
  environmentAccessAllowed: false,
  randomnessAllowed: false,
  handlerClockAccessAllowed: false,
  workflowTransitionWriteAllowed: false,
  runtimeStateWriteAllowed: false,
  outputPersistenceAllowed: false,
} as const);

export interface AiOrchestratorMockHandlerDefinition {
  readonly registryCode: typeof AI_ORCHESTRATOR_MOCK_HANDLER_REGISTRY_CODE;
  readonly registryVersion: typeof AI_ORCHESTRATOR_MOCK_HANDLER_REGISTRY_VERSION;
  readonly jobCode: FaiAuditJobCode;
  readonly jobVersion: '1.0';
  readonly jobDefinitionHash: string;
  readonly capabilityCode: string;
  readonly capabilityVersion: '1.0';
  readonly capabilityHash: string;
  readonly handlerCode: string;
  readonly handlerVersion: '1.0';
  readonly executorAgentCode: string;
  readonly executorAgentConfigVersion: 1;
  readonly executorAgentConfigHash: string;
  readonly inputSchemaCode: typeof AI_ORCHESTRATOR_MOCK_HANDLER_INPUT_SCHEMA_CODE;
  readonly inputSchemaVersion: typeof AI_ORCHESTRATOR_MOCK_HANDLER_INPUT_SCHEMA_VERSION;
  readonly inputSchemaHash: string;
  readonly resultContractCode: string;
  readonly resultContractVersion: '1.0';
  readonly resultContractHash: string;
  readonly mockOutputFixtureHash: string;
  readonly deterministic: true;
  readonly sideEffectsAllowed: false;
  readonly executionMode: 'SYNCHRONOUS_PURE';
  readonly outputStrategy: 'CONSTANT_SYNTHETIC_FIXTURE_PER_HANDLER';
  readonly provider: 'mock';
  readonly dataMode: 'synthetic';
  readonly sideEffectPolicy: typeof AI_ORCHESTRATOR_MOCK_HANDLER_SIDE_EFFECT_POLICY;
  readonly limits: typeof AI_ORCHESTRATOR_MOCK_HANDLER_LIMITS;
  readonly definitionHash: string;
}

type MockHandlerDefinitionIdentity = Omit<AiOrchestratorMockHandlerDefinition, 'definitionHash'>;

function freezeDeep<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    Object.values(value).forEach(freezeDeep);
  }
  return value as Readonly<T>;
}

type MockHandlerInputProjection = Readonly<{
  jobCode: FaiAuditJobCode;
  jobPayloadHash: string;
}>;
type MockHandler = (input: MockHandlerInputProjection) => AiResultArtifactDraft;

function handleDocumentIngestion(_input: MockHandlerInputProjection) {
  return createSyntheticAiResultDraft('DOCUMENT_INGESTION');
}
function handleDocumentClassification(_input: MockHandlerInputProjection) {
  return createSyntheticAiResultDraft('DOCUMENT_CLASSIFICATION');
}
function handleEvidenceExtraction(_input: MockHandlerInputProjection) {
  return createSyntheticAiResultDraft('EVIDENCE_EXTRACTION');
}
function handleFinancialAnalysis(_input: MockHandlerInputProjection) {
  return createSyntheticAiResultDraft('FINANCIAL_ANALYSIS');
}
function handleCreditAnalysis(_input: MockHandlerInputProjection) {
  return createSyntheticAiResultDraft('CREDIT_ANALYSIS');
}
function handleCalculations(_input: MockHandlerInputProjection) {
  return createSyntheticAiResultDraft('CALCULATIONS');
}
function handleFindingsDrafting(_input: MockHandlerInputProjection) {
  return createSyntheticAiResultDraft('FINDINGS_DRAFTING');
}
function handleReportComposition(_input: MockHandlerInputProjection) {
  return createSyntheticAiResultDraft('REPORT_COMPOSITION');
}
function handleSchemaReview(_input: MockHandlerInputProjection) {
  return createSyntheticAiResultDraft('SCHEMA_REVIEW');
}
function handleNumericReview(_input: MockHandlerInputProjection) {
  return createSyntheticAiResultDraft('NUMERIC_REVIEW');
}
function handleSourceReview(_input: MockHandlerInputProjection) {
  return createSyntheticAiResultDraft('SOURCE_REVIEW');
}
function handleRedTeamReview(_input: MockHandlerInputProjection) {
  return createSyntheticAiResultDraft('RED_TEAM_REVIEW');
}
function handleCorrection(_input: MockHandlerInputProjection) {
  return createSyntheticAiResultDraft('CORRECTION');
}

const MOCK_HANDLERS = Object.freeze({
  DOCUMENT_INGESTION: handleDocumentIngestion,
  DOCUMENT_CLASSIFICATION: handleDocumentClassification,
  EVIDENCE_EXTRACTION: handleEvidenceExtraction,
  FINANCIAL_ANALYSIS: handleFinancialAnalysis,
  CREDIT_ANALYSIS: handleCreditAnalysis,
  CALCULATIONS: handleCalculations,
  FINDINGS_DRAFTING: handleFindingsDrafting,
  REPORT_COMPOSITION: handleReportComposition,
  SCHEMA_REVIEW: handleSchemaReview,
  NUMERIC_REVIEW: handleNumericReview,
  SOURCE_REVIEW: handleSourceReview,
  RED_TEAM_REVIEW: handleRedTeamReview,
  CORRECTION: handleCorrection,
} as const satisfies Record<FaiAuditJobCode, MockHandler>);

export function createAiOrchestratorMockHandlerDefinitionHash(
  definition: MockHandlerDefinitionIdentity,
) {
  return canonicalSha256({
    domain: 'ai.mockHandlerDefinition.v1',
    ...definition,
  });
}

function defineMockHandler(job: FaiAuditJobCode): Readonly<AiOrchestratorMockHandlerDefinition> {
  const jobDefinition = getFaiAuditJobDefinition(job);
  const capability = getAiOrchestratorWorkerCapability(job);
  const resultContract = getAiResultContract(job);
  if (!jobDefinition || !capability || !resultContract) {
    throw new Error(`Definizione mock handler incompleta per ${job}.`);
  }
  const fixture = MOCK_HANDLERS[job]({ jobCode: job, jobPayloadHash: '0'.repeat(64) });
  const identity: MockHandlerDefinitionIdentity = {
    registryCode: AI_ORCHESTRATOR_MOCK_HANDLER_REGISTRY_CODE,
    registryVersion: AI_ORCHESTRATOR_MOCK_HANDLER_REGISTRY_VERSION,
    jobCode: job,
    jobVersion: jobDefinition.jobVersion,
    jobDefinitionHash: FAI_AUDIT_JOB_DEFINITION_HASHES[job],
    capabilityCode: capability.capabilityCode,
    capabilityVersion: capability.capabilityVersion,
    capabilityHash: AI_ORCHESTRATOR_WORKER_CAPABILITY_HASHES[job],
    handlerCode: capability.handlerCode,
    handlerVersion: capability.handlerVersion,
    executorAgentCode: capability.executorAgentCode,
    executorAgentConfigVersion: capability.executorAgentConfigVersion,
    executorAgentConfigHash: capability.executorAgentConfigHash,
    inputSchemaCode: AI_ORCHESTRATOR_MOCK_HANDLER_INPUT_SCHEMA_CODE,
    inputSchemaVersion: AI_ORCHESTRATOR_MOCK_HANDLER_INPUT_SCHEMA_VERSION,
    inputSchemaHash: AI_ORCHESTRATOR_MOCK_HANDLER_INPUT_SCHEMA_HASH,
    resultContractCode: resultContract.resultContractCode,
    resultContractVersion: resultContract.resultContractVersion,
    resultContractHash: resultContract.resultContractHash,
    mockOutputFixtureHash: canonicalSha256({
      domain: 'ai.mockHandlerFixture.v1',
      jobCode: job,
      draft: fixture,
    }),
    deterministic: true,
    sideEffectsAllowed: false,
    executionMode: 'SYNCHRONOUS_PURE',
    outputStrategy: 'CONSTANT_SYNTHETIC_FIXTURE_PER_HANDLER',
    provider: 'mock',
    dataMode: 'synthetic',
    sideEffectPolicy: AI_ORCHESTRATOR_MOCK_HANDLER_SIDE_EFFECT_POLICY,
    limits: AI_ORCHESTRATOR_MOCK_HANDLER_LIMITS,
  };
  return freezeDeep({
    ...identity,
    definitionHash: createAiOrchestratorMockHandlerDefinitionHash(identity),
  });
}

export const AI_ORCHESTRATOR_MOCK_HANDLER_DEFINITIONS = Object.freeze(
  FAI_AUDIT_JOB_CODES.map(defineMockHandler),
);

const definitionByJobCode = new Map<FaiAuditJobCode, Readonly<AiOrchestratorMockHandlerDefinition>>(
  AI_ORCHESTRATOR_MOCK_HANDLER_DEFINITIONS.map((definition) => [
    definition.jobCode,
    definition,
  ]),
);
const definitionByHandlerCode = new Map<string, Readonly<AiOrchestratorMockHandlerDefinition>>(
  AI_ORCHESTRATOR_MOCK_HANDLER_DEFINITIONS.map((definition) => [
    definition.handlerCode,
    definition,
  ]),
);

export function createAiOrchestratorMockHandlerRegistryHash() {
  return canonicalSha256({
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
  });
}

export const AI_ORCHESTRATOR_MOCK_HANDLER_REGISTRY_HASH =
  createAiOrchestratorMockHandlerRegistryHash();

export function listAiOrchestratorMockHandlerDefinitions() {
  return AI_ORCHESTRATOR_MOCK_HANDLER_DEFINITIONS;
}

export function getAiOrchestratorMockHandlerDefinition(job: string) {
  return definitionByJobCode.get(job as FaiAuditJobCode) ?? null;
}

export function getAiOrchestratorMockHandlerDefinitionByCode(handlerCode: string) {
  return definitionByHandlerCode.get(handlerCode) ?? null;
}

export type AiOrchestratorMockHandlerErrorCode =
  | 'AI_MOCK_HANDLER_INVOCATION_INVALID'
  | 'AI_MOCK_HANDLER_INPUT_TOO_LARGE'
  | 'AI_MOCK_HANDLER_REGISTRY_MISMATCH'
  | 'AI_MOCK_HANDLER_DEFINITION_MISMATCH'
  | 'AI_MOCK_HANDLER_JOB_MISMATCH'
  | 'AI_MOCK_HANDLER_CAPABILITY_MISMATCH'
  | 'AI_MOCK_HANDLER_EXECUTOR_MISMATCH'
  | 'AI_MOCK_HANDLER_RESULT_CONTRACT_MISMATCH'
  | 'AI_MOCK_HANDLER_JOB_PAYLOAD_HASH_MISMATCH'
  | 'AI_MOCK_HANDLER_JOB_PAYLOAD_IDENTITY_MISMATCH'
  | 'AI_MOCK_HANDLER_ASYNC_FORBIDDEN'
  | 'AI_MOCK_HANDLER_OUTPUT_INVALID'
  | 'AI_MOCK_HANDLER_TIME_LIMIT_EXCEEDED';

export class AiOrchestratorMockHandlerError extends Error {
  readonly code: AiOrchestratorMockHandlerErrorCode;

  constructor(code: AiOrchestratorMockHandlerErrorCode) {
    super(code);
    this.name = 'AiOrchestratorMockHandlerError';
    this.code = code;
  }
}

function fail(code: AiOrchestratorMockHandlerErrorCode): never {
  throw new AiOrchestratorMockHandlerError(code);
}

function expectedBundleKey(payload: AiOrchestratorMockHandlerInvocation['jobPayload']) {
  return canonicalSha256({
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
}

function parseAndValidateInvocation(input: unknown) {
  try {
    validateAiResultJsonValue(input, AI_ORCHESTRATOR_MOCK_HANDLER_LIMITS.maxInputBytes);
  } catch (error) {
    if (error instanceof Error && /BYTES_TOO_LARGE/.test(error.message)) {
      fail('AI_MOCK_HANDLER_INPUT_TOO_LARGE');
    }
    fail('AI_MOCK_HANDLER_INVOCATION_INVALID');
  }

  let invocation: AiOrchestratorMockHandlerInvocation;
  try {
    invocation = AiOrchestratorMockHandlerInvocationSchema.parse(input);
  } catch {
    fail('AI_MOCK_HANDLER_INVOCATION_INVALID');
  }

  const definition = definitionByJobCode.get(invocation.handler.jobCode);
  if (!definition) fail('AI_MOCK_HANDLER_JOB_MISMATCH');
  if (
    invocation.registry.registryHash !== AI_ORCHESTRATOR_MOCK_HANDLER_REGISTRY_HASH
    || invocation.registry.registryCode !== AI_ORCHESTRATOR_MOCK_HANDLER_REGISTRY_CODE
    || invocation.registry.registryVersion !== AI_ORCHESTRATOR_MOCK_HANDLER_REGISTRY_VERSION
  ) fail('AI_MOCK_HANDLER_REGISTRY_MISMATCH');
  if (
    invocation.handler.definitionHash !== definition.definitionHash
    || invocation.handler.inputSchemaHash !== definition.inputSchemaHash
    || invocation.handler.handlerCode !== definition.handlerCode
    || invocation.handler.handlerVersion !== definition.handlerVersion
  ) fail('AI_MOCK_HANDLER_DEFINITION_MISMATCH');
  if (
    invocation.handler.jobCode !== definition.jobCode
    || invocation.handler.jobVersion !== definition.jobVersion
    || invocation.handler.jobDefinitionHash !== definition.jobDefinitionHash
    || invocation.jobPayload.job.jobCode !== definition.jobCode
    || invocation.jobPayload.job.jobVersion !== definition.jobVersion
    || invocation.jobPayload.job.jobDefinitionHash !== definition.jobDefinitionHash
  ) fail('AI_MOCK_HANDLER_JOB_MISMATCH');
  if (
    invocation.handler.capabilityCode !== definition.capabilityCode
    || invocation.handler.capabilityVersion !== definition.capabilityVersion
    || invocation.handler.capabilityHash !== definition.capabilityHash
  ) fail('AI_MOCK_HANDLER_CAPABILITY_MISMATCH');
  if (
    invocation.executor.agentCode !== definition.executorAgentCode
    || invocation.executor.configVersion !== definition.executorAgentConfigVersion
    || invocation.executor.configHash !== definition.executorAgentConfigHash
    || invocation.jobPayload.executor.agentId !== invocation.executor.agentId
    || invocation.jobPayload.executor.agentCode !== invocation.executor.agentCode
    || invocation.jobPayload.executor.configVersion !== invocation.executor.configVersion
    || invocation.jobPayload.executor.configHash !== invocation.executor.configHash
  ) fail('AI_MOCK_HANDLER_EXECUTOR_MISMATCH');
  if (
    invocation.handler.resultContractCode !== definition.resultContractCode
    || invocation.handler.resultContractVersion !== definition.resultContractVersion
    || invocation.handler.resultContractHash !== definition.resultContractHash
  ) fail('AI_MOCK_HANDLER_RESULT_CONTRACT_MISMATCH');
  if (canonicalSha256(invocation.jobPayload) !== invocation.jobPayloadHash) {
    fail('AI_MOCK_HANDLER_JOB_PAYLOAD_HASH_MISMATCH');
  }

  const jobDefinition = getFaiAuditJobDefinition(definition.jobCode);
  const planningRule = getFaiAuditJobPlanningRule(
    invocation.jobPayload.sourceTransition.transitionCode,
  );
  const sourceTransition = getAuditWorkflowTransition(
    invocation.jobPayload.sourceTransition.transitionCode,
  );
  const planningIndex = planningRule?.jobCodes.indexOf(definition.jobCode) ?? -1;
  const expectedSlotKey = planningIndex < 0
    ? null
    : `${String(planningIndex + 1).padStart(2, '0')}:${definition.jobCode}`;
  const phaseEntryIsCanonical = sourceTransition
    ? sourceTransition.from === sourceTransition.to
      ? invocation.jobPayload.phase.phaseEntrySequence
        < invocation.jobPayload.sourceTransition.sequence
      : invocation.jobPayload.phase.phaseEntrySequence
        === invocation.jobPayload.sourceTransition.sequence
    : false;
  const correctionCycleIsCanonical = ['WF-015', 'WF-016'].includes(
    invocation.jobPayload.sourceTransition.transitionCode,
  )
    ? invocation.jobPayload.phase.correctionCycle >= 1
      && invocation.jobPayload.phase.correctionCycle <= FAI_AUDIT_MAX_CORRECTION_CYCLES
    : invocation.jobPayload.phase.correctionCycle === 0;
  if (
    !jobDefinition
    || planningIndex < 0
    || !sourceTransition
    || invocation.jobPayload.sourceTransition.sourceState !== sourceTransition.from
    || invocation.jobPayload.sourceTransition.targetState !== sourceTransition.to
    || invocation.jobPayload.phase.phaseCode !== invocation.jobPayload.sourceTransition.targetState
    || !phaseEntryIsCanonical
    || invocation.jobPayload.sourceTransition.sourceStateVersion
      !== invocation.jobPayload.sourceTransition.sequence
    || !correctionCycleIsCanonical
    || invocation.jobPayload.job.completionTransitionCode
      !== jobDefinition.completionTransitionCode
    || invocation.jobPayload.job.completionMode !== jobDefinition.completionMode
    || invocation.jobPayload.job.bundleCode !== jobDefinition.bundleCode
    || invocation.jobPayload.job.bundleKey !== expectedBundleKey(invocation.jobPayload)
    || invocation.jobPayload.job.slotKey !== expectedSlotKey
    || invocation.jobPayload.job.provider !== 'mock'
    || invocation.jobPayload.workflow.dataMode !== 'synthetic'
    || invocation.jobPayload.job.automaticDispatchAllowed !== false
    || invocation.provider !== 'mock'
    || invocation.dataMode !== 'synthetic'
  ) fail('AI_MOCK_HANDLER_JOB_PAYLOAD_IDENTITY_MISMATCH');

  return { invocation: freezeDeep(invocation), definition };
}

function expectedDedupeKey(payload: AiOrchestratorMockHandlerInvocation['jobPayload']) {
  return canonicalSha256({
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
    executorAgentId: payload.executor.agentId,
    executorAgentCode: payload.executor.agentCode,
    executorAgentConfigVersion: payload.executor.configVersion,
    executorAgentConfigHash: payload.executor.configHash,
    jobKey: `${payload.job.jobCode}@${payload.job.jobVersion}`,
    slotKey: payload.job.slotKey,
  });
}

function intentMatchesInvocation(
  intent: FaiAuditJobIntent,
  invocation: AiOrchestratorMockHandlerInvocation,
) {
  const payload = invocation.jobPayload;
  return intent.catalogCode === FAI_AUDIT_JOB_CATALOG_CODE
    && intent.catalogVersion === FAI_AUDIT_JOB_CATALOG_VERSION
    && intent.catalogHash === FAI_AUDIT_JOB_CATALOG_HASH
    && intent.workflowDefinitionHash === payload.workflow.workflowDefinitionHash
    && intent.phaseCode === payload.phase.phaseCode
    && intent.phaseEntrySequence === payload.phase.phaseEntrySequence
    && intent.sourceState === payload.sourceTransition.sourceState
    && intent.sourceStateVersion === payload.sourceTransition.sourceStateVersion
    && intent.correctionCycle === payload.phase.correctionCycle
    && intent.executorAgentId === payload.executor.agentId
    && intent.executorAgentCode === payload.executor.agentCode
    && intent.executorAgentConfigVersion === payload.executor.configVersion
    && intent.executorAgentConfigHash === payload.executor.configHash
    && intent.jobCode === payload.job.jobCode
    && intent.jobVersion === payload.job.jobVersion
    && intent.jobDefinitionHash === payload.job.jobDefinitionHash
    && intent.completionTransitionCode === payload.job.completionTransitionCode
    && intent.completionMode === payload.job.completionMode
    && intent.slotKey === payload.job.slotKey
    && intent.bundleCode === payload.job.bundleCode
    && intent.bundleKey === payload.job.bundleKey
    && intent.dedupeKey === expectedDedupeKey(payload)
    && intent.provider === payload.job.provider
    && intent.dataMode === payload.workflow.dataMode
    && intent.automaticDispatchAllowed === payload.job.automaticDispatchAllowed
    && intent.availableAt === payload.job.availableAt
    && intent.payloadHash === invocation.jobPayloadHash
    && canonicalSha256(intent.payload) === invocation.jobPayloadHash;
}

export function createAiOrchestratorMockHandlerInvocation(
  intent: FaiAuditJobIntent,
): Readonly<AiOrchestratorMockHandlerInvocation> {
  const definition = definitionByJobCode.get(intent.jobCode);
  if (!definition) fail('AI_MOCK_HANDLER_JOB_MISMATCH');
  const parsed = parseAndValidateInvocation({
    schemaVersion: 1,
    registry: {
      registryCode: AI_ORCHESTRATOR_MOCK_HANDLER_REGISTRY_CODE,
      registryVersion: AI_ORCHESTRATOR_MOCK_HANDLER_REGISTRY_VERSION,
      registryHash: AI_ORCHESTRATOR_MOCK_HANDLER_REGISTRY_HASH,
    },
    handler: {
      definitionHash: definition.definitionHash,
      inputSchemaHash: definition.inputSchemaHash,
      jobCode: intent.jobCode,
      jobVersion: intent.jobVersion,
      jobDefinitionHash: intent.jobDefinitionHash,
      capabilityCode: definition.capabilityCode,
      capabilityVersion: definition.capabilityVersion,
      capabilityHash: definition.capabilityHash,
      handlerCode: definition.handlerCode,
      handlerVersion: definition.handlerVersion,
      resultContractCode: definition.resultContractCode,
      resultContractVersion: definition.resultContractVersion,
      resultContractHash: definition.resultContractHash,
    },
    executor: {
      agentId: intent.executorAgentId,
      agentCode: intent.executorAgentCode,
      configVersion: intent.executorAgentConfigVersion,
      configHash: intent.executorAgentConfigHash,
    },
    jobPayload: intent.payload,
    jobPayloadHash: intent.payloadHash,
    provider: intent.provider,
    dataMode: intent.dataMode,
  });
  if (!intentMatchesInvocation(intent, parsed.invocation)) {
    fail('AI_MOCK_HANDLER_JOB_PAYLOAD_IDENTITY_MISMATCH');
  }
  return parsed.invocation;
}

function validationProvenance(
  invocation: AiOrchestratorMockHandlerInvocation,
): AiResultProvenance {
  return {
    runtimeId: 'synthetic-mock-runtime',
    jobId: 'synthetic-mock-job',
    attemptId: 'synthetic-mock-attempt',
    attemptSequence: 1,
    fencingToken: '1',
    workerInstanceId: 'synthetic-mock-handler-registry',
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

export function executeAiOrchestratorMockHandler(
  input: unknown,
): Readonly<AiResultArtifactDraft> {
  const { invocation, definition } = parseAndValidateInvocation(input);
  const started = performance.now();
  const handler = MOCK_HANDLERS[definition.jobCode];
  const draft = handler(freezeDeep({
    jobCode: definition.jobCode,
    jobPayloadHash: invocation.jobPayloadHash,
  }));
  if (
    draft
    && typeof draft === 'object'
    && 'then' in draft
    && typeof (draft as { then?: unknown }).then === 'function'
  ) fail('AI_MOCK_HANDLER_ASYNC_FORBIDDEN');

  if (canonicalSha256({
    domain: 'ai.mockHandlerFixture.v1',
    jobCode: definition.jobCode,
    draft,
  }) !== definition.mockOutputFixtureHash) {
    fail('AI_MOCK_HANDLER_OUTPUT_INVALID');
  }

  let validated: ReturnType<typeof validateAndHashAiResultDraft>;
  try {
    validated = validateAndHashAiResultDraft(
      definition.jobCode,
      draft,
      validationProvenance(invocation),
    );
  } catch {
    fail('AI_MOCK_HANDLER_OUTPUT_INVALID');
  }
  if (validated.totalPayloadBytes > definition.limits.maxOutputPayloadBytes) {
    fail('AI_MOCK_HANDLER_OUTPUT_INVALID');
  }
  if (performance.now() - started > definition.limits.maxObservedExecutionMs) {
    fail('AI_MOCK_HANDLER_TIME_LIMIT_EXCEEDED');
  }
  return freezeDeep(structuredClone(draft));
}

export function getAiOrchestratorMockHandlerRegistryInvariantErrors() {
  const errors: string[] = [];
  if (AI_ORCHESTRATOR_MOCK_HANDLER_DEFINITIONS.length !== FAI_AUDIT_JOB_CODES.length) {
    errors.push('Il registry non copre tutti i job canonici.');
  }
  if (definitionByJobCode.size !== AI_ORCHESTRATOR_MOCK_HANDLER_DEFINITIONS.length) {
    errors.push('Job code duplicato nel registry mock.');
  }
  if (definitionByHandlerCode.size !== AI_ORCHESTRATOR_MOCK_HANDLER_DEFINITIONS.length) {
    errors.push('Handler code duplicato nel registry mock.');
  }
  for (const definition of AI_ORCHESTRATOR_MOCK_HANDLER_DEFINITIONS) {
    const { definitionHash, ...identityForHash } = definition;
    if (
      createAiOrchestratorMockHandlerDefinitionHash(identityForHash) !== definitionHash
      || !HASH_RE.test(definitionHash)
      || definition.provider !== 'mock'
      || definition.dataMode !== 'synthetic'
      || definition.deterministic !== true
      || definition.sideEffectsAllowed !== false
      || Object.values(definition.sideEffectPolicy).some((allowed) => allowed !== false)
      || definition.limits.maxOutputPayloadBytes !== AI_RESULT_LIMITS.maxResultBytes
    ) errors.push(`${definition.jobCode} viola gli invariant del registry mock.`);
  }
  if (
    !HASH_RE.test(AI_ORCHESTRATOR_MOCK_HANDLER_REGISTRY_HASH)
    || createAiOrchestratorMockHandlerRegistryHash()
      !== AI_ORCHESTRATOR_MOCK_HANDLER_REGISTRY_HASH
  ) errors.push('Hash del registry mock non valido.');
  return errors;
}
