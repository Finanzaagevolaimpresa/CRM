import { canonicalSha256 } from '../canonical-json';
import {
  AI_ORCHESTRATOR_MOCK_HANDLER_REGISTRY_CODE,
  AI_ORCHESTRATOR_MOCK_HANDLER_REGISTRY_HASH,
  AI_ORCHESTRATOR_MOCK_HANDLER_REGISTRY_VERSION,
} from './mock-handler-registry-v1';
import { AI_RESULT_CONTRACT_CATALOG_HASH } from './result-artifact-contract-v1';
import {
  AI_ORCHESTRATOR_WORKER_RUNTIME_POLICY_CODE,
  AI_ORCHESTRATOR_WORKER_RUNTIME_POLICY_HASH,
  AI_ORCHESTRATOR_WORKER_RUNTIME_POLICY_VERSION,
} from './worker-runtime-policy-v1';

export const AI_MOCK_EXECUTION_RESULT_WIRING_CODE =
  'FAI-AI-ORCHESTRATOR-MOCK-EXECUTION-RESULT-WIRING' as const;
export const AI_MOCK_EXECUTION_RESULT_WIRING_VERSION = '1.0' as const;
export const AI_MOCK_EXECUTION_RESULT_WIRING_KEY =
  `${AI_MOCK_EXECUTION_RESULT_WIRING_CODE}@${AI_MOCK_EXECUTION_RESULT_WIRING_VERSION}` as const;

export const AI_MOCK_EXECUTION_RESULT_WIRING_MANIFEST = Object.freeze({
  schemaVersion: 1,
  contractCode: AI_MOCK_EXECUTION_RESULT_WIRING_CODE,
  contractVersion: AI_MOCK_EXECUTION_RESULT_WIRING_VERSION,
  contractKey: AI_MOCK_EXECUTION_RESULT_WIRING_KEY,
  activationEpoch: 'FOUNDATION_LOCKED_V1',
  operational: false,
  productionComposition: Object.freeze({ canAcceptLease: false, consumer: 'NONE' }),
  provider: 'mock',
  dataMode: 'synthetic',
  runtimePolicy: Object.freeze({ code: AI_ORCHESTRATOR_WORKER_RUNTIME_POLICY_CODE, version: AI_ORCHESTRATOR_WORKER_RUNTIME_POLICY_VERSION, hash: AI_ORCHESTRATOR_WORKER_RUNTIME_POLICY_HASH }),
  handlerRegistry: Object.freeze({ code: AI_ORCHESTRATOR_MOCK_HANDLER_REGISTRY_CODE, version: AI_ORCHESTRATOR_MOCK_HANDLER_REGISTRY_VERSION, hash: AI_ORCHESTRATOR_MOCK_HANDLER_REGISTRY_HASH }),
  resultContractCatalogHash: AI_RESULT_CONTRACT_CATALOG_HASH,
  implementedOperations: Object.freeze(['PREFLIGHT_READ_ONLY', 'INVOKE_CANONICAL_MOCK_HANDLER', 'COMPLETE_FENCED', 'FAIL_FENCED'] as const),
  authority: Object.freeze({ recheckBeforeFirstPreflight: true, recheckAfterHandler: true, recheckBeforeSecondPreflight: true, adminAuthorityAtomicWithCompletion: false, sufficientForProductionActivation: false }),
  leaseAndFencing: Object.freeze({ preflightCount: 2, databaseTimeAuthoritative: true, completionIsFinalBarrier: true }),
  replay: Object.freeze({ policy: 'SAME_ATTEMPT_SAME_RESULT_HASH_ONLY' }),
  concurrency: Object.freeze({ consumeSingleFlightPerLease: true, overlappingLeaseMutatorsAllowed: false, surrenderRequestsDrainFirst: true }),
  failureMapping: Object.freeze({ policyViolation: 'POLICY_HASH_MISMATCH', explicitlyClassifiedTransient: 'MOCK_HANDLER_TRANSIENT', structuralIneligibility: 'DATABASE_DERIVED_SUPERSEDED', authorityOrCapabilityDenied: 'SURRENDER', draining: 'SURRENDER', staleLease: 'RECOVERY_OWNED' }),
  sideEffects: Object.freeze({
    callerSuppliedPayloadAllowed: false,
    callerSuppliedResultDraftAllowed: false,
    dynamicHandlerResolutionAllowed: false,
    workflowTransitionWriteAllowed: false,
    aiRunWriteAllowed: false,
    aiOutputWriteAllowed: false,
    crmDataAccessAllowed: false,
    externalNetworkAllowed: false,
    filesystemAccessAllowed: false,
    childProcessAllowed: false,
    workerThreadAllowed: false,
  }),
} as const);

export function createAiMockExecutionResultWiringHashV1() {
  return canonicalSha256({ domain: 'ai.mockExecutionResultWiringManifest.v1', manifest: AI_MOCK_EXECUTION_RESULT_WIRING_MANIFEST });
}

export const AI_MOCK_EXECUTION_RESULT_WIRING_HASH = createAiMockExecutionResultWiringHashV1();
