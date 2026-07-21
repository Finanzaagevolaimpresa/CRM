import { z } from 'zod';
import { canonicalSha256 } from '../canonical-json';
import type { Permission } from '../permissions';
import {
  FAI_AUDIT_WORKFLOW_DEFINITION_HASH,
  FAI_AUDIT_WORKFLOW_ID,
} from './audit-workflow-v1-1';
import {
  FAI_AUDIT_JOB_CODES,
  FAI_AUDIT_JOB_DEFINITION_HASHES,
  FAI_AUDIT_JOB_EXECUTOR_BINDINGS,
} from './job-catalog-v1';
import {
  AI_ORCHESTRATOR_WORKER_CAPABILITIES,
  AI_ORCHESTRATOR_WORKER_CAPABILITY_HASHES,
} from './worker-runtime-policy-v1';

export const AI_ORCHESTRATOR_ADMIN_POLICY_SCHEMA_VERSION = 1 as const;
export const AI_ORCHESTRATOR_ADMIN_POLICY_VERSION = '1.0' as const;
export const AI_ORCHESTRATOR_ADMIN_ACTIVATION_EPOCH = 'FOUNDATION_LOCKED_V1' as const;
export const AI_ORCHESTRATOR_ADMIN_GLOBAL_POLICY_CODE = 'AI_ORCHESTRATOR_ADMIN_GLOBAL_POLICY' as const;
export const AI_ORCHESTRATOR_ADMIN_SCOPE_POLICY_CODE = 'AI_ORCHESTRATOR_ADMIN_SCOPE_POLICY' as const;
export const AI_ORCHESTRATOR_ADMIN_CONTROL_REQUEST_DOMAIN = 'AI_ORCHESTRATOR_ADMIN_CONTROL_REQUEST' as const;
export const AI_ORCHESTRATOR_ADMIN_POLICY_LEDGER_CODE = 'AI_ORCHESTRATOR_ADMIN_POLICY_LEDGER' as const;
export const AI_ORCHESTRATOR_ADMIN_GLOBAL_SCOPE_CODE = 'global' as const;
export const AI_ORCHESTRATOR_ADMIN_FOUNDATION_REASON_CODE = 'FOUNDATION_BOOTSTRAP' as const;
export const AI_ORCHESTRATOR_ADMIN_FOUNDATION_REASON = 'Bootstrap fail-closed Admin Control Plane Foundation v1.' as const;
export const AI_ORCHESTRATOR_ADMIN_EMERGENCY_STOP_INTENT_HASH = canonicalSha256({
  schemaVersion: 1,
  reducerCode: 'AI_ORCHESTRATOR_ADMIN_EMERGENCY_STOP_REDUCER',
  reducerVersion: '1.0',
});

export const AI_ORCHESTRATOR_ADMIN_SCOPE_TYPES = Object.freeze([
  'GLOBAL',
  'PROVIDER',
  'AGENT',
  'CAPABILITY',
  'JOB',
  'WORKFLOW',
] as const);

export const AI_ORCHESTRATOR_ADMIN_NON_GLOBAL_SCOPE_TYPES = Object.freeze([
  'PROVIDER',
  'AGENT',
  'CAPABILITY',
  'JOB',
  'WORKFLOW',
] as const);

export const AI_ORCHESTRATOR_ADMIN_OPERATION_CODES = Object.freeze([
  'GENESIS',
  'SET_GLOBAL_POLICY',
  'SET_SCOPE_POLICY',
  'EMERGENCY_STOP',
] as const);

export const AI_ORCHESTRATOR_ADMIN_CHANGE_REASON_CODES = Object.freeze([
  'CONFIGURATION_CHANGE',
  'ENABLEMENT_CHANGE',
  'DISABLEMENT_CHANGE',
  'LIMIT_CHANGE',
  'OPERATING_WINDOW_CHANGE',
  'KILL_SWITCH_CHANGE',
  'EMERGENCY_STOP',
  'SECURITY_RESPONSE',
  'MAINTENANCE',
] as const);

export const AI_ORCHESTRATOR_ADMIN_MODE_RISK_ORDER = Object.freeze({
  STOPPED: 0,
  PAUSED: 1,
  DRAINING: 2,
  READY: 3,
} as const);

export const AI_ORCHESTRATOR_ADMIN_PERMISSIONS = Object.freeze([
  'ai.orchestrator.read',
  'ai.orchestrator.configure',
  'ai.orchestrator.enable',
  'ai.orchestrator.disable',
  'ai.orchestrator.kill',
  'ai.orchestrator.retry',
  'ai.orchestrator.audit',
  'ai.orchestrator.limits',
  'ai.orchestrator.agents',
] as const satisfies readonly Permission[]);

