import { Prisma, type PrismaClient, type RoleCode } from '@prisma/client';
import { createAiAgentConfigHash } from '../ai-agent-config-hash';
import { canonicalSha256 } from '../canonical-json';
import { evaluatePermission, type PermissionDecision } from '../permission-evaluator';
import { SerializableConflictError, withSerializableTransaction } from '../serializable';
import {
  FAI_AUDIT_WORKFLOW_DEFINITION_HASH,
  FAI_AUDIT_WORKFLOW_ID,
  FAI_AUDIT_WORKFLOW_VERSION,
  evaluateAuditWorkflowTransition,
  getAuditWorkflowTransition,
  type AuditWorkflowDenialCode,
  type FaiAuditRequiredPermission,
  type FaiAuditState,
  type FaiAuditTransitionCode,
  type WorkflowExecutionMode,
} from './audit-workflow-v1-1';
import {
  FAI_AUDIT_EXECUTOR_BINDING_VERSION,
  FAI_AUDIT_JOB_CATALOG_HASH,
  FAI_AUDIT_JOB_CATALOG_KEY,
  getFaiAuditJobDefinition,
  getFaiAuditJobPlanningRule,
} from './job-catalog-v1';
import {
  createFaiAuditJobPlan,
  type FaiAuditJobPlan,
  type ResolvedFaiAuditJobExecutor,
} from './job-planner';

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REASON_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/;
const ORCHESTRATOR_SETTING_ID = 'global';
const ALLOWED_SYSTEM_CODE = 'AI_ORCHESTRATOR' as const;
const MAX_SERIALIZABLE_ATTEMPTS = 2;

class CanonicalExecutorUnavailableError extends Error {
  constructor() {
    super('Executor canonico o configurazione mock immutabile non disponibile.');
    this.name = 'CanonicalExecutorUnavailableError';
  }
}

export const FOUNDATION_TRANSITION_CODES = Object.freeze([
  'WF-001',
  'WF-002',
  'WF-003',
  'WF-004',
  'WF-005',
  'WF-006',
  'WF-007',
  'WF-008',
  'WF-009',
  'WF-010',
  'WF-011',
  'WF-012',
  'WF-013',
  'WF-014',
  'WF-015',
  'WF-016',
  'WF-017',
] as const satisfies readonly FaiAuditTransitionCode[]);

const foundationTransitionCodeSet = new Set<string>(FOUNDATION_TRANSITION_CODES);

type Tx = Prisma.TransactionClient;

export type AuditWorkflowActor =
  | { readonly kind: 'HUMAN'; readonly userId: string; readonly executionMode?: 'INTERACTIVE' }
  | {
      readonly kind: 'AGENT';
      readonly agentId: string;
      readonly agentConfigVersion: number;
      readonly executionMode?: 'WORKER';
    }
  | {
      readonly kind: 'SYSTEM';
      readonly systemCode: typeof ALLOWED_SYSTEM_CODE;
      readonly executionMode: 'WORKER' | 'SYSTEM';
    };

export interface CreateAuditWorkflowInput {
  readonly creationKey: string;
  readonly expectedDefinitionHash: string;
  readonly actor: Extract<AuditWorkflowActor, { kind: 'HUMAN' }>;
  /** Reserved links must remain null while the foundation is synthetic-only. */
  readonly clientId?: string | null;
  readonly companyId?: string | null;
  readonly projectId?: string | null;
  readonly clientServiceId?: string | null;
}

export interface ApplyAuditWorkflowTransitionInput {
  readonly workflowInstanceId: string;
  readonly transitionCode: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly expectedDefinitionHash: string;
  readonly expectedState: string;
  readonly expectedStateVersion: number;
  readonly actor: AuditWorkflowActor;
  readonly gateResults?: Readonly<Record<string, string | undefined>>;
  readonly preconditions?: Readonly<Record<string, boolean | undefined>>;
  readonly manualReleaseConfirmed?: boolean;
  readonly reasonCode?: string | null;
}

const AUDIT_WORKFLOW_DENIAL_CODES = [
  'WORKFLOW_ID_MISMATCH',
  'WORKFLOW_VERSION_MISMATCH',
  'DEFINITION_HASH_MISMATCH',
  'UNKNOWN_STATE',
  'UNKNOWN_TRANSITION',
  'STATE_MISMATCH',
  'ACTOR_REQUIRED',
  'UNKNOWN_ACTOR_KIND',
  'ACTOR_NOT_ALLOWED',
  'ACTOR_CONTEXT_INVALID',
  'WORKER_STOP_REQUIRED',
  'PERMISSION_NOT_GRANTED',
  'GATE_NOT_PASSED',
  'PRECONDITION_NOT_MET',
  'EXTERNAL_PROVIDER_STATUS_UNKNOWN',
  'EXTERNAL_PROVIDERS_ENABLED',
  'MOCK_PROVIDER_REQUIRED',
  'CORRECTION_CYCLE_INVALID',
  'CORRECTION_LIMIT_REACHED',
  'REASON_CODE_REQUIRED',
  'MANUAL_RELEASE_REQUIRED',
] as const satisfies readonly AuditWorkflowDenialCode[];

export const WORKFLOW_SERVICE_REJECTION_CODES = [
  ...AUDIT_WORKFLOW_DENIAL_CODES,
  'INVALID_INPUT',
  'ACTOR_NOT_FOUND',
  'ACTOR_POLICY_DENIED',
  'PERMISSION_DENIED',
  'ORCHESTRATOR_DISABLED',
  'EXTERNAL_PROVIDERS_MUST_BE_DISABLED',
  'SYNTHETIC_CONTEXT_REQUIRED',
  'WORKFLOW_NOT_FOUND',
  'DEFINITION_MISMATCH',
  'IDEMPOTENCY_CONFLICT',
  'COMMAND_IN_PROGRESS',
  'STATE_VERSION_MISMATCH',
  'LEDGER_INTEGRITY_ERROR',
  'FOUNDATION_SCOPE_LIMIT',
  'MILESTONE_NOT_COMPLETED',
  'MILESTONE_OUT_OF_ORDER',
  'MILESTONE_DUPLICATE',
  'APPROVER_SEPARATION_FAILED',
  'RELEASE_DUAL_CONTROL_FAILED',
] as const;

export type WorkflowServiceRejectionCode = typeof WORKFLOW_SERVICE_REJECTION_CODES[number];

const workflowServiceRejectionCodeSet = new Set<string>(WORKFLOW_SERVICE_REJECTION_CODES);

export function isWorkflowServiceRejectionCode(value: unknown): value is WorkflowServiceRejectionCode {
  return typeof value === 'string' && workflowServiceRejectionCodeSet.has(value);
}

export type WorkflowServiceResult<T> =
  | { readonly ok: true; readonly replayed: boolean; readonly value: T }
  | {
      readonly ok: false;
      readonly code: WorkflowServiceRejectionCode;
      readonly message: string;
      readonly replayed?: boolean;
      readonly commandId?: string;
    };

export interface AuditWorkflowInstanceResult {
  readonly workflowInstanceId: string;
  readonly currentState: FaiAuditState;
  readonly stateVersion: number;
  readonly creationRequestHash: string;
}

export interface AuditWorkflowTransitionResult {
  readonly workflowInstanceId: string;
  readonly commandId: string;
  readonly transitionId: string;
  readonly transitionCode: FaiAuditTransitionCode;
  readonly currentState: FaiAuditState;
  readonly stateVersion: number;
  readonly stateChanged: boolean;
  readonly transitionHash: string;
  readonly jobPlanningStatus: 'PLANNED' | 'LEGACY_NOT_PLANNED';
  readonly jobPlanHash: string | null;
  readonly plannedJobCount: number;
}

