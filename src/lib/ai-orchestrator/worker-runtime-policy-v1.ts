import { canonicalSha256 } from '../canonical-json';
import {
  FAI_AUDIT_JOB_CATALOG_HASH,
  FAI_AUDIT_JOB_CATALOG_KEY,
  FAI_AUDIT_JOB_CODES,
  FAI_AUDIT_JOB_DEFINITION_HASHES,
  getFaiAuditExecutorBinding,
  type FaiAuditJobCode,
} from './job-catalog-v1';

export const AI_ORCHESTRATOR_WORKER_RUNTIME_POLICY_CODE = 'FAI-AUDIT-WORKER-RUNTIME-POLICY' as const;
export const AI_ORCHESTRATOR_WORKER_RUNTIME_POLICY_VERSION = '1.0' as const;
export const AI_ORCHESTRATOR_WORKER_RUNTIME_POLICY_KEY =
  `${AI_ORCHESTRATOR_WORKER_RUNTIME_POLICY_CODE}@${AI_ORCHESTRATOR_WORKER_RUNTIME_POLICY_VERSION}` as const;

export const AI_ORCHESTRATOR_WORKER_RUNTIME_LIMITS = Object.freeze({
  leaseDurationMs: 120_000,
  heartbeatIntervalMs: 30_000,
  maxAttemptDurationMs: 600_000,
  maxRetryableFailures: 3,
  retryBaseDelayMs: 30_000,
  retryMaxDelayMs: 900_000,
  retryJitterBasisPoints: 2_000,
  maxConcurrentGlobal: 1,
  maxConcurrentPerWorkflow: 1,
  maxConcurrentPerExecutorConfig: 1,
  outboxAdmissionBatchSize: 25,
  leaseRecoveryBatchSize: 25,
} as const);

export const AI_ORCHESTRATOR_RETRYABLE_FAILURE_CODES = Object.freeze([
  'LEASE_EXPIRED',
  'MOCK_HANDLER_TRANSIENT',
  'WORKER_TRANSIENT',
] as const);

export const AI_ORCHESTRATOR_TERMINAL_FAILURE_CODES = Object.freeze([
  'CAPABILITY_DENIED',
  'CONFIG_HASH_MISMATCH',
  'EXECUTOR_INACTIVE',
  'HUMAN_APPROVAL_REACHED',
  'JOB_BLOCKED',
  'NON_MOCK_PROVIDER',
  'PHASE_SUPERSEDED',
  'POLICY_HASH_MISMATCH',
] as const);

export type AiOrchestratorRetryableFailureCode = typeof AI_ORCHESTRATOR_RETRYABLE_FAILURE_CODES[number];
export type AiOrchestratorTerminalFailureCode = typeof AI_ORCHESTRATOR_TERMINAL_FAILURE_CODES[number];
export type AiOrchestratorFailureCode = AiOrchestratorRetryableFailureCode | AiOrchestratorTerminalFailureCode;

export interface AiOrchestratorWorkerCapability {
  readonly capabilityCode: string;
  readonly capabilityVersion: '1.0';
  readonly jobCode: FaiAuditJobCode;
  readonly jobVersion: '1.0';
  readonly jobDefinitionHash: string;
  readonly executorAgentCode: string;
  readonly executorAgentConfigVersion: 1;
  readonly executorAgentConfigHash: string;
  readonly handlerCode: string;
  readonly handlerVersion: '1.0';
  readonly provider: 'mock';
  readonly dataMode: 'synthetic';
  readonly networkAccessAllowed: false;
  readonly crmDataAccessAllowed: false;
  readonly providerCallAllowed: false;
  readonly workflowTransitionWriteAllowed: false;
}

function defineCapability(jobCode: FaiAuditJobCode): Readonly<AiOrchestratorWorkerCapability> {
  const executor = getFaiAuditExecutorBinding(jobCode);
  if (!executor) throw new Error(`Executor canonico mancante per ${jobCode}.`);
  return Object.freeze({
    capabilityCode: `FAI_AUDIT_${jobCode}_MOCK`,
    capabilityVersion: '1.0',
    jobCode,
    jobVersion: '1.0',
    jobDefinitionHash: FAI_AUDIT_JOB_DEFINITION_HASHES[jobCode],
    executorAgentCode: executor.executorAgentCode,
    executorAgentConfigVersion: executor.executorAgentConfigVersion,
    executorAgentConfigHash: executor.executorAgentConfigHash,
    handlerCode: `FAI_AUDIT_${jobCode}_MOCK_HANDLER`,
    handlerVersion: '1.0',
    provider: 'mock',
    dataMode: 'synthetic',
    networkAccessAllowed: false,
    crmDataAccessAllowed: false,
    providerCallAllowed: false,
    workflowTransitionWriteAllowed: false,
  });
}

export const AI_ORCHESTRATOR_WORKER_CAPABILITIES = Object.freeze(
  FAI_AUDIT_JOB_CODES.map(defineCapability),
);