export type AiOrchestratorAdminScopeType = typeof AI_ORCHESTRATOR_ADMIN_SCOPE_TYPES[number];
export type AiOrchestratorAdminNonGlobalScopeType = typeof AI_ORCHESTRATOR_ADMIN_NON_GLOBAL_SCOPE_TYPES[number];
export type AiOrchestratorAdminOperationCode = typeof AI_ORCHESTRATOR_ADMIN_OPERATION_CODES[number];
export type AiOrchestratorAdminPermission = typeof AI_ORCHESTRATOR_ADMIN_PERMISSIONS[number];
export type AiOrchestratorAdminChangeReasonCode = typeof AI_ORCHESTRATOR_ADMIN_CHANGE_REASON_CODES[number];

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const scopeCodeSchema = z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const actorIdSchema = z.string().trim().min(1).max(191);
const reasonCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/);
const reasonControlCharacterPattern = /[\u0000-\u001f\u007f-\u009f]/u;
const forbiddenReasonContentPattern = /(?:https?:\/\/|<[^>]*>|@|(^|[^A-Za-z0-9_])(?:password|passwd|secret|token|prompt|authorization|cookie|api[ _-]?key)($|[^A-Za-z0-9_]))/iu;

/**
 * Contratto canonico di minimizzazione delle motivazioni persistite.
 *
 * Lo stesso schema protegge command, request identity, revision identity e
 * rilettura del ledger. Il vincolo PostgreSQL versionato replica esattamente
 * queste categorie; il filtro riduce il rischio di persistenza accidentale ma
 * non costituisce una classificazione generale dei dati personali.
 */
export const AiOrchestratorAdminReasonSchema = z.string().trim().superRefine((reason, context) => {
  const codePointLength = Array.from(reason).length;
  if (codePointLength < 10 || codePointLength > 500) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'La motivazione deve contenere tra 10 e 500 caratteri Unicode.',
    });
  }
  if (reason.length > 500) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'La motivazione supera il limite compatibile con il rollback PR79.',
    });
  }
  if (reasonControlCharacterPattern.test(reason)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'La motivazione non può contenere caratteri di controllo.',
    });
  }
  if (forbiddenReasonContentPattern.test(reason)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'La motivazione non rispetta il contratto di minimizzazione.',
    });
  }
});

export const AiOrchestratorAdminScopeTypeSchema = z.enum(AI_ORCHESTRATOR_ADMIN_SCOPE_TYPES);
export const AiOrchestratorAdminNonGlobalScopeTypeSchema = z.enum(AI_ORCHESTRATOR_ADMIN_NON_GLOBAL_SCOPE_TYPES);
export const AiOrchestratorAdminOperationCodeSchema = z.enum(AI_ORCHESTRATOR_ADMIN_OPERATION_CODES);
export const AiOrchestratorAdminPermissionSchema = z.enum(AI_ORCHESTRATOR_ADMIN_PERMISSIONS);
export const AiOrchestratorAdminChangeReasonCodeSchema = z.enum(AI_ORCHESTRATOR_ADMIN_CHANGE_REASON_CODES);

export const AiOrchestratorAdminLimitsSchema = z.object({
  maxConcurrentGlobal: z.number().int().min(0).max(1),
  maxConcurrentPerWorkflow: z.number().int().min(0).max(1),
  maxConcurrentPerAgent: z.number().int().min(0).max(1),
  maxRetryableFailures: z.number().int().min(0).max(3),
  leaseDurationMs: z.number().int().min(30_000).max(120_000),
  heartbeatIntervalMs: z.number().int().min(10_000).max(30_000),
  maxAttemptDurationMs: z.number().int().min(5_000).max(600_000),
  dailyJobLimit: z.number().int().min(0).max(1_000),
}).strict().superRefine((limits, context) => {
  if (limits.heartbeatIntervalMs * 2 > limits.leaseDurationMs) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['heartbeatIntervalMs'],
      message: 'L’intervallo heartbeat deve essere al massimo metà della lease.',
    });
  }
  if (limits.maxAttemptDurationMs < limits.leaseDurationMs) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['maxAttemptDurationMs'],
      message: 'La durata massima del tentativo non può essere inferiore alla lease.',
    });
  }
});

export const AiOrchestratorAdminOperatingWindowSchema = z.object({
  enabled: z.boolean(),
  timezone: z.literal('UTC'),
  startMinuteUtc: z.number().int().min(0).max(1_439).nullable(),
  endMinuteUtc: z.number().int().min(0).max(1_439).nullable(),
}).strict().superRefine((window, context) => {
  if (window.enabled) {
    if (window.startMinuteUtc === null) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['startMinuteUtc'], message: 'Inizio finestra obbligatorio.' });
    }
    if (window.endMinuteUtc === null) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['endMinuteUtc'], message: 'Fine finestra obbligatoria.' });
    }
    if (window.startMinuteUtc !== null && window.endMinuteUtc !== null && window.startMinuteUtc === window.endMinuteUtc) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['endMinuteUtc'], message: 'Inizio e fine finestra devono essere distinti.' });
    }
    return;
  }
  if (window.startMinuteUtc !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['startMinuteUtc'], message: 'La finestra disabilitata non accetta un orario iniziale.' });
  }
  if (window.endMinuteUtc !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['endMinuteUtc'], message: 'La finestra disabilitata non accetta un orario finale.' });
  }
});