interface ResolvedActor {
  readonly kind: AuditWorkflowActor['kind'];
  readonly actorId: string;
  readonly executionMode: WorkflowExecutionMode;
  readonly grantedPermissions: readonly string[];
  readonly humanRole: RoleCode | null;
  readonly permissionDecisions: Readonly<Record<FaiAuditRequiredPermission, PermissionDecision>> | null;
  readonly commandIdentity: {
    readonly requestedByUserId: string | null;
    readonly requestedByAgentId: string | null;
    readonly requestedByAgentConfigVersion: number | null;
    readonly requestedBySystemCode: string | null;
  };
  readonly transitionIdentity: {
    readonly actorUserId: string | null;
    readonly actorAgentId: string | null;
    readonly actorAgentConfigVersion: number | null;
    readonly actorSystemCode: string | null;
  };
}

function rejected(
  code: WorkflowServiceRejectionCode,
  message: string,
  extras: { replayed?: boolean; commandId?: string } = {},
): WorkflowServiceResult<never> {
  return { ok: false, code, message, ...extras };
}

function isUuidV4(value: unknown): value is string {
  return typeof value === 'string' && UUID_V4_PATTERN.test(value);
}

function hasReservedContext(input: {
  clientId?: string | null;
  companyId?: string | null;
  projectId?: string | null;
  clientServiceId?: string | null;
}) {
  return [input.clientId, input.companyId, input.projectId, input.clientServiceId]
    .some((value) => value !== null && value !== undefined);
}

function normalizeGateResults(
  gateResults: Readonly<Record<string, string | undefined>> | undefined,
  expectedGate: string,
) {
  if (gateResults && Object.keys(gateResults).some((key) => key !== expectedGate)) return null;
  const value = gateResults?.[expectedGate];
  return { [expectedGate]: value === undefined ? null : value };
}

function normalizePreconditions(
  preconditions: Readonly<Record<string, boolean | undefined>> | undefined,
  expected: readonly string[],
) {
  const expectedSet = new Set(expected);
  if (preconditions && Object.keys(preconditions).some((key) => !expectedSet.has(key))) return null;
  return Object.fromEntries(expected.map((key) => {
    const value = preconditions?.[key];
    return [key, value === undefined ? null : value];
  })) as Record<string, boolean | null>;
}

function actorHashIdentity(actor: AuditWorkflowActor) {
  if (actor.kind === 'HUMAN') return { kind: actor.kind, userId: actor.userId };
  if (actor.kind === 'AGENT') {
    return { kind: actor.kind, agentId: actor.agentId, agentConfigVersion: actor.agentConfigVersion };
  }
  return { kind: actor.kind, systemCode: actor.systemCode, executionMode: actor.executionMode };
}

export function createAuditWorkflowCreationRequestHash(input: CreateAuditWorkflowInput) {
  return canonicalSha256({
    actor: actorHashIdentity(input.actor),
    context: {
      clientId: input.clientId ?? null,
      companyId: input.companyId ?? null,
      projectId: input.projectId ?? null,
      clientServiceId: input.clientServiceId ?? null,
    },
    dataMode: 'synthetic',
    definitionHash: input.expectedDefinitionHash,
    workflowId: FAI_AUDIT_WORKFLOW_ID,
    workflowVersion: FAI_AUDIT_WORKFLOW_VERSION,
  });
}

export function createAuditWorkflowCommandRequestHash(input: ApplyAuditWorkflowTransitionInput) {
  const transition = getAuditWorkflowTransition(input.transitionCode);
  if (!transition) throw new TypeError('Transizione workflow non riconosciuta.');
  const gateResults = normalizeGateResults(input.gateResults, transition.gate);
  const preconditions = normalizePreconditions(input.preconditions, transition.preconditions);
  if (!gateResults || !preconditions) throw new TypeError('Gate o precondizioni non riconosciuti.');
  return canonicalSha256({
    actor: actorHashIdentity(input.actor),
    correlationId: input.correlationId,
    definitionHash: input.expectedDefinitionHash,
    expectedState: input.expectedState,
    expectedStateVersion: input.expectedStateVersion,
    gateResults,
    manualReleaseConfirmed: input.manualReleaseConfirmed ?? null,
    preconditions,
    reasonCode: input.reasonCode ?? null,
    transitionCode: input.transitionCode,
    workflowInstanceId: input.workflowInstanceId,
  });
}

async function databaseNow(tx: Tx) {
  const rows = await tx.$queryRaw<Array<{ now: Date }>>(Prisma.sql`SELECT CURRENT_TIMESTAMP AS "now"`);
  const now = rows[0]?.now;
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error('Clock PostgreSQL non disponibile.');
  return now;
}

async function writeAudit(
  tx: Tx,
  input: {
    actorId: string | null;
    event: string;
    entityType: string;
    entityId: string | null;
    before?: Prisma.InputJsonValue;
    after?: Prisma.InputJsonValue;
    createdAt: Date;
  },
) {
  await tx.auditLog.create({ data: input });
}

async function loadHuman(tx: Tx, userId: string) {
  return tx.user.findFirst({
    where: { id: userId, active: true, deletedAt: null },
    select: {
      id: true,
      role: true,
      active: true,
      permissionOverrides: { select: { permission: true, allowed: true } },
    },
  });
}

async function resolveActor(tx: Tx, actor: AuditWorkflowActor): Promise<ResolvedActor | null> {
  if (actor.kind === 'HUMAN') {
    if (!actor.userId?.trim() || (actor.executionMode ?? 'INTERACTIVE') !== 'INTERACTIVE') return null;
    const user = await loadHuman(tx, actor.userId);
    if (!user) return null;
    const permissionSession = {
      role: user.role,
      active: user.active,
      permissionOverrides: user.permissionOverrides,
    };
    const permissionDecisions = Object.fromEntries(
      (['ai.run', 'ai.review', 'ai.approve'] as const)
        .map((permission) => [permission, evaluatePermission(permissionSession, permission)]),
    ) as Record<FaiAuditRequiredPermission, PermissionDecision>;
    const grantedPermissions = (Object.entries(permissionDecisions) as Array<[
      FaiAuditRequiredPermission,
      PermissionDecision,
    ]>)
      .filter(([, decision]) => decision.allowed)
      .map(([permission]) => permission);
    return {
      kind: 'HUMAN',
      actorId: user.id,
      executionMode: 'INTERACTIVE',
      grantedPermissions,
      humanRole: user.role,
      permissionDecisions,
      commandIdentity: {
        requestedByUserId: user.id,
        requestedByAgentId: null,
        requestedByAgentConfigVersion: null,
        requestedBySystemCode: null,
      },
      transitionIdentity: {
        actorUserId: user.id,
        actorAgentId: null,
        actorAgentConfigVersion: null,
        actorSystemCode: null,
      },
    };
  }

  if (actor.kind === 'AGENT') {
    if (
      !actor.agentId?.trim()
      || !Number.isInteger(actor.agentConfigVersion)
      || actor.agentConfigVersion < 1
      || (actor.executionMode ?? 'WORKER') !== 'WORKER'
    ) return null;
    const config = await tx.aiAgentConfigVersion.findUnique({
      where: { agentId_version: { agentId: actor.agentId, version: actor.agentConfigVersion } },
      select: { agentId: true, version: true, active: true, provider: true, agent: { select: { active: true } } },
    });
    if (!config || !config.active || !config.agent.active || config.provider !== 'mock') return null;
    return {
      kind: 'AGENT',
      actorId: `${config.agentId}@${config.version}`,
      executionMode: 'WORKER',
      grantedPermissions: [],
      humanRole: null,
      permissionDecisions: null,
      commandIdentity: {
        requestedByUserId: null,
        requestedByAgentId: config.agentId,
        requestedByAgentConfigVersion: config.version,
        requestedBySystemCode: null,
      },
      transitionIdentity: {
        actorUserId: null,
        actorAgentId: config.agentId,
        actorAgentConfigVersion: config.version,
        actorSystemCode: null,
      },
    };
  }

  if (
    actor.kind !== 'SYSTEM'
    || actor.systemCode !== ALLOWED_SYSTEM_CODE
    || !['WORKER', 'SYSTEM'].includes(actor.executionMode)
  ) return null;
  return {
    kind: 'SYSTEM',
    actorId: actor.systemCode,
    executionMode: actor.executionMode,
    grantedPermissions: [],
    humanRole: null,
    permissionDecisions: null,
    commandIdentity: {
      requestedByUserId: null,
      requestedByAgentId: null,
      requestedByAgentConfigVersion: null,
      requestedBySystemCode: actor.systemCode,
    },
    transitionIdentity: {
      actorUserId: null,
      actorAgentId: null,
      actorAgentConfigVersion: null,
      actorSystemCode: actor.systemCode,
    },
  };
}

