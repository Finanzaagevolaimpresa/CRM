import { Prisma, type PrismaClient } from '@prisma/client';
import { canonicalSha256 } from '../canonical-json';
import { hasPermission } from '../permission-evaluator';
import { SerializableConflictError, withSerializableTransaction } from '../serializable';
import {
  FAI_AUDIT_WORKFLOW_DEFINITION_HASH,
  FAI_AUDIT_WORKFLOW_ID,
  FAI_AUDIT_WORKFLOW_VERSION,
  evaluateAuditWorkflowTransition,
  getAuditWorkflowTransition,
  type AuditWorkflowDenialCode,
  type FaiAuditState,
  type FaiAuditTransitionCode,
  type WorkflowExecutionMode,
} from './audit-workflow-v1-1';

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REASON_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/;
const ORCHESTRATOR_SETTING_ID = 'global';
const ALLOWED_SYSTEM_CODE = 'AI_ORCHESTRATOR' as const;
const MAX_SERIALIZABLE_ATTEMPTS = 2;

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
}

interface ResolvedActor {
  readonly kind: AuditWorkflowActor['kind'];
  readonly actorId: string;
  readonly executionMode: WorkflowExecutionMode;
  readonly grantedPermissions: readonly string[];
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
    const grantedPermissions = (['ai.run', 'ai.review', 'ai.approve'] as const)
      .filter((permission) => hasPermission(permissionSession, permission));
    return {
      kind: 'HUMAN',
      actorId: user.id,
      executionMode: 'INTERACTIVE',
      grantedPermissions,
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
  const orchestratorReady = Boolean(
    orchestrator
    && orchestrator.dispatchEnabled === true
    && orchestrator.syntheticDataOnly === true
    && orchestrator.provider === 'mock'
    && orchestrator.version >= 1,
  );
  const externalProviderSwitchOpen = externalControl?.externalProvidersEnabled === true
    || env.AI_EXTERNAL_PROVIDERS_ENABLED === 'true';
  return { orchestrator, orchestratorReady, externalProviderSwitchOpen };
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

  const settings = await loadSafeSettings(tx, env);
  if (!settings.orchestratorReady) {
    await auditCreationDenial(tx, now, input, 'ORCHESTRATOR_DISABLED');
    return rejected('ORCHESTRATOR_DISABLED', 'AI Orchestrator disabilitato o configurazione fail-closed.');
  }
  if (settings.externalProviderSwitchOpen) {
    await auditCreationDenial(tx, now, input, 'EXTERNAL_PROVIDERS_MUST_BE_DISABLED');
    return rejected(
      'EXTERNAL_PROVIDERS_MUST_BE_DISABLED',
      'I provider AI esterni devono essere completamente disabilitati.',
    );
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
    },
  };
}

async function enforceHumanSeparation(
  tx: Tx,
  instanceId: string,
  transitionCode: string,
  actor: ResolvedActor,
) {
  if (actor.kind !== 'HUMAN') return null;
  if (transitionCode === 'WF-018' || transitionCode === 'WF-019') {
    const reviewer = await tx.aiWorkflowTransition.findFirst({
      where: { workflowInstanceId: instanceId, transitionCode: 'WF-017' },
      orderBy: { sequence: 'desc' },
      select: { actorUserId: true },
    });
    if (!reviewer?.actorUserId || reviewer.actorUserId === actor.actorId) return 'APPROVER_SEPARATION_FAILED' as const;
  }
  if (transitionCode === 'WF-020') {
    const approver = await tx.aiWorkflowTransition.findFirst({
      where: { workflowInstanceId: instanceId, transitionCode: 'WF-018' },
      orderBy: { sequence: 'desc' },
      select: { actorUserId: true },
    });
    if (!approver?.actorUserId || approver.actorUserId === actor.actorId) return 'RELEASE_DUAL_CONTROL_FAILED' as const;
  }
  return null;
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

  const permissionDenied = Boolean(
    transition.requiredPermission
    && !actor.grantedPermissions.includes(transition.requiredPermission),
  );

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
  const settings = await loadSafeSettings(tx, env);
  if (!settings.orchestratorReady) {
    return rejectPersistedCommand(
      tx, input, command.id, actor.actorId, 'ORCHESTRATOR_DISABLED', 'AI Orchestrator disabilitato o fail-closed.', now,
    );
  }
  if (settings.externalProviderSwitchOpen) {
    return rejectPersistedCommand(
      tx,
      input,
      command.id,
      actor.actorId,
      'EXTERNAL_PROVIDERS_MUST_BE_DISABLED',
      'I provider esterni devono essere completamente disabilitati.',
      now,
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

  const separationFailure = await enforceHumanSeparation(tx, instance.id, transition.transitionCode, actor);
  if (separationFailure) {
    return rejectPersistedCommand(
      tx,
      input,
      command.id,
      actor.actorId,
      separationFailure,
      separationFailure === 'APPROVER_SEPARATION_FAILED'
        ? 'Revisore e approvatore devono essere persone distinte.'
        : 'Approvatore e operatore di rilascio devono essere persone distinte.',
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

  const previous = await tx.aiWorkflowTransition.findFirst({
    where: { workflowInstanceId: instance.id },
    orderBy: { sequence: 'desc' },
  });
  if (
    (instance.stateVersion === 1 && previous !== null)
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

  const guardSnapshotHash = canonicalSha256({
    actor: {
      identity: actorHashIdentity(input.actor),
      requiredPermission: transition.requiredPermission,
      requiredPermissionGranted: transition.requiredPermission === null
        || actor.grantedPermissions.includes(transition.requiredPermission),
    },
    correctionCycle: instance.correctionCycle,
    externalProvidersDisabled: !settings.externalProviderSwitchOpen,
    gateResults,
    manualReleaseConfirmed: input.manualReleaseConfirmed ?? null,
    orchestratorSetting: {
      dispatchEnabled: settings.orchestrator?.dispatchEnabled ?? false,
      provider: settings.orchestrator?.provider ?? null,
      syntheticDataOnly: settings.orchestrator?.syntheticDataOnly ?? false,
      version: settings.orchestrator?.version ?? null,
    },
    preconditions,
  });

  const nextVersion = instance.stateVersion + 1;
  const nextCorrectionCycle = transition.incrementsCorrectionCycle
    ? instance.correctionCycle + 1
    : instance.correctionCycle;
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
      guardSnapshotHash,
      previousTransitionHash: previous?.transitionHash ?? null,
      transitionHash,
      actorKind: actor.kind,
      ...actor.transitionIdentity,
      reasonCode: input.reasonCode ?? null,
      correlationId: input.correlationId,
      metadata: {
        automaticDispatchAllowed: evaluation.automaticDispatchAllowed,
        effect: evaluation.effect,
        stateChanged: evaluation.stateChanged,
      },
      createdAt: now,
    },
  });
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
    },
  };
}

export async function applyAuditWorkflowTransition(
  prisma: PrismaClient,
  input: ApplyAuditWorkflowTransitionInput,
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<WorkflowServiceResult<AuditWorkflowTransitionResult>> {
  const env = options.env ?? process.env;
  return withControlledSerializableRetry(
    () => withSerializableTransaction(prisma, (tx) => applyAuditWorkflowTransitionTx(tx, input, env)),
  );
}