export const AiOrchestratorAdminGlobalPolicySchema = z.object({
  schemaVersion: z.literal(AI_ORCHESTRATOR_ADMIN_POLICY_SCHEMA_VERSION),
  policyCode: z.literal(AI_ORCHESTRATOR_ADMIN_GLOBAL_POLICY_CODE),
  policyVersion: z.literal(AI_ORCHESTRATOR_ADMIN_POLICY_VERSION),
  activationEpoch: z.literal(AI_ORCHESTRATOR_ADMIN_ACTIVATION_EPOCH),
  foundationLocked: z.literal(true),
  desiredMode: z.enum(['STOPPED', 'PAUSED', 'DRAINING', 'READY']),
  desiredStateMachineEnabled: z.boolean(),
  desiredDispatchEnabled: z.literal(false),
  emergencyStopEngaged: z.boolean(),
  globalKillSwitch: z.boolean(),
  provider: z.literal('mock'),
  syntheticDataOnly: z.literal(true),
  limits: AiOrchestratorAdminLimitsSchema,
  operatingWindow: AiOrchestratorAdminOperatingWindowSchema,
}).strict().superRefine((policy, context) => {
  if (policy.desiredMode === 'STOPPED' && policy.desiredStateMachineEnabled) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['desiredStateMachineEnabled'],
      message: 'La modalità STOPPED richiede la state machine desiderata disabilitata.',
    });
  }
});

export const AiOrchestratorAdminScopePolicySchema = z.object({
  schemaVersion: z.literal(AI_ORCHESTRATOR_ADMIN_POLICY_SCHEMA_VERSION),
  policyCode: z.literal(AI_ORCHESTRATOR_ADMIN_SCOPE_POLICY_CODE),
  policyVersion: z.literal(AI_ORCHESTRATOR_ADMIN_POLICY_VERSION),
  activationEpoch: z.literal(AI_ORCHESTRATOR_ADMIN_ACTIVATION_EPOCH),
  scopeType: AiOrchestratorAdminNonGlobalScopeTypeSchema,
  scopeCode: scopeCodeSchema,
  targetDefinitionHash: sha256Schema,
  desiredEnabled: z.boolean(),
  killSwitch: z.boolean(),
}).strict();

export type AiOrchestratorAdminLimits = z.infer<typeof AiOrchestratorAdminLimitsSchema>;
export type AiOrchestratorAdminOperatingWindow = z.infer<typeof AiOrchestratorAdminOperatingWindowSchema>;
export type AiOrchestratorAdminGlobalPolicy = z.infer<typeof AiOrchestratorAdminGlobalPolicySchema>;
export type AiOrchestratorAdminScopePolicy = z.infer<typeof AiOrchestratorAdminScopePolicySchema>;
export type AiOrchestratorAdminPolicy = AiOrchestratorAdminGlobalPolicy | AiOrchestratorAdminScopePolicy;

export interface AiOrchestratorAdminControlTarget {
  readonly scopeType: AiOrchestratorAdminScopeType;
  readonly scopeCode: string;
  readonly targetDefinitionHash: string;
}

function defineTarget(
  scopeType: AiOrchestratorAdminScopeType,
  scopeCode: string,
  targetDefinitionHash: string,
): Readonly<AiOrchestratorAdminControlTarget> {
  return Object.freeze({
    scopeType: AiOrchestratorAdminScopeTypeSchema.parse(scopeType),
    scopeCode: scopeCodeSchema.parse(scopeCode),
    targetDefinitionHash: sha256Schema.parse(targetDefinitionHash),
  });
}

const globalTarget = defineTarget('GLOBAL', AI_ORCHESTRATOR_ADMIN_GLOBAL_SCOPE_CODE, canonicalSha256({
  schemaVersion: AI_ORCHESTRATOR_ADMIN_POLICY_SCHEMA_VERSION,
  policyCode: AI_ORCHESTRATOR_ADMIN_GLOBAL_POLICY_CODE,
  policyVersion: AI_ORCHESTRATOR_ADMIN_POLICY_VERSION,
  activationEpoch: AI_ORCHESTRATOR_ADMIN_ACTIVATION_EPOCH,
}));

const providerTarget = defineTarget('PROVIDER', 'mock', canonicalSha256({
  schemaVersion: 1,
  provider: 'mock',
  dataMode: 'synthetic',
  networkAccessAllowed: false,
  externalProvider: false,
}));

const agentDefinitionHashes = new Map<string, string>();
for (const binding of FAI_AUDIT_JOB_EXECUTOR_BINDINGS) {
  const previous = agentDefinitionHashes.get(binding.executorAgentCode);
  if (previous && previous !== binding.executorAgentConfigHash) {
    throw new Error(`Executor ${binding.executorAgentCode} associato a più configurazioni canoniche.`);
  }
  agentDefinitionHashes.set(binding.executorAgentCode, binding.executorAgentConfigHash);
}

const agentTargets = [...agentDefinitionHashes.entries()]
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([agentCode, definitionHash]) => defineTarget('AGENT', agentCode, definitionHash));