async function loadSafeSettings(tx: Tx, env: NodeJS.ProcessEnv) {
  const [orchestrator, externalControl] = await Promise.all([
    tx.aiOrchestratorSetting.findUnique({ where: { id: ORCHESTRATOR_SETTING_ID } }),
    tx.aiControlSetting.findUnique({ where: { id: 'global' }, select: { externalProvidersEnabled: true } }),
  ]);
  const stateMachineReady = Boolean(
    orchestrator
    && orchestrator.stateMachineEnabled === true
    && orchestrator.dispatchEnabled === false
    && orchestrator.syntheticDataOnly === true
    && orchestrator.provider === 'mock'
    && orchestrator.version >= 1,
  );
  const databaseExternalProvidersEnabled = externalControl?.externalProvidersEnabled ?? null;
  const environmentExternalProvidersEnabled = env.AI_EXTERNAL_PROVIDERS_ENABLED === 'true';
  const externalProviderSwitchOpen = databaseExternalProvidersEnabled !== false || environmentExternalProvidersEnabled;
  return {
    orchestrator,
    stateMachineReady,
    databaseExternalProvidersEnabled,
    environmentExternalProvidersEnabled,
    externalProviderSwitchOpen,
  };
}

async function resolveCanonicalJobExecutors(
  tx: Tx,
  transitionCode: FaiAuditTransitionCode,
): Promise<readonly ResolvedFaiAuditJobExecutor[] | null> {
  const rule = getFaiAuditJobPlanningRule(transitionCode);
  if (!rule) return [];
  const resolved: ResolvedFaiAuditJobExecutor[] = [];
  for (const jobCode of rule.jobCodes) {
    const definition = getFaiAuditJobDefinition(jobCode);
    if (!definition) return null;
    const snapshot = await tx.aiAgentConfigVersion.findFirst({
      where: {
        version: definition.executorAgentConfigVersion,
        code: definition.executorAgentCode,
        agent: { code: definition.executorAgentCode },
      },
      select: {
        agentId: true,
        version: true,
        code: true,
        name: true,
        description: true,
        operationalScope: true,
        systemPrompt: true,
        requiredDataChecklist: true,
        expectedOutput: true,
        toneStyle: true,
        active: true,
        provider: true,
        model: true,
        promptVersion: true,
        inputSchema: true,
        outputSchema: true,
        agent: {
          select: {
            code: true,
            active: true,
            provider: true,
            configVersion: true,
          },
        },
      },
    });
    if (
      !snapshot
      || snapshot.code !== definition.executorAgentCode
      || snapshot.agent.code !== definition.executorAgentCode
      || snapshot.version !== definition.executorAgentConfigVersion
      || snapshot.agent.configVersion !== definition.executorAgentConfigVersion
      || !snapshot.active
      || !snapshot.agent.active
      || snapshot.provider !== 'mock'
      || snapshot.agent.provider !== 'mock'
      || snapshot.model !== null
      || createAiAgentConfigHash(snapshot) !== definition.executorAgentConfigHash
    ) return null;
    resolved.push(Object.freeze({
      jobCode,
      executorAgentId: snapshot.agentId,
      executorAgentCode: snapshot.code,
      executorAgentConfigVersion: snapshot.version,
      executorAgentConfigHash: definition.executorAgentConfigHash,
    }));
  }
  return Object.freeze(resolved);
}

async function auditCreationDenial(
  tx: Tx,
  now: Date,
  input: CreateAuditWorkflowInput,
  code: WorkflowServiceRejectionCode,
) {
  await writeAudit(tx, {
    actorId: input.actor.userId || null,
    event: 'ai_workflow_creation_denied',
    entityType: 'AiWorkflowInstance',
    entityId: input.creationKey || null,
    after: {
      rejectionCode: code,
      workflowCode: FAI_AUDIT_WORKFLOW_ID,
      workflowVersion: FAI_AUDIT_WORKFLOW_VERSION,
    },
    createdAt: now,
  });
}

async function createAuditWorkflowInstanceTx(
  tx: Tx,
  input: CreateAuditWorkflowInput,
  env: NodeJS.ProcessEnv,
): Promise<WorkflowServiceResult<AuditWorkflowInstanceResult>> {
  const now = await databaseNow(tx);
  if (!isUuidV4(input.creationKey) || input.expectedDefinitionHash !== FAI_AUDIT_WORKFLOW_DEFINITION_HASH) {
    await auditCreationDenial(tx, now, input, 'INVALID_INPUT');
    return rejected('INVALID_INPUT', 'Chiave di creazione o definizione workflow non valida.');
  }
  if (hasReservedContext(input)) {
    await auditCreationDenial(tx, now, input, 'SYNTHETIC_CONTEXT_REQUIRED');
    return rejected(
      'SYNTHETIC_CONTEXT_REQUIRED',
      'La foundation consente solo casi sintetici senza collegamenti a dati CRM.',
    );
  }

  const actor = await resolveActor(tx, input.actor);
  if (!actor || actor.kind !== 'HUMAN') {
    await auditCreationDenial(tx, now, input, 'ACTOR_NOT_FOUND');
    return rejected('ACTOR_NOT_FOUND', 'Attore umano attivo non disponibile.');
  }
  if (!actor.grantedPermissions.includes('ai.run')) {
    await auditCreationDenial(tx, now, input, 'PERMISSION_DENIED');
    return rejected('PERMISSION_DENIED', 'Il permesso ai.run è obbligatorio.');
  }

  const settings = await loadSafeSettings(tx, env);
  if (!settings.stateMachineReady) {
    await auditCreationDenial(tx, now, input, 'ORCHESTRATOR_DISABLED');
    return rejected('ORCHESTRATOR_DISABLED', 'State Machine Foundation disabilitata o configurazione fail-closed.');
  }
  if (settings.externalProviderSwitchOpen) {
    await auditCreationDenial(tx, now, input, 'EXTERNAL_PROVIDERS_MUST_BE_DISABLED');
    return rejected(
      'EXTERNAL_PROVIDERS_MUST_BE_DISABLED',
      'I provider AI esterni devono essere completamente disabilitati.',
    );
  }

  const creationRequestHash = createAuditWorkflowCreationRequestHash(input);
  const existing = await tx.aiWorkflowInstance.findUnique({ where: { creationKey: input.creationKey } });
  if (existing) {
    if (existing.creationRequestHash !== creationRequestHash || existing.createdById !== actor.actorId) {
      await auditCreationDenial(tx, now, input, 'IDEMPOTENCY_CONFLICT');
      return rejected('IDEMPOTENCY_CONFLICT', 'La creation key è già legata a una richiesta diversa.');
    }
    return {
      ok: true,
      replayed: true,
      value: {
        workflowInstanceId: existing.id,
        currentState: existing.currentState as FaiAuditState,
        stateVersion: existing.stateVersion,
        creationRequestHash: existing.creationRequestHash,
      },
    };
  }

  const instance = await tx.aiWorkflowInstance.create({
    data: {
      creationKey: input.creationKey,
      creationRequestHash,
      workflowCode: FAI_AUDIT_WORKFLOW_ID,
      workflowVersion: FAI_AUDIT_WORKFLOW_VERSION,
      definitionHash: FAI_AUDIT_WORKFLOW_DEFINITION_HASH,
      dataMode: 'synthetic',
      clientId: null,
      companyId: null,
      projectId: null,
      clientServiceId: null,
      currentState: 'CREATED',
      stateVersion: 1,
      correctionCycle: 0,
      createdById: actor.actorId,
      createdAt: now,
    },
  });
  await writeAudit(tx, {
    actorId: actor.actorId,
    event: 'ai_workflow_created',
    entityType: 'AiWorkflowInstance',
    entityId: instance.id,
    after: {
      creationKey: input.creationKey,
      creationRequestHash,
      currentState: 'CREATED',
      definitionHash: FAI_AUDIT_WORKFLOW_DEFINITION_HASH,
      stateVersion: 1,
      workflowCode: FAI_AUDIT_WORKFLOW_ID,
      workflowVersion: FAI_AUDIT_WORKFLOW_VERSION,
    },
    createdAt: now,
  });
  return {
    ok: true,
    replayed: false,
    value: {
      workflowInstanceId: instance.id,
      currentState: 'CREATED',
      stateVersion: 1,
      creationRequestHash,
    },
  };
}

