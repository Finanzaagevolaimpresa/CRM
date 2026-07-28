import { canonicalSha256 } from '../canonical-json';
import {
  AI_ORCHESTRATOR_MOCK_HANDLER_INPUT_SCHEMA_HASH,
  AI_ORCHESTRATOR_MOCK_HANDLER_REGISTRY_CODE,
  AI_ORCHESTRATOR_MOCK_HANDLER_REGISTRY_HASH,
  AI_ORCHESTRATOR_MOCK_HANDLER_REGISTRY_VERSION,
  AiOrchestratorMockHandlerError,
  createAiOrchestratorMockHandlerInvocation,
  executeAiOrchestratorMockHandler,
  createAiOrchestratorMockHandlerRegistryHash,
  getAiOrchestratorMockHandlerDefinition,
} from './mock-handler-registry-v1';
import { AI_RESULT_CONTRACT_CATALOG_HASH, getAiResultContract } from './result-artifact-contract-v1';
import {
  AI_ORCHESTRATOR_WORKER_CAPABILITY_HASHES,
  AI_ORCHESTRATOR_WORKER_RUNTIME_POLICY_CODE,
  AI_ORCHESTRATOR_WORKER_RUNTIME_POLICY_HASH,
  AI_ORCHESTRATOR_WORKER_RUNTIME_POLICY_VERSION,
  getAiOrchestratorWorkerCapability,
} from './worker-runtime-policy-v1';
import {
  AiOrchestratorPersistedJobPolicyMismatchError,
  type AiWorkflowJobExecutionPreflight,
} from './worker-runtime';
import type { FaiAuditJobCode } from './job-catalog-v1';
import {
  AI_MOCK_EXECUTION_RESULT_WIRING_CODE,
  AI_MOCK_EXECUTION_RESULT_WIRING_HASH,
  AI_MOCK_EXECUTION_RESULT_WIRING_MANIFEST,
  AI_MOCK_EXECUTION_RESULT_WIRING_VERSION,
  createAiMockExecutionResultWiringHashV1,
} from './mock-execution-result-wiring-contract-v1';

export const AI_MOCK_EXECUTION_ERROR_CODES = Object.freeze([
  'AI_MOCK_EXECUTION_AUTHORITY_DENIED', 'AI_MOCK_EXECUTION_CAPABILITY_DENIED',
  'AI_MOCK_EXECUTION_DRAINING', 'AI_MOCK_EXECUTION_LEASE_STALE',
  'AI_MOCK_EXECUTION_POLICY_MISMATCH', 'AI_MOCK_EXECUTION_DB_TRANSIENT',
  'AI_MOCK_EXECUTION_DB_UNAVAILABLE', 'AI_MOCK_EXECUTION_INVARIANT_VIOLATION',
] as const);
export type AiMockExecutionErrorCode = typeof AI_MOCK_EXECUTION_ERROR_CODES[number];
export class AiMockExecutionError extends Error {
  constructor(readonly code: AiMockExecutionErrorCode) { super(code); this.name = 'AiMockExecutionError'; }
}

export type AiMockExecutionOutcome = Readonly<{
  state: 'SUCCEEDED' | 'SUPERSEDED' | 'FAILED_TERMINAL' | 'RETRY_WAIT';
  replay?: boolean;
  resultHash?: string;
}>;

export interface AiMockExecutionPortsV1 {
  readAuthority(): Promise<Readonly<{ allowed: boolean; capabilityAllowed: boolean }>>;
  preflight(): Promise<AiWorkflowJobExecutionPreflight>;
  complete(draft: ReturnType<typeof executeAiOrchestratorMockHandler>): Promise<AiMockExecutionOutcome>;
  fail(code: 'POLICY_HASH_MISMATCH' | 'MOCK_HANDLER_TRANSIENT'): Promise<AiMockExecutionOutcome>;
  isDrainRequested(): boolean;
  assertClaimMatches(snapshot: AiWorkflowJobExecutionPreflight): void;
  explicitlyClassifyTransient?(error: unknown): boolean;
}

function deny(code: AiMockExecutionErrorCode): never { throw new AiMockExecutionError(code); }
function assertAuthority(authority: Readonly<{ allowed: boolean; capabilityAllowed: boolean }>) {
  if (!authority.allowed) deny('AI_MOCK_EXECUTION_AUTHORITY_DENIED');
  if (!authority.capabilityAllowed) deny('AI_MOCK_EXECUTION_CAPABILITY_DENIED');
}
function assertNotDraining(ports: AiMockExecutionPortsV1) {
  if (ports.isDrainRequested()) deny('AI_MOCK_EXECUTION_DRAINING');
}