const capabilityTargets = AI_ORCHESTRATOR_WORKER_CAPABILITIES.map((capability) => defineTarget(
  'CAPABILITY',
  capability.capabilityCode,
  AI_ORCHESTRATOR_WORKER_CAPABILITY_HASHES[capability.jobCode],
));

const jobTargets = FAI_AUDIT_JOB_CODES.map((jobCode) => defineTarget(
  'JOB',
  jobCode,
  FAI_AUDIT_JOB_DEFINITION_HASHES[jobCode],
));

const workflowTarget = defineTarget('WORKFLOW', FAI_AUDIT_WORKFLOW_ID, FAI_AUDIT_WORKFLOW_DEFINITION_HASH);

export const AI_ORCHESTRATOR_ADMIN_CONTROL_TARGETS = Object.freeze([
  globalTarget,
  providerTarget,
  ...agentTargets,
  ...capabilityTargets,
  ...jobTargets,
  workflowTarget,
]);

export const AI_ORCHESTRATOR_ADMIN_CONTROL_TARGET_COUNT = 36 as const;

if (AI_ORCHESTRATOR_ADMIN_CONTROL_TARGETS.length !== AI_ORCHESTRATOR_ADMIN_CONTROL_TARGET_COUNT) {
  throw new Error(`Catalogo target Admin Control Plane incompleto: attesi 36, trovati ${AI_ORCHESTRATOR_ADMIN_CONTROL_TARGETS.length}.`);
}

const targetByKey = new Map(
  AI_ORCHESTRATOR_ADMIN_CONTROL_TARGETS.map((target) => [`${target.scopeType}:${target.scopeCode}`, target]),
);

if (targetByKey.size !== AI_ORCHESTRATOR_ADMIN_CONTROL_TARGET_COUNT || agentTargets.length !== 7) {
  throw new Error('Catalogo target Admin Control Plane duplicato o executor canonici non completi.');
}

export function getAiOrchestratorAdminControlTarget(scopeType: string, scopeCode: string) {
  return targetByKey.get(`${scopeType}:${scopeCode}`) ?? null;
}

export const AI_ORCHESTRATOR_ADMIN_GENESIS_GLOBAL_POLICY: Readonly<AiOrchestratorAdminGlobalPolicy> = Object.freeze({
  schemaVersion: AI_ORCHESTRATOR_ADMIN_POLICY_SCHEMA_VERSION,
  policyCode: AI_ORCHESTRATOR_ADMIN_GLOBAL_POLICY_CODE,
  policyVersion: AI_ORCHESTRATOR_ADMIN_POLICY_VERSION,
  activationEpoch: AI_ORCHESTRATOR_ADMIN_ACTIVATION_EPOCH,
  foundationLocked: true,
  desiredMode: 'STOPPED',
  desiredStateMachineEnabled: false,
  desiredDispatchEnabled: false,
  emergencyStopEngaged: true,
  globalKillSwitch: true,
  provider: 'mock',
  syntheticDataOnly: true,
  limits: Object.freeze({
    maxConcurrentGlobal: 0,
    maxConcurrentPerWorkflow: 0,
    maxConcurrentPerAgent: 0,
    maxRetryableFailures: 0,
    leaseDurationMs: 120_000,
    heartbeatIntervalMs: 30_000,
    maxAttemptDurationMs: 600_000,
    dailyJobLimit: 0,
  }),
  operatingWindow: Object.freeze({
    enabled: false,
    timezone: 'UTC',
    startMinuteUtc: null,
    endMinuteUtc: null,
  }),
});

AiOrchestratorAdminGlobalPolicySchema.parse(AI_ORCHESTRATOR_ADMIN_GENESIS_GLOBAL_POLICY);

export function createAiOrchestratorAdminGenesisPolicy(
  target: AiOrchestratorAdminControlTarget,
): Readonly<AiOrchestratorAdminPolicy> {
  const canonicalTarget = getAiOrchestratorAdminControlTarget(target.scopeType, target.scopeCode);
  if (!canonicalTarget || canonicalTarget.targetDefinitionHash !== target.targetDefinitionHash) {
    throw new TypeError('Target Admin Control Plane non canonico.');
  }
  if (canonicalTarget.scopeType === 'GLOBAL') return AI_ORCHESTRATOR_ADMIN_GENESIS_GLOBAL_POLICY;
  return Object.freeze(AiOrchestratorAdminScopePolicySchema.parse({
    schemaVersion: AI_ORCHESTRATOR_ADMIN_POLICY_SCHEMA_VERSION,
    policyCode: AI_ORCHESTRATOR_ADMIN_SCOPE_POLICY_CODE,
    policyVersion: AI_ORCHESTRATOR_ADMIN_POLICY_VERSION,
    activationEpoch: AI_ORCHESTRATOR_ADMIN_ACTIVATION_EPOCH,
    scopeType: canonicalTarget.scopeType,
    scopeCode: canonicalTarget.scopeCode,
    targetDefinitionHash: canonicalTarget.targetDefinitionHash,
    desiredEnabled: false,
    killSwitch: true,
  }));
}