function isUniqueConstraintError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function isRetryableTransactionConflict(error: unknown) {
  return isUniqueConstraintError(error)
    || error instanceof SerializableConflictError;
}

async function withControlledSerializableRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= MAX_SERIALIZABLE_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isRetryableTransactionConflict(error) || attempt === MAX_SERIALIZABLE_ATTEMPTS) throw error;
    }
  }
  throw new Error('Numero massimo di tentativi serializzabili non valido.');
}

export async function createAuditWorkflowInstance(
  prisma: PrismaClient,
  input: CreateAuditWorkflowInput,
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<WorkflowServiceResult<AuditWorkflowInstanceResult>> {
  const env = options.env ?? process.env;
  return withControlledSerializableRetry(
    () => withSerializableTransaction(prisma, (tx) => createAuditWorkflowInstanceTx(tx, input, env)),
  );
}

async function auditUnpersistedCommandDenial(
  tx: Tx,
  now: Date,
  input: ApplyAuditWorkflowTransitionInput,
  actorId: string | null,
  code: WorkflowServiceRejectionCode,
) {
  await writeAudit(tx, {
    actorId,
    event: 'ai_workflow_command_denied',
    entityType: 'AiWorkflowInstance',
    entityId: input.workflowInstanceId || null,
    after: {
      correlationId: isUuidV4(input.correlationId) ? input.correlationId : null,
      rejectionCode: code,
      transitionCode: String(input.transitionCode).slice(0, 64),
    },
    createdAt: now,
  });
}

async function rejectPersistedCommand(
  tx: Tx,
  input: ApplyAuditWorkflowTransitionInput,
  commandId: string,
  actorId: string,
  code: WorkflowServiceRejectionCode,
  message: string,
  now: Date,
) {
  await tx.aiWorkflowCommand.update({
    where: { id: commandId },
    data: { status: 'REJECTED', rejectionCode: code, resolvedAt: now },
  });
  await writeAudit(tx, {
    actorId,
    event: 'ai_workflow_command_denied',
    entityType: 'AiWorkflowInstance',
    entityId: input.workflowInstanceId,
    after: {
      commandId,
      correlationId: input.correlationId,
      expectedState: input.expectedState,
      expectedStateVersion: input.expectedStateVersion,
      rejectionCode: code,
      transitionCode: input.transitionCode,
    },
    createdAt: now,
  });
  return rejected(code, message, { commandId });
}

async function resolveExistingCommand(
  tx: Tx,
  instanceId: string,
  idempotencyKey: string,
  requestHash: string,
): Promise<WorkflowServiceResult<AuditWorkflowTransitionResult> | null> {
  const existing = await tx.aiWorkflowCommand.findUnique({
    where: { workflowInstanceId_idempotencyKey: { workflowInstanceId: instanceId, idempotencyKey } },
    include: { transition: true },
  });
  if (!existing) return null;
  if (existing.requestHash !== requestHash) {
    return rejected('IDEMPOTENCY_CONFLICT', 'La idempotency key è già legata a una richiesta diversa.');
  }
  if (existing.status === 'PENDING') {
    return rejected('COMMAND_IN_PROGRESS', 'Il comando idempotente è ancora in elaborazione.', {
      replayed: true,
      commandId: existing.id,
    });
  }
  if (existing.status === 'REJECTED') {
    if (!isWorkflowServiceRejectionCode(existing.rejectionCode)) {
      return rejected('LEDGER_INTEGRITY_ERROR', 'Codice di rifiuto idempotente non riconosciuto.', {
        replayed: true,
        commandId: existing.id,
      });
    }
    return rejected(
      existing.rejectionCode,
      'Il comando era già stato rifiutato.',
      { replayed: true, commandId: existing.id },
    );
  }
  if (
    existing.status !== 'APPLIED'
    || !existing.transition
    || !existing.resultState
    || existing.resultStateVersion === null
  ) {
    return rejected('LEDGER_INTEGRITY_ERROR', 'Esito idempotente incompleto o incoerente.', {
      replayed: true,
      commandId: existing.id,
    });
  }
  if (existing.transition.jobPlanningVersion === null) {
    const [jobCount, outboxCount] = await Promise.all([
      tx.aiWorkflowJob.count({ where: { sourceTransitionId: existing.transition.id } }),
      tx.aiWorkflowJobOutboxEvent.count({ where: { sourceTransitionId: existing.transition.id } }),
    ]);
    if (jobCount !== 0 || outboxCount !== 0) {
      return rejected('LEDGER_INTEGRITY_ERROR', 'Una transizione legacy contiene artefatti job non autorizzati.', {
        replayed: true,
        commandId: existing.id,
      });
    }
    return {
      ok: true,
      replayed: true,
      value: {
        workflowInstanceId: instanceId,
        commandId: existing.id,
        transitionId: existing.transition.id,
        transitionCode: existing.transition.transitionCode as FaiAuditTransitionCode,
        currentState: existing.resultState as FaiAuditState,
        stateVersion: existing.resultStateVersion,
        stateChanged: existing.transition.fromState !== existing.transition.toState,
        transitionHash: existing.transition.transitionHash,
        jobPlanningStatus: 'LEGACY_NOT_PLANNED',
        jobPlanHash: null,
        plannedJobCount: 0,
      },
    };
  }
  if (existing.transition.jobPlanningVersion !== 1) {
    return rejected('LEDGER_INTEGRITY_ERROR', 'Versione del piano job non riconosciuta.', {
      replayed: true,
      commandId: existing.id,
    });
  }
  const metadata = existing.transition.metadata;
  const jobPlanning = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>).jobPlanning
    : null;
  if (!jobPlanning || typeof jobPlanning !== 'object' || Array.isArray(jobPlanning)) {
    return rejected('LEDGER_INTEGRITY_ERROR', 'Metadati del piano job assenti o incoerenti.', {
      replayed: true,
      commandId: existing.id,
    });
  }
  const jobPlanHash = (jobPlanning as Record<string, unknown>).planHash;
  const plannedJobCount = (jobPlanning as Record<string, unknown>).plannedJobCount;
  if (
    typeof jobPlanHash !== 'string'
    || !/^[0-9a-f]{64}$/.test(jobPlanHash)
    || !Number.isInteger(plannedJobCount)
    || (plannedJobCount as number) < 0
  ) {
    return rejected('LEDGER_INTEGRITY_ERROR', 'Identità del piano job non valida.', {
      replayed: true,
      commandId: existing.id,
    });
  }
  return {
    ok: true,
    replayed: true,
    value: {
      workflowInstanceId: instanceId,
      commandId: existing.id,
      transitionId: existing.transition.id,
      transitionCode: existing.transition.transitionCode as FaiAuditTransitionCode,
      currentState: existing.resultState as FaiAuditState,
      stateVersion: existing.resultStateVersion,
      stateChanged: existing.transition.fromState !== existing.transition.toState,
      transitionHash: existing.transition.transitionHash,
      jobPlanningStatus: 'PLANNED',
      jobPlanHash,
      plannedJobCount: plannedJobCount as number,
    },
  };
}