function assertCanonical(snapshot: AiWorkflowJobExecutionPreflight) {
  const jobCode = snapshot.intent.jobCode as FaiAuditJobCode;
  const capability = getAiOrchestratorWorkerCapability(jobCode);
  const handler = getAiOrchestratorMockHandlerDefinition(jobCode);
  const contract = getAiResultContract(jobCode);
  if (
    snapshot.runtimePolicyCode !== AI_ORCHESTRATOR_WORKER_RUNTIME_POLICY_CODE
    || snapshot.runtimePolicyVersion !== AI_ORCHESTRATOR_WORKER_RUNTIME_POLICY_VERSION
    || snapshot.runtimePolicyHash !== AI_ORCHESTRATOR_WORKER_RUNTIME_POLICY_HASH
    || !capability || snapshot.capabilityCode !== capability.capabilityCode
    || snapshot.capabilityVersion !== capability.capabilityVersion
    || snapshot.capabilityHash !== AI_ORCHESTRATOR_WORKER_CAPABILITY_HASHES[jobCode]
    || !handler || snapshot.handlerCode !== handler.handlerCode
    || snapshot.handlerVersion !== handler.handlerVersion
    || handler.inputSchemaHash !== AI_ORCHESTRATOR_MOCK_HANDLER_INPUT_SCHEMA_HASH
    || handler.capabilityHash !== snapshot.capabilityHash
    || handler.jobDefinitionHash !== snapshot.intent.jobDefinitionHash
    || handler.executorAgentCode !== snapshot.intent.executorAgentCode
    || handler.executorAgentConfigHash !== snapshot.intent.executorAgentConfigHash
    || !contract || handler.resultContractCode !== contract.resultContractCode
    || handler.resultContractVersion !== contract.resultContractVersion
    || handler.resultContractHash !== contract.resultContractHash
    || AI_ORCHESTRATOR_MOCK_HANDLER_REGISTRY_CODE !== 'FAI-AUDIT-MOCK-HANDLER-REGISTRY'
    || AI_ORCHESTRATOR_MOCK_HANDLER_REGISTRY_VERSION !== '1.0'
    || AI_MOCK_EXECUTION_RESULT_WIRING_CODE !== 'FAI-AI-ORCHESTRATOR-MOCK-EXECUTION-RESULT-WIRING'
    || AI_MOCK_EXECUTION_RESULT_WIRING_VERSION !== '1.0'
    || AI_MOCK_EXECUTION_RESULT_WIRING_HASH !== createAiMockExecutionResultWiringHashV1()
    || AI_ORCHESTRATOR_MOCK_HANDLER_REGISTRY_HASH !== createAiOrchestratorMockHandlerRegistryHash()
    || AI_RESULT_CONTRACT_CATALOG_HASH !== AI_MOCK_EXECUTION_RESULT_WIRING_MANIFEST.resultContractCatalogHash
    || canonicalSha256(snapshot.intent.payload) !== snapshot.intent.payloadHash
  ) deny('AI_MOCK_EXECUTION_POLICY_MISMATCH');
}

/** Factory-scoped orchestration; callers cannot supply operational identities or handler callbacks. */
export function createAiMockExecutionOperationV1(ports: AiMockExecutionPortsV1) {
  const failUnlessDraining = (code: 'POLICY_HASH_MISMATCH' | 'MOCK_HANDLER_TRANSIENT') => {
    // This check intentionally lives immediately next to the write. A preflight,
    // validation, or handler failure is not authority to terminalize after drain.
    assertNotDraining(ports);
    return ports.fail(code);
  };
  return async (): Promise<AiMockExecutionOutcome> => {
    assertNotDraining(ports);
    assertAuthority(await ports.readAuthority());
    let first: AiWorkflowJobExecutionPreflight;
    try { first = await ports.preflight(); }
    catch (error) {
      if (error instanceof AiOrchestratorPersistedJobPolicyMismatchError) return failUnlessDraining('POLICY_HASH_MISMATCH');
      throw error;
    }
    ports.assertClaimMatches(first);
    try { assertCanonical(first); }
    catch (error) {
      if (error instanceof AiMockExecutionError && error.code === 'AI_MOCK_EXECUTION_POLICY_MISMATCH') {
        return failUnlessDraining('POLICY_HASH_MISMATCH');
      }
      throw error;
    }
    assertNotDraining(ports);
    let draft: ReturnType<typeof executeAiOrchestratorMockHandler>;
    try {
      draft = executeAiOrchestratorMockHandler(createAiOrchestratorMockHandlerInvocation(first.intent));
    } catch (error) {
      if (ports.explicitlyClassifyTransient?.(error)) return failUnlessDraining('MOCK_HANDLER_TRANSIENT');
      if (error instanceof AiOrchestratorMockHandlerError || error instanceof TypeError) {
        return failUnlessDraining('POLICY_HASH_MISMATCH');
      }
      deny('AI_MOCK_EXECUTION_INVARIANT_VIOLATION');
    }
    assertNotDraining(ports);
    assertAuthority(await ports.readAuthority());
    let second: AiWorkflowJobExecutionPreflight;
    try { second = await ports.preflight(); }
    catch (error) {
      if (error instanceof AiOrchestratorPersistedJobPolicyMismatchError) return failUnlessDraining('POLICY_HASH_MISMATCH');
      throw error;
    }
    ports.assertClaimMatches(second);
    try { assertCanonical(second); }
    catch (error) {
      if (error instanceof AiMockExecutionError && error.code === 'AI_MOCK_EXECUTION_POLICY_MISMATCH') {
        return failUnlessDraining('POLICY_HASH_MISMATCH');
      }
      throw error;
    }
    if (canonicalSha256(first) !== canonicalSha256(second)) deny('AI_MOCK_EXECUTION_LEASE_STALE');
    assertNotDraining(ports);
    return ports.complete(draft);
  };
}