export function validateAiOrchestratorAdminPolicyForTarget(
  target: AiOrchestratorAdminControlTarget,
  policy: unknown,
): AiOrchestratorAdminPolicy {
  const canonicalTarget = getAiOrchestratorAdminControlTarget(target.scopeType, target.scopeCode);
  if (!canonicalTarget || canonicalTarget.targetDefinitionHash !== target.targetDefinitionHash) {
    throw new TypeError('Target Admin Control Plane non canonico.');
  }
  if (canonicalTarget.scopeType === 'GLOBAL') return AiOrchestratorAdminGlobalPolicySchema.parse(policy);
  const parsed = AiOrchestratorAdminScopePolicySchema.parse(policy);
  if (
    parsed.scopeType !== canonicalTarget.scopeType
    || parsed.scopeCode !== canonicalTarget.scopeCode
    || parsed.targetDefinitionHash !== canonicalTarget.targetDefinitionHash
  ) throw new TypeError('Policy Admin Control Plane non associata al target canonico richiesto.');
  return parsed;
}

export function createAiOrchestratorAdminPolicyHash(policy: unknown) {
  const record = policy && typeof policy === 'object' ? policy as Record<string, unknown> : null;
  const parsed = record?.policyCode === AI_ORCHESTRATOR_ADMIN_GLOBAL_POLICY_CODE
    ? AiOrchestratorAdminGlobalPolicySchema.parse(policy)
    : AiOrchestratorAdminScopePolicySchema.parse(policy);
  return canonicalSha256(parsed);
}

const nullablePositiveVersionSchema = z.number().int().positive().nullable();
const nullableSha256Schema = sha256Schema.nullable();
const nullableUuidSchema = z.string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  .nullable();

export const AiOrchestratorAdminRequestIdentitySchema = z.object({
  schemaVersion: z.literal(1),
  domain: z.literal(AI_ORCHESTRATOR_ADMIN_CONTROL_REQUEST_DOMAIN),
  actorUserId: actorIdSchema.nullable(),
  requestId: nullableUuidSchema,
  scopeType: AiOrchestratorAdminScopeTypeSchema,
  scopeCode: scopeCodeSchema,
  expectedVersion: nullablePositiveVersionSchema,
  expectedRevisionHash: nullableSha256Schema,
  operationCode: AiOrchestratorAdminOperationCodeSchema,
  requestedPolicyHash: sha256Schema,
  reasonCode: reasonCodeSchema,
  reason: AiOrchestratorAdminReasonSchema,
  confirmed: z.boolean(),
}).strict().superRefine((identity, context) => {
  const genesis = identity.operationCode === 'GENESIS';
  if (genesis) {
    const target = getAiOrchestratorAdminControlTarget(identity.scopeType, identity.scopeCode);
    const expectedPolicyHash = target
      ? createAiOrchestratorAdminPolicyHash(createAiOrchestratorAdminGenesisPolicy(target))
      : null;
    if (
      identity.actorUserId !== null
      || identity.requestId !== null
      || identity.expectedVersion !== null
      || identity.expectedRevisionHash !== null
      || identity.confirmed
      || identity.requestedPolicyHash !== expectedPolicyHash
      || identity.reasonCode !== AI_ORCHESTRATOR_ADMIN_FOUNDATION_REASON_CODE
      || identity.reason !== AI_ORCHESTRATOR_ADMIN_FOUNDATION_REASON
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'La request GENESIS deve essere priva di attore, CAS, requestId e conferma.' });
    }
    return;
  }
  if (identity.operationCode === 'SET_GLOBAL_POLICY' && identity.scopeType !== 'GLOBAL') {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['scopeType'], message: 'SET_GLOBAL_POLICY richiede lo scope GLOBAL.' });
  }
  if (identity.operationCode === 'SET_SCOPE_POLICY' && identity.scopeType === 'GLOBAL') {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['scopeType'], message: 'SET_SCOPE_POLICY richiede uno scope non globale.' });
  }
  if (identity.operationCode === 'EMERGENCY_STOP' && identity.scopeType !== 'GLOBAL') {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['scopeType'], message: 'EMERGENCY_STOP richiede lo scope GLOBAL.' });
  }
  if (identity.actorUserId === null) context.addIssue({ code: z.ZodIssueCode.custom, path: ['actorUserId'], message: 'Attore obbligatorio.' });
  if (identity.requestId === null) context.addIssue({ code: z.ZodIssueCode.custom, path: ['requestId'], message: 'Request id obbligatorio.' });
  if (identity.operationCode !== 'EMERGENCY_STOP' && identity.expectedVersion === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['expectedVersion'], message: 'Versione CAS obbligatoria.' });
  }
  if (identity.operationCode !== 'EMERGENCY_STOP' && identity.expectedRevisionHash === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['expectedRevisionHash'], message: 'Hash CAS obbligatorio.' });
  }
  if (
    identity.operationCode === 'EMERGENCY_STOP'
    && (identity.expectedVersion !== null || identity.expectedRevisionHash !== null)
  ) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['expectedVersion'], message: 'L’arresto di emergenza monotono non accetta riferimenti CAS.' });
  }
  if (
    identity.operationCode === 'EMERGENCY_STOP'
    && identity.requestedPolicyHash !== AI_ORCHESTRATOR_ADMIN_EMERGENCY_STOP_INTENT_HASH
  ) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['requestedPolicyHash'], message: 'Intent hash di emergenza non canonico.' });
  }
  if (!identity.confirmed) context.addIssue({ code: z.ZodIssueCode.custom, path: ['confirmed'], message: 'Conferma esplicita obbligatoria.' });
  if (identity.reason.trim().length < 10) context.addIssue({ code: z.ZodIssueCode.custom, path: ['reason'], message: 'Motivazione troppo breve.' });
});