async function persistJobPlan(
  tx: Tx,
  input: ApplyAuditWorkflowTransitionInput,
  transitionId: string,
  plan: FaiAuditJobPlan,
  now: Date,
) {
  for (const intent of plan.jobs) {
    const job = await tx.aiWorkflowJob.create({
      data: {
        workflowInstanceId: input.workflowInstanceId,
        sourceTransitionId: transitionId,
        sourceTransitionCode: input.transitionCode,
        sourceTransitionSequence: input.expectedStateVersion,
        workflowDefinitionHash: intent.workflowDefinitionHash,
        phaseCode: intent.phaseCode,
        phaseEntrySequence: intent.phaseEntrySequence,
        sourceState: intent.sourceState,
        sourceStateVersion: intent.sourceStateVersion,
        correctionCycle: intent.correctionCycle,
        executorAgentId: intent.executorAgentId,
        executorAgentCode: intent.executorAgentCode,
        executorAgentConfigVersion: intent.executorAgentConfigVersion,
        executorAgentConfigHash: intent.executorAgentConfigHash,
        catalogCode: intent.catalogCode,
        catalogVersion: intent.catalogVersion,
        catalogHash: intent.catalogHash,
        jobCode: intent.jobCode,
        jobVersion: intent.jobVersion,
        jobDefinitionHash: intent.jobDefinitionHash,
        completionTransitionCode: intent.completionTransitionCode,
        completionMode: intent.completionMode,
        slotKey: intent.slotKey,
        bundleCode: intent.bundleCode,
        bundleKey: intent.bundleKey,
        dedupeKey: intent.dedupeKey,
        status: 'PLANNED',
        provider: intent.provider,
        dataMode: intent.dataMode,
        automaticDispatchAllowed: false,
        payload: intent.payload as Prisma.InputJsonObject,
        payloadHash: intent.payloadHash,
        correlationId: input.correlationId,
        plannedAt: now,
        availableAt: now,
        blockedAt: null,
        blockedReasonCode: null,
      },
    });
    const eventPayload: Prisma.InputJsonObject = {
      schemaVersion: 1,
      eventType: 'AI_JOB_PLANNED',
      eventVersion: 1,
      workflowInstanceId: input.workflowInstanceId,
      sourceTransitionId: transitionId,
      sourceTransitionCode: input.transitionCode,
      sourceTransitionSequence: input.expectedStateVersion,
      workflowDefinitionHash: intent.workflowDefinitionHash,
      phaseCode: intent.phaseCode,
      phaseEntrySequence: intent.phaseEntrySequence,
      sourceState: intent.sourceState,
      sourceStateVersion: intent.sourceStateVersion,
      correctionCycle: intent.correctionCycle,
      executor: {
        agentId: intent.executorAgentId,
        agentCode: intent.executorAgentCode,
        configVersion: intent.executorAgentConfigVersion,
        configHash: intent.executorAgentConfigHash,
      },
      job: {
        id: job.id,
        jobCode: intent.jobCode,
        jobVersion: intent.jobVersion,
        dedupeKey: intent.dedupeKey,
        bundleKey: intent.bundleKey,
        status: 'PLANNED',
        provider: 'mock',
        dataMode: 'synthetic',
        automaticDispatchAllowed: false,
        availableAt: intent.availableAt,
        payloadHash: intent.payloadHash,
      },
      occurredAt: now.toISOString(),
    };
    await tx.aiWorkflowJobOutboxEvent.create({
      data: {
        jobId: job.id,
        workflowInstanceId: input.workflowInstanceId,
        sourceTransitionId: transitionId,
        eventKey: canonicalSha256({
          schemaVersion: 1,
          eventType: 'AI_JOB_PLANNED',
          eventVersion: 1,
          jobDedupeKey: intent.dedupeKey,
        }),
        eventType: 'AI_JOB_PLANNED',
        eventVersion: 1,
        payload: eventPayload,
        payloadHash: canonicalSha256(eventPayload),
        deliveryState: 'PENDING',
        occurredAt: now,
      },
    });
  }
}

type FoundationMilestonePhase = 'DATA_VALIDATION' | 'AI_DRAFT' | 'INDEPENDENT_REVIEW';

interface FoundationMilestonePolicy {
  readonly phase: FoundationMilestonePhase;
  readonly canonicalTransitionCodes: readonly FaiAuditTransitionCode[];
  readonly requiredBefore: readonly FaiAuditTransitionCode[];
  readonly selfTransition: boolean;
}

interface FoundationMilestoneSnapshot extends Prisma.InputJsonObject {
  phase: FoundationMilestonePhase | null;
  phaseEntrySequence: number | null;
  canonicalTransitionCodes: Prisma.InputJsonArray;
  requiredTransitionCodes: Prisma.InputJsonArray;
  completedTransitionCodes: Prisma.InputJsonArray;
  decision: 'NOT_REQUIRED' | 'SATISFIED';
}

const DATA_VALIDATION_MILESTONES = ['WF-005', 'WF-006', 'WF-007'] as const;
const AI_DRAFT_MILESTONES = ['WF-012'] as const;
const REVIEW_MILESTONES = ['WF-014'] as const;

const foundationMilestonePolicies: Partial<Record<FaiAuditTransitionCode, FoundationMilestonePolicy>> = {
  'WF-005': {
    phase: 'DATA_VALIDATION',
    canonicalTransitionCodes: DATA_VALIDATION_MILESTONES,
    requiredBefore: [],
    selfTransition: true,
  },
  'WF-006': {
    phase: 'DATA_VALIDATION',
    canonicalTransitionCodes: DATA_VALIDATION_MILESTONES,
    requiredBefore: ['WF-005'],
    selfTransition: true,
  },
  'WF-007': {
    phase: 'DATA_VALIDATION',
    canonicalTransitionCodes: DATA_VALIDATION_MILESTONES,
    requiredBefore: ['WF-005', 'WF-006'],
    selfTransition: true,
  },
  'WF-010': {
    phase: 'DATA_VALIDATION',
    canonicalTransitionCodes: DATA_VALIDATION_MILESTONES,
    requiredBefore: DATA_VALIDATION_MILESTONES,
    selfTransition: false,
  },
  'WF-012': {
    phase: 'AI_DRAFT',
    canonicalTransitionCodes: AI_DRAFT_MILESTONES,
    requiredBefore: [],
    selfTransition: true,
  },
  'WF-013': {
    phase: 'AI_DRAFT',
    canonicalTransitionCodes: AI_DRAFT_MILESTONES,
    requiredBefore: AI_DRAFT_MILESTONES,
    selfTransition: false,
  },
  'WF-014': {
    phase: 'INDEPENDENT_REVIEW',
    canonicalTransitionCodes: REVIEW_MILESTONES,
    requiredBefore: [],
    selfTransition: true,
  },
  'WF-015': {
    phase: 'INDEPENDENT_REVIEW',
    canonicalTransitionCodes: REVIEW_MILESTONES,
    requiredBefore: REVIEW_MILESTONES,
    selfTransition: false,
  },
  'WF-017': {
    phase: 'INDEPENDENT_REVIEW',
    canonicalTransitionCodes: REVIEW_MILESTONES,
    requiredBefore: REVIEW_MILESTONES,
    selfTransition: false,
  },
};