const capabilityByJobCode = new Map<FaiAuditJobCode, Readonly<AiOrchestratorWorkerCapability>>(
  AI_ORCHESTRATOR_WORKER_CAPABILITIES.map((capability) => [capability.jobCode, capability]),
);

export function getAiOrchestratorWorkerCapability(jobCode: string) {
  return capabilityByJobCode.get(jobCode as FaiAuditJobCode) ?? null;
}

export function createAiOrchestratorWorkerCapabilityHash(capability: AiOrchestratorWorkerCapability) {
  return canonicalSha256({
    schemaVersion: 1,
    runtimePolicyKey: AI_ORCHESTRATOR_WORKER_RUNTIME_POLICY_KEY,
    jobCatalogKey: FAI_AUDIT_JOB_CATALOG_KEY,
    jobCatalogHash: FAI_AUDIT_JOB_CATALOG_HASH,
    capability,
  });
}

export const AI_ORCHESTRATOR_WORKER_CAPABILITY_HASHES = Object.freeze(Object.fromEntries(
  AI_ORCHESTRATOR_WORKER_CAPABILITIES.map((capability) => [
    capability.jobCode,
    createAiOrchestratorWorkerCapabilityHash(capability),
  ]),
) as Readonly<Record<FaiAuditJobCode, string>>);

export function createAiOrchestratorWorkerRuntimePolicyHash() {
  return canonicalSha256({
    schemaVersion: 1,
    policyCode: AI_ORCHESTRATOR_WORKER_RUNTIME_POLICY_CODE,
    policyVersion: AI_ORCHESTRATOR_WORKER_RUNTIME_POLICY_VERSION,
    jobCatalogKey: FAI_AUDIT_JOB_CATALOG_KEY,
    jobCatalogHash: FAI_AUDIT_JOB_CATALOG_HASH,
    limits: AI_ORCHESTRATOR_WORKER_RUNTIME_LIMITS,
    retryableFailureCodes: AI_ORCHESTRATOR_RETRYABLE_FAILURE_CODES,
    terminalFailureCodes: AI_ORCHESTRATOR_TERMINAL_FAILURE_CODES,
    capabilities: AI_ORCHESTRATOR_WORKER_CAPABILITIES,
  });
}

export const AI_ORCHESTRATOR_WORKER_RUNTIME_POLICY_HASH = createAiOrchestratorWorkerRuntimePolicyHash();

export function calculateAiOrchestratorRetryDelayMs(input: {
  jobId: string;
  fencingToken: bigint | number | string;
  retryFailureCount: number;
}) {
  const failureNumber = Math.max(1, Math.trunc(input.retryFailureCount));
  const exponential = Math.min(
    AI_ORCHESTRATOR_WORKER_RUNTIME_LIMITS.retryMaxDelayMs,
    AI_ORCHESTRATOR_WORKER_RUNTIME_LIMITS.retryBaseDelayMs * (2 ** (failureNumber - 1)),
  );
  const entropy = canonicalSha256({
    schemaVersion: 1,
    runtimePolicyHash: AI_ORCHESTRATOR_WORKER_RUNTIME_POLICY_HASH,
    jobId: input.jobId,
    fencingToken: String(input.fencingToken),
    retryFailureCount: failureNumber,
  });
  const sample = Number.parseInt(entropy.slice(0, 8), 16) / 0xffffffff;
  const jitter = Math.floor(
    exponential
      * (AI_ORCHESTRATOR_WORKER_RUNTIME_LIMITS.retryJitterBasisPoints / 10_000)
      * sample,
  );
  return exponential + jitter;
}

export function getAiOrchestratorWorkerRuntimePolicyInvariantErrors() {
  const errors: string[] = [];
  if (AI_ORCHESTRATOR_WORKER_CAPABILITIES.length !== FAI_AUDIT_JOB_CODES.length) {
    errors.push('Il catalogo capability non copre tutti i job canonici.');
  }
  if (new Set(AI_ORCHESTRATOR_WORKER_CAPABILITIES.map(({ jobCode }) => jobCode)).size
    !== AI_ORCHESTRATOR_WORKER_CAPABILITIES.length) {
    errors.push('Job code duplicato nel catalogo capability.');
  }
  for (const capability of AI_ORCHESTRATOR_WORKER_CAPABILITIES) {
    if (
      capability.provider !== 'mock'
      || capability.dataMode !== 'synthetic'
      || capability.networkAccessAllowed !== false
      || capability.crmDataAccessAllowed !== false
      || capability.providerCallAllowed !== false
      || capability.workflowTransitionWriteAllowed !== false
    ) errors.push(`${capability.jobCode} viola il confine fail-closed.`);
    if (!/^[0-9a-f]{64}$/.test(AI_ORCHESTRATOR_WORKER_CAPABILITY_HASHES[capability.jobCode])) {
      errors.push(`${capability.jobCode} ha un hash capability non valido.`);
    }
  }
  if (!/^[0-9a-f]{64}$/.test(AI_ORCHESTRATOR_WORKER_RUNTIME_POLICY_HASH)) {
    errors.push('Hash della runtime policy non valido.');
  }
  return errors;
}