export type AiOrchestratorAdminRequestIdentity = z.infer<typeof AiOrchestratorAdminRequestIdentitySchema>;

export function buildAiOrchestratorAdminRequestIdentity(
  input: Omit<AiOrchestratorAdminRequestIdentity, 'schemaVersion' | 'domain'>,
): AiOrchestratorAdminRequestIdentity {
  const identity = AiOrchestratorAdminRequestIdentitySchema.parse({
    ...input,
    schemaVersion: 1,
    domain: AI_ORCHESTRATOR_ADMIN_CONTROL_REQUEST_DOMAIN,
  });
  const target = getAiOrchestratorAdminControlTarget(identity.scopeType, identity.scopeCode);
  if (!target) throw new TypeError('Scope della request Admin Control Plane non canonico.');
  return identity;
}

export function createAiOrchestratorAdminRequestHash(
  input: Omit<AiOrchestratorAdminRequestIdentity, 'schemaVersion' | 'domain'> | AiOrchestratorAdminRequestIdentity,
) {
  const identity = 'domain' in input
    ? AiOrchestratorAdminRequestIdentitySchema.parse(input)
    : buildAiOrchestratorAdminRequestIdentity(input);
  return canonicalSha256(identity);
}

const roleSchema = z.enum([
  'admin',
  'direzione',
  'commerciale',
  'consulente',
  'revisore',
  'backoffice',
  'amministrazione',
  'collaboratore_limitato',
]);

export const AiOrchestratorAdminPermissionDecisionSchema = z.object({
  permission: AiOrchestratorAdminPermissionSchema,
  allowed: z.boolean(),
  source: z.enum(['ADMIN', 'OVERRIDE']),
}).strict();

export type AiOrchestratorAdminPermissionDecision = z.infer<typeof AiOrchestratorAdminPermissionDecisionSchema>;