function sameTransitionSequence(
  actual: readonly string[],
  expected: readonly FaiAuditTransitionCode[],
) {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

async function evaluatePersistedMilestones(
  tx: Tx,
  instanceId: string,
  transitionCode: FaiAuditTransitionCode,
): Promise<
  | { readonly allowed: true; readonly snapshot: FoundationMilestoneSnapshot }
  | {
      readonly allowed: false;
      readonly code: 'MILESTONE_NOT_COMPLETED' | 'MILESTONE_OUT_OF_ORDER' | 'MILESTONE_DUPLICATE';
      readonly message: string;
    }
> {
  const policy = foundationMilestonePolicies[transitionCode];
  if (!policy) {
    return {
      allowed: true,
      snapshot: {
        phase: null,
        phaseEntrySequence: null,
        canonicalTransitionCodes: [],
        requiredTransitionCodes: [],
        completedTransitionCodes: [],
        decision: 'NOT_REQUIRED',
      },
    };
  }

  const phaseEntry = await tx.aiWorkflowTransition.findFirst({
    where: {
      workflowInstanceId: instanceId,
      toState: policy.phase,
      fromState: { not: policy.phase },
    },
    orderBy: { sequence: 'desc' },
    select: { sequence: true },
  });
  if (!phaseEntry) {
    return {
      allowed: false,
      code: 'MILESTONE_NOT_COMPLETED',
      message: `La fase ${policy.phase} non ha un ingresso persistito valido.`,
    };
  }

  const completedRows = await tx.aiWorkflowTransition.findMany({
    where: {
      workflowInstanceId: instanceId,
      sequence: { gt: phaseEntry.sequence },
      transitionCode: { in: [...policy.canonicalTransitionCodes] },
    },
    orderBy: { sequence: 'asc' },
    select: { transitionCode: true },
  });
  const completed = completedRows.map((row) => row.transitionCode);

  const canonicalPrefix = policy.canonicalTransitionCodes.slice(0, completed.length);
  if (!sameTransitionSequence(completed, canonicalPrefix)) {
    return {
      allowed: false,
      code: 'MILESTONE_OUT_OF_ORDER',
      message: `Le milestone persistite della fase ${policy.phase} non rispettano l'ordine canonico.`,
    };
  }
  if (policy.selfTransition && completed.includes(transitionCode)) {
    return {
      allowed: false,
      code: 'MILESTONE_DUPLICATE',
      message: `${transitionCode} è già completata nella fase o nel ciclo corrente.`,
    };
  }
  if (!sameTransitionSequence(completed, policy.requiredBefore)) {
    return {
      allowed: false,
      code: policy.selfTransition ? 'MILESTONE_OUT_OF_ORDER' : 'MILESTONE_NOT_COMPLETED',
      message: policy.selfTransition
        ? `${transitionCode} non è la prossima milestone prevista nella fase ${policy.phase}.`
        : `Le milestone richieste prima di ${transitionCode} non risultano completate nella fase corrente.`,
    };
  }

  return {
    allowed: true,
    snapshot: {
      phase: policy.phase,
      phaseEntrySequence: phaseEntry.sequence,
      canonicalTransitionCodes: [...policy.canonicalTransitionCodes],
      requiredTransitionCodes: [...policy.requiredBefore],
      completedTransitionCodes: completed,
      decision: 'SATISFIED',
    },
  };
}

function resolvePhaseIdentity(
  sourceState: FaiAuditState,
  targetState: FaiAuditState,
  sourceTransitionSequence: number,
  milestone: FoundationMilestoneSnapshot,
) {
  if (sourceState !== targetState) {
    return { phaseCode: targetState, phaseEntrySequence: sourceTransitionSequence } as const;
  }
  if (
    milestone.phase !== targetState
    || !Number.isInteger(milestone.phaseEntrySequence)
    || (milestone.phaseEntrySequence as number) < 1
    || (milestone.phaseEntrySequence as number) >= sourceTransitionSequence
  ) return null;
  return {
    phaseCode: targetState,
    phaseEntrySequence: milestone.phaseEntrySequence as number,
  } as const;
}

function foundationSeparationChecks(transitionCode: FaiAuditTransitionCode): Prisma.InputJsonArray {
  return [
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
  ];
}

async function applyAuditWorkflowTransitionTx(
  tx: Tx,
  input: ApplyAuditWorkflowTransitionInput,
  env: NodeJS.ProcessEnv,
): Promise<WorkflowServiceResult<AuditWorkflowTransitionResult>> {
  const now = await databaseNow(tx);
  const transition = getAuditWorkflowTransition(input.transitionCode);
  if (
    !transition
    || !isUuidV4(input.idempotencyKey)
    || !isUuidV4(input.correlationId)
    || !input.workflowInstanceId?.trim()
    || input.expectedDefinitionHash !== FAI_AUDIT_WORKFLOW_DEFINITION_HASH
    || !Number.isInteger(input.expectedStateVersion)
    || input.expectedStateVersion < 1
    || (input.reasonCode != null && !REASON_CODE_PATTERN.test(input.reasonCode))
  ) {
    await auditUnpersistedCommandDenial(tx, now, input, null, 'INVALID_INPUT');
    return rejected('INVALID_INPUT', 'Comando workflow non valido.');
  }
  if (!foundationTransitionCodeSet.has(transition.transitionCode)) {
    await auditUnpersistedCommandDenial(tx, now, input, null, 'FOUNDATION_SCOPE_LIMIT');
    return rejected(
      'FOUNDATION_SCOPE_LIMIT',
      `${transition.transitionCode} appartiene al ciclo canonico ma non è invocabile dalla State Machine Foundation.`,
    );
  }
  const gateResults = normalizeGateResults(input.gateResults, transition.gate);
  const preconditions = normalizePreconditions(input.preconditions, transition.preconditions);
  if (!gateResults || !preconditions) {
    await auditUnpersistedCommandDenial(tx, now, input, null, 'INVALID_INPUT');
    return rejected('INVALID_INPUT', 'Gate o precondizioni non appartengono alla definizione.');
  }
  if (input.expectedState !== transition.from) {
    await auditUnpersistedCommandDenial(tx, now, input, null, 'STATE_MISMATCH');
    return rejected('STATE_MISMATCH', `${transition.transitionCode} richiede lo stato ${transition.from}.`);
  }

  const instance = await tx.aiWorkflowInstance.findUnique({ where: { id: input.workflowInstanceId } });
  if (!instance) {
    await auditUnpersistedCommandDenial(tx, now, input, null, 'WORKFLOW_NOT_FOUND');
    return rejected('WORKFLOW_NOT_FOUND', 'Istanza workflow non disponibile.');
  }
  const actor = await resolveActor(tx, input.actor);
  if (!actor) {
    await auditUnpersistedCommandDenial(tx, now, input, null, 'ACTOR_NOT_FOUND');
    return rejected('ACTOR_NOT_FOUND', 'Identità attore non valida o disattivata.');
  }
  if (actor.kind !== transition.actorKind) {
    await auditUnpersistedCommandDenial(tx, now, input, actor.actorId, 'ACTOR_NOT_ALLOWED');
    return rejected('ACTOR_NOT_ALLOWED', `${transition.transitionCode} richiede un attore ${transition.actorKind}.`);
  }
  if (hasReservedContext(instance)) {
    await auditUnpersistedCommandDenial(tx, now, input, actor.actorId, 'SYNTHETIC_CONTEXT_REQUIRED');
    return rejected('SYNTHETIC_CONTEXT_REQUIRED', 'I collegamenti a dati CRM sono vietati nella foundation sintetica.');
  }

  let requestHash: string;
  try {
    requestHash = createAuditWorkflowCommandRequestHash(input);
  } catch {
    await auditUnpersistedCommandDenial(tx, now, input, actor.actorId, 'INVALID_INPUT');
    return rejected('INVALID_INPUT', 'Impossibile canonicalizzare il comando workflow.');
  }

  const permissionDecision = transition.requiredPermission === null
    ? null
    : actor.permissionDecisions?.[transition.requiredPermission] ?? null;
  const permissionDenied = transition.requiredPermission !== null && permissionDecision?.allowed !== true;

  const settings = await loadSafeSettings(tx, env);
  if (!settings.stateMachineReady) {
    await auditUnpersistedCommandDenial(tx, now, input, actor.actorId, 'ORCHESTRATOR_DISABLED');
    return rejected(
      'ORCHESTRATOR_DISABLED',
      'State Machine Foundation disabilitata o configurazione fail-closed.',
    );
  }
  if (settings.externalProviderSwitchOpen) {
    await auditUnpersistedCommandDenial(tx, now, input, actor.actorId, 'EXTERNAL_PROVIDERS_MUST_BE_DISABLED');
    return rejected(
      'EXTERNAL_PROVIDERS_MUST_BE_DISABLED',
      'I provider esterni devono essere completamente disabilitati.',
    );
  }

  const existing = await resolveExistingCommand(tx, instance.id, input.idempotencyKey, requestHash);
  if (existing) {
    if (permissionDenied) {
      await auditUnpersistedCommandDenial(tx, now, input, actor.actorId, 'PERMISSION_DENIED');
      return rejected('PERMISSION_DENIED', `Permesso ${transition.requiredPermission} non disponibile.`);
    }
    if (!existing.ok && existing.code === 'IDEMPOTENCY_CONFLICT') {
      await auditUnpersistedCommandDenial(tx, now, input, actor.actorId, 'IDEMPOTENCY_CONFLICT');
    }
    return existing;
  }

  const command = await tx.aiWorkflowCommand.create({
    data: {
      workflowInstanceId: instance.id,
      transitionCode: transition.transitionCode,
      eventType: transition.event,
      idempotencyKey: input.idempotencyKey,
      requestHash,
      definitionHash: FAI_AUDIT_WORKFLOW_DEFINITION_HASH,
      expectedState: input.expectedState,
      expectedStateVersion: input.expectedStateVersion,
      actorKind: actor.kind,
      ...actor.commandIdentity,
      correlationId: input.correlationId,
      status: 'PENDING',
      createdAt: now,
    },
  });

  if (permissionDenied) {
    return rejectPersistedCommand(
      tx,
      input,
      command.id,
      actor.actorId,
      'PERMISSION_DENIED',
      `Permesso ${transition.requiredPermission} non disponibile.`,
      now,
    );
  }

  if (
    instance.workflowCode !== FAI_AUDIT_WORKFLOW_ID
    || instance.workflowVersion !== FAI_AUDIT_WORKFLOW_VERSION
    || instance.definitionHash !== FAI_AUDIT_WORKFLOW_DEFINITION_HASH
  ) {
    return rejectPersistedCommand(
      tx, input, command.id, actor.actorId, 'DEFINITION_MISMATCH', 'Contratto workflow persistito non coerente.', now,
    );
  }
  if (instance.currentState !== input.expectedState || instance.stateVersion !== input.expectedStateVersion) {
    return rejectPersistedCommand(
      tx,
      input,
      command.id,
      actor.actorId,
      'STATE_VERSION_MISMATCH',
      'Stato o versione attesi sono obsoleti.',
      now,
    );
  }

  const previous = await tx.aiWorkflowTransition.findFirst({
    where: { workflowInstanceId: instance.id },
    orderBy: { sequence: 'desc' },
  });
  if (
    (
      instance.stateVersion === 1
      && (previous !== null || instance.currentState !== 'CREATED' || instance.correctionCycle !== 0)
    )
    || (
      instance.stateVersion > 1
      && (
        !previous
        || previous.sequence !== instance.stateVersion - 1
        || previous.toVersion !== instance.stateVersion
        || previous.toState !== instance.currentState
        || previous.definitionHash !== instance.definitionHash
      )
    )
  ) {
    return rejectPersistedCommand(
      tx,
      input,
      command.id,
      actor.actorId,
      'LEDGER_INTEGRITY_ERROR',
      'La catena delle transizioni non coincide con lo stato corrente.',
      now,
    );
  }

  const milestoneEvaluation = await evaluatePersistedMilestones(tx, instance.id, transition.transitionCode);
  if (!milestoneEvaluation.allowed) {
    return rejectPersistedCommand(
      tx,
      input,
      command.id,
      actor.actorId,
      milestoneEvaluation.code,
      milestoneEvaluation.message,
      now,
    );
  }

  const evaluation = evaluateAuditWorkflowTransition({
    workflowId: instance.workflowCode,
    workflowVersion: instance.workflowVersion,
    definitionHash: instance.definitionHash,
    transitionCode: transition.transitionCode,
    currentState: instance.currentState,
    actor: { actorId: actor.actorId, kind: actor.kind, executionMode: actor.executionMode },
    gateResults: Object.fromEntries(Object.entries(gateResults).map(([key, value]) => [key, value ?? undefined])),
    preconditions: Object.fromEntries(Object.entries(preconditions).map(([key, value]) => [key, value ?? undefined])),
    grantedPermissions: actor.grantedPermissions,
    provider: settings.orchestrator?.provider,
    externalProvidersEnabled: settings.externalProviderSwitchOpen,
    correctionCycle: instance.correctionCycle,
    manualReleaseConfirmed: input.manualReleaseConfirmed,
    reasonCode: input.reasonCode,
  });
  if (!evaluation.allowed) {
    return rejectPersistedCommand(
      tx, input, command.id, actor.actorId, evaluation.code, evaluation.reason, now,
    );
  }
  if (evaluation.automaticDispatchAllowed !== false) {
    return rejectPersistedCommand(
      tx,
      input,
      command.id,
      actor.actorId,
      'LEDGER_INTEGRITY_ERROR',
      'Il contratto Foundation non può autorizzare dispatch automatico.',
      now,
    );
  }

  const nextVersion = instance.stateVersion + 1;
  const nextCorrectionCycle = transition.incrementsCorrectionCycle
    ? instance.correctionCycle + 1
    : instance.correctionCycle;
  const phaseIdentity = resolvePhaseIdentity(
    instance.currentState as FaiAuditState,
    evaluation.nextState,
    instance.stateVersion,
    milestoneEvaluation.snapshot,
  );
  if (!phaseIdentity) {
    return rejectPersistedCommand(
      tx,
      input,
      command.id,
      actor.actorId,
      'LEDGER_INTEGRITY_ERROR',
      'Identità causale della fase non risolvibile dal ledger persistito.',
      now,
    );
  }
  const resolvedExecutors = await resolveCanonicalJobExecutors(tx, transition.transitionCode);
  if (!resolvedExecutors) throw new CanonicalExecutorUnavailableError();
  const jobPlan = createFaiAuditJobPlan({
    workflowInstanceId: instance.id,
    workflowCode: instance.workflowCode,
    workflowVersion: instance.workflowVersion,
    workflowDefinitionHash: instance.definitionHash,
    phaseCode: phaseIdentity.phaseCode,
    phaseEntrySequence: phaseIdentity.phaseEntrySequence,
    sourceCommandIdempotencyKey: input.idempotencyKey,
    sourceTransitionCode: transition.transitionCode,
    sourceTransitionSequence: instance.stateVersion,
    sourceState: instance.currentState as FaiAuditState,
    sourceStateVersion: instance.stateVersion,
    targetState: evaluation.nextState,
    correlationId: input.correlationId,
    correctionCycle: nextCorrectionCycle,
    availableAt: now.toISOString(),
    resolvedExecutors,
  });

  const guardSnapshot: Prisma.InputJsonObject = {
    schemaVersion: 1,
    actor: {
      kind: actor.kind,
      humanRole: actor.humanRole,
    },
    permission: {
      required: transition.requiredPermission,
      granted: transition.requiredPermission === null ? true : permissionDecision?.allowed === true,
      source: transition.requiredPermission === null ? 'NOT_REQUIRED' : permissionDecision?.source ?? 'ROLE',
    },
    correctionCycle: instance.correctionCycle,
    orchestratorSetting: {
      id: settings.orchestrator?.id ?? ORCHESTRATOR_SETTING_ID,
      stateMachineEnabled: settings.orchestrator?.stateMachineEnabled ?? false,
      dispatchEnabled: settings.orchestrator?.dispatchEnabled ?? false,
      provider: settings.orchestrator?.provider ?? null,
      syntheticDataOnly: settings.orchestrator?.syntheticDataOnly ?? false,
      version: settings.orchestrator?.version ?? null,
      updatedAt: settings.orchestrator?.updatedAt.toISOString() ?? null,
    },
    providerPolicy: {
      databaseExternalProvidersEnabled: settings.databaseExternalProvidersEnabled,
      environmentExternalProvidersEnabled: settings.environmentExternalProvidersEnabled,
      effectiveExternalProvidersEnabled: settings.externalProviderSwitchOpen,
    },
    foundationPolicy: {
      transitionInScope: true,
      automaticDispatchAllowed: evaluation.automaticDispatchAllowed,
    },
    gate: {
      code: transition.gate,
      result: gateResults[transition.gate] ?? null,
      passed: gateResults[transition.gate] === 'PASS',
    },
    preconditions: transition.preconditions.map((code) => ({
      code,
      result: preconditions[code] ?? null,
      passed: preconditions[code] === true,
    })),
    milestone: milestoneEvaluation.snapshot,
    separationChecks: foundationSeparationChecks(transition.transitionCode),
  };
  const guardSnapshotHash = canonicalSha256(guardSnapshot);

  const cas = await tx.aiWorkflowInstance.updateMany({
    where: {
      id: instance.id,
      workflowCode: FAI_AUDIT_WORKFLOW_ID,
      workflowVersion: FAI_AUDIT_WORKFLOW_VERSION,
      definitionHash: FAI_AUDIT_WORKFLOW_DEFINITION_HASH,
      currentState: instance.currentState,
      stateVersion: instance.stateVersion,
      correctionCycle: instance.correctionCycle,
    },
    data: {
      currentState: evaluation.nextState,
      stateVersion: { increment: 1 },
      correctionCycle: nextCorrectionCycle,
      lastTransitionAt: now,
    },
  });
  if (cas.count !== 1) {
    return rejectPersistedCommand(
      tx,
      input,
      command.id,
      actor.actorId,
      'STATE_VERSION_MISMATCH',
      'La compare-and-swap della state machine non è stata acquisita.',
      now,
    );
  }

  const transitionHash = canonicalSha256({
    actor: actorHashIdentity(input.actor),
    commandId: command.id,
    correlationId: input.correlationId,
    createdAt: now.toISOString(),
    definitionHash: FAI_AUDIT_WORKFLOW_DEFINITION_HASH,
    fromState: instance.currentState,
    fromVersion: instance.stateVersion,
    guardSnapshotHash,
    jobCatalogHash: jobPlan.catalogHash,
    jobPlanHash: jobPlan.planHash,
    previousTransitionHash: previous?.transitionHash ?? null,
    reasonCode: input.reasonCode ?? null,
    sequence: instance.stateVersion,
    toState: evaluation.nextState,
    toVersion: nextVersion,
    transitionCode: transition.transitionCode,
    workflowInstanceId: instance.id,
  });
  const ledgerEntry = await tx.aiWorkflowTransition.create({
    data: {
      workflowInstanceId: instance.id,
      commandId: command.id,
      transitionCode: transition.transitionCode,
      eventType: transition.event,
      sequence: instance.stateVersion,
      fromState: instance.currentState,
      toState: evaluation.nextState,
      fromVersion: instance.stateVersion,
      toVersion: nextVersion,
      definitionHash: FAI_AUDIT_WORKFLOW_DEFINITION_HASH,
      guardSnapshot,
      guardSnapshotHash,
      previousTransitionHash: previous?.transitionHash ?? null,
      transitionHash,
      actorKind: actor.kind,
      ...actor.transitionIdentity,
      reasonCode: input.reasonCode ?? null,
      correlationId: input.correlationId,
      metadata: {
        automaticDispatchAllowed: false,
        effect: evaluation.effect,
        stateChanged: evaluation.stateChanged,
        jobPlanning: {
          schemaVersion: 2,
          catalogKey: FAI_AUDIT_JOB_CATALOG_KEY,
          catalogHash: FAI_AUDIT_JOB_CATALOG_HASH,
          executorBindingVersion: FAI_AUDIT_EXECUTOR_BINDING_VERSION,
          workflowDefinitionHash: instance.definitionHash,
          phaseCode: phaseIdentity.phaseCode,
          phaseEntrySequence: phaseIdentity.phaseEntrySequence,
          sourceState: instance.currentState,
          sourceStateVersion: instance.stateVersion,
          correctionCycle: nextCorrectionCycle,
          executors: resolvedExecutors.map((executor) => ({
            jobCode: executor.jobCode,
            executorAgentId: executor.executorAgentId,
            executorAgentCode: executor.executorAgentCode,
            executorAgentConfigVersion: executor.executorAgentConfigVersion,
            executorAgentConfigHash: executor.executorAgentConfigHash,
          })),
          planHash: jobPlan.planHash,
          plannedJobCount: jobPlan.jobs.length,
          automaticDispatchAllowed: false,
        },
      },
      jobPlanningVersion: 1,
      createdAt: now,
    },
  });
  await persistJobPlan(tx, input, ledgerEntry.id, jobPlan, now);
  await tx.aiWorkflowCommand.update({
    where: { id: command.id },
    data: {
      status: 'APPLIED',
      resultState: evaluation.nextState,
      resultStateVersion: nextVersion,
      resolvedAt: now,
    },
  });
  await writeAudit(tx, {
    actorId: actor.actorId,
    event: evaluation.stateChanged ? 'ai_workflow_state_changed' : 'ai_workflow_step_completed',
    entityType: 'AiWorkflowInstance',
    entityId: instance.id,
    before: {
      correctionCycle: instance.correctionCycle,
      currentState: instance.currentState,
      stateVersion: instance.stateVersion,
    },
    after: {
      commandId: command.id,
      correctionCycle: nextCorrectionCycle,
      correlationId: input.correlationId,
      currentState: evaluation.nextState,
      definitionHash: FAI_AUDIT_WORKFLOW_DEFINITION_HASH,
      stateVersion: nextVersion,
      transitionCode: transition.transitionCode,
      transitionHash,
      jobPlanningStatus: 'PLANNED',
      jobPlanHash: jobPlan.planHash,
      plannedJobCount: jobPlan.jobs.length,
    },
    createdAt: now,
  });

  return {
    ok: true,
    replayed: false,
    value: {
      workflowInstanceId: instance.id,
      commandId: command.id,
      transitionId: ledgerEntry.id,
      transitionCode: transition.transitionCode,
      currentState: evaluation.nextState,
      stateVersion: nextVersion,
      stateChanged: evaluation.stateChanged,
      transitionHash,
      jobPlanningStatus: 'PLANNED',
      jobPlanHash: jobPlan.planHash,
      plannedJobCount: jobPlan.jobs.length,
    },
  };
}

export async function applyAuditWorkflowTransition(
  prisma: PrismaClient,
  input: ApplyAuditWorkflowTransitionInput,
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<WorkflowServiceResult<AuditWorkflowTransitionResult>> {
  const env = options.env ?? process.env;
  try {
    return await withControlledSerializableRetry(
      () => withSerializableTransaction(prisma, (tx) => applyAuditWorkflowTransitionTx(tx, input, env)),
    );
  } catch (error) {
    if (error instanceof CanonicalExecutorUnavailableError) {
      return rejected('LEDGER_INTEGRITY_ERROR', error.message);
    }
    throw error;
  }
}