export const AiOrchestratorAdminRevisionIdentitySchema = z.object({
  schemaVersion: z.literal(1),
  ledgerCode: z.literal(AI_ORCHESTRATOR_ADMIN_POLICY_LEDGER_CODE),
  scopeType: AiOrchestratorAdminScopeTypeSchema,
  scopeCode: scopeCodeSchema,
  targetDefinitionHash: sha256Schema,
  version: z.number().int().positive(),
  policyHash: sha256Schema,
  previousRevisionHash: nullableSha256Schema,
  requestId: nullableUuidSchema,
  requestHash: sha256Schema,
  operationCode: AiOrchestratorAdminOperationCodeSchema,
  requiredPermissions: z.array(AiOrchestratorAdminPermissionSchema).max(AI_ORCHESTRATOR_ADMIN_PERMISSIONS.length),
  permissionDecisions: z.array(AiOrchestratorAdminPermissionDecisionSchema).max(AI_ORCHESTRATOR_ADMIN_PERMISSIONS.length),
  actorUserId: actorIdSchema.nullable(),
  actorRole: roleSchema.nullable(),
  reasonCode: reasonCodeSchema,
  reason: AiOrchestratorAdminReasonSchema,
  confirmed: z.boolean(),
}).strict().superRefine((identity, context) => {
  const target = getAiOrchestratorAdminControlTarget(identity.scopeType, identity.scopeCode);
  if (!target || target.targetDefinitionHash !== identity.targetDefinitionHash) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['targetDefinitionHash'], message: 'Target definition non canonica.' });
  }
  const permissionSet = new Set(identity.requiredPermissions);
  const decisionSet = new Set(identity.permissionDecisions.map(({ permission }) => permission));
  if (permissionSet.size !== identity.requiredPermissions.length || decisionSet.size !== identity.permissionDecisions.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['requiredPermissions'], message: 'Permessi duplicati.' });
  }
  if (
    permissionSet.size !== decisionSet.size
    || [...permissionSet].some((permission) => !decisionSet.has(permission))
  ) context.addIssue({ code: z.ZodIssueCode.custom, path: ['permissionDecisions'], message: 'Decisioni permesso non complete.' });

  const genesis = identity.operationCode === 'GENESIS';
  if (genesis) {
    const expectedPolicyHash = target
      ? createAiOrchestratorAdminPolicyHash(createAiOrchestratorAdminGenesisPolicy(target))
      : null;
    const expectedRequestHash = target && expectedPolicyHash
      ? canonicalSha256({
        schemaVersion: 1,
        domain: AI_ORCHESTRATOR_ADMIN_CONTROL_REQUEST_DOMAIN,
        actorUserId: null,
        requestId: null,
        scopeType: target.scopeType,
        scopeCode: target.scopeCode,
        expectedVersion: null,
        expectedRevisionHash: null,
        operationCode: 'GENESIS',
        requestedPolicyHash: expectedPolicyHash,
        reasonCode: AI_ORCHESTRATOR_ADMIN_FOUNDATION_REASON_CODE,
        reason: AI_ORCHESTRATOR_ADMIN_FOUNDATION_REASON,
        confirmed: false,
      })
      : null;
    if (
      identity.version !== 1
      || identity.previousRevisionHash !== null
      || identity.requestId !== null
      || identity.actorUserId !== null
      || identity.actorRole !== null
      || identity.requiredPermissions.length !== 0
      || identity.permissionDecisions.length !== 0
      || identity.confirmed
      || identity.policyHash !== expectedPolicyHash
      || identity.requestHash !== expectedRequestHash
      || identity.reasonCode !== AI_ORCHESTRATOR_ADMIN_FOUNDATION_REASON_CODE
      || identity.reason !== AI_ORCHESTRATOR_ADMIN_FOUNDATION_REASON
    ) context.addIssue({ code: z.ZodIssueCode.custom, message: 'La revisione GENESIS deve essere Foundation e priva di identità umana.' });
    return;
  }

  if (identity.operationCode === 'SET_GLOBAL_POLICY' && identity.scopeType !== 'GLOBAL') {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['scopeType'], message: 'SET_GLOBAL_POLICY richiede lo scope GLOBAL.' });
  }
  if (identity.operationCode === 'SET_SCOPE_POLICY' && identity.scopeType === 'GLOBAL') {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['scopeType'], message: 'SET_SCOPE_POLICY richiede uno scope non globale.' });
  }
  if (identity.operationCode === 'EMERGENCY_STOP') {
    if (identity.scopeType !== 'GLOBAL') {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['scopeType'], message: 'EMERGENCY_STOP richiede lo scope GLOBAL.' });
    }
    if (
      identity.requiredPermissions.length !== 1
      || identity.requiredPermissions[0] !== 'ai.orchestrator.kill'
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['requiredPermissions'], message: 'EMERGENCY_STOP richiede esclusivamente il permesso kill.' });
    }
  }

  if (identity.version < 2 || identity.previousRevisionHash === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['version'], message: 'Una revisione umana deve seguire una revisione precedente.' });
  }
  if (identity.requestId === null || identity.actorUserId === null || identity.actorRole === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Identità umana e request sono obbligatorie.' });
  }
  if (!identity.confirmed) context.addIssue({ code: z.ZodIssueCode.custom, path: ['confirmed'], message: 'Conferma esplicita obbligatoria.' });
  if (identity.reason.trim().length < 10) context.addIssue({ code: z.ZodIssueCode.custom, path: ['reason'], message: 'Motivazione troppo breve.' });
  if (identity.requiredPermissions.length === 0 || identity.permissionDecisions.some(({ allowed }) => !allowed)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['permissionDecisions'], message: 'La revisione accettata richiede decisioni autorizzate.' });
  }
});

export type AiOrchestratorAdminRevisionIdentity = z.infer<typeof AiOrchestratorAdminRevisionIdentitySchema>;

function permissionOrder(permission: AiOrchestratorAdminPermission) {
  return AI_ORCHESTRATOR_ADMIN_PERMISSIONS.indexOf(permission);
}

export function buildAiOrchestratorAdminRevisionIdentity(
  input: Omit<AiOrchestratorAdminRevisionIdentity, 'schemaVersion' | 'ledgerCode'>,
): AiOrchestratorAdminRevisionIdentity {
  const requiredPermissions = [...input.requiredPermissions].sort((left, right) => permissionOrder(left) - permissionOrder(right));
  const permissionDecisions = [...input.permissionDecisions].sort(
    (left, right) => permissionOrder(left.permission) - permissionOrder(right.permission),
  );
  return AiOrchestratorAdminRevisionIdentitySchema.parse({
    ...input,
    schemaVersion: 1,
    ledgerCode: AI_ORCHESTRATOR_ADMIN_POLICY_LEDGER_CODE,
    requiredPermissions,
    permissionDecisions,
  });
}

export function createAiOrchestratorAdminRevisionHash(
  input: Omit<AiOrchestratorAdminRevisionIdentity, 'schemaVersion' | 'ledgerCode'> | AiOrchestratorAdminRevisionIdentity,
) {
  let identity: AiOrchestratorAdminRevisionIdentity;
  if ('ledgerCode' in input) {
    const { schemaVersion: _schemaVersion, ledgerCode: _ledgerCode, ...rest } = input;
    identity = buildAiOrchestratorAdminRevisionIdentity(rest);
  } else {
    identity = buildAiOrchestratorAdminRevisionIdentity(input);
  }
  return canonicalSha256(identity);
}

function changedTopLevelPaths(before: Record<string, unknown>, after: Record<string, unknown>) {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return keys.filter((key) => canonicalSha256(before[key]) !== canonicalSha256(after[key]));
}

function orderedPermissions(values: Set<AiOrchestratorAdminPermission>) {
  return AI_ORCHESTRATOR_ADMIN_PERMISSIONS.filter((permission) => values.has(permission));
}

export interface AiOrchestratorAdminPolicyDiff {
  readonly changedPaths: readonly string[];
  readonly requiredPermissions: readonly AiOrchestratorAdminPermission[];
}

export function diffAiOrchestratorAdminPolicies(
  beforeInput: unknown,
  afterInput: unknown,
  operationCode: Exclude<AiOrchestratorAdminOperationCode, 'GENESIS'>,
): AiOrchestratorAdminPolicyDiff {
  const beforeRecord = beforeInput && typeof beforeInput === 'object' ? beforeInput as Record<string, unknown> : {};
  const global = beforeRecord.policyCode === AI_ORCHESTRATOR_ADMIN_GLOBAL_POLICY_CODE;
  const before = global
    ? AiOrchestratorAdminGlobalPolicySchema.parse(beforeInput)
    : AiOrchestratorAdminScopePolicySchema.parse(beforeInput);
  const after = global
    ? AiOrchestratorAdminGlobalPolicySchema.parse(afterInput)
    : AiOrchestratorAdminScopePolicySchema.parse(afterInput);
  if (before.policyCode !== after.policyCode) throw new TypeError('Tipo policy non modificabile.');

  const changedPaths = changedTopLevelPaths(
    before as unknown as Record<string, unknown>,
    after as unknown as Record<string, unknown>,
  );
  const required = new Set<AiOrchestratorAdminPermission>();
  if (operationCode === 'EMERGENCY_STOP') {
    required.add('ai.orchestrator.kill');
    return Object.freeze({ changedPaths: Object.freeze(changedPaths), requiredPermissions: Object.freeze(orderedPermissions(required)) });
  }
  required.add('ai.orchestrator.configure');

  if (global && before.policyCode === AI_ORCHESTRATOR_ADMIN_GLOBAL_POLICY_CODE && after.policyCode === AI_ORCHESTRATOR_ADMIN_GLOBAL_POLICY_CODE) {
    if (canonicalSha256(before.limits) !== canonicalSha256(after.limits)) required.add('ai.orchestrator.limits');
    if (before.limits.maxRetryableFailures !== after.limits.maxRetryableFailures) required.add('ai.orchestrator.retry');
    if (before.desiredMode !== after.desiredMode) {
      const beforeRisk = AI_ORCHESTRATOR_ADMIN_MODE_RISK_ORDER[before.desiredMode];
      const afterRisk = AI_ORCHESTRATOR_ADMIN_MODE_RISK_ORDER[after.desiredMode];
      required.add(afterRisk > beforeRisk ? 'ai.orchestrator.enable' : 'ai.orchestrator.disable');
    }
    if (before.desiredStateMachineEnabled !== after.desiredStateMachineEnabled) {
      required.add(after.desiredStateMachineEnabled ? 'ai.orchestrator.enable' : 'ai.orchestrator.disable');
    }
    for (const [previous, next] of [
      [before.emergencyStopEngaged, after.emergencyStopEngaged],
      [before.globalKillSwitch, after.globalKillSwitch],
    ] as const) {
      if (previous === next) continue;
      required.add('ai.orchestrator.kill');
      if (!next) required.add('ai.orchestrator.enable');
    }
  } else if (!global && before.policyCode === AI_ORCHESTRATOR_ADMIN_SCOPE_POLICY_CODE && after.policyCode === AI_ORCHESTRATOR_ADMIN_SCOPE_POLICY_CODE) {
    if (
      before.scopeType !== after.scopeType
      || before.scopeCode !== after.scopeCode
      || before.targetDefinitionHash !== after.targetDefinitionHash
    ) throw new TypeError('Identità target della policy non modificabile.');
    if (before.scopeType === 'AGENT') required.add('ai.orchestrator.agents');
    if (before.desiredEnabled !== after.desiredEnabled) {
      required.add(after.desiredEnabled ? 'ai.orchestrator.enable' : 'ai.orchestrator.disable');
    }
    if (before.killSwitch !== after.killSwitch) {
      required.add('ai.orchestrator.kill');
      if (!after.killSwitch) required.add('ai.orchestrator.enable');
    }
  }
  return Object.freeze({
    changedPaths: Object.freeze(changedPaths),
    requiredPermissions: Object.freeze(orderedPermissions(required)),
  });
}

export function engageAiOrchestratorEmergencyStop(
  currentInput: unknown,
): Readonly<AiOrchestratorAdminGlobalPolicy> {
  const current = AiOrchestratorAdminGlobalPolicySchema.parse(currentInput);
  return Object.freeze(AiOrchestratorAdminGlobalPolicySchema.parse({
    ...current,
    desiredMode: 'STOPPED',
    desiredStateMachineEnabled: false,
    desiredDispatchEnabled: false,
    emergencyStopEngaged: true,
    globalKillSwitch: true,
  }));
}
