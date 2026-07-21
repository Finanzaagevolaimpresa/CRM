import { z } from 'zod';
import type { Permission } from '../permissions';
import {
  AI_ORCHESTRATOR_ADMIN_CHANGE_REASON_CODES,
  AI_ORCHESTRATOR_ADMIN_GENESIS_GLOBAL_POLICY,
  AI_ORCHESTRATOR_ADMIN_NON_GLOBAL_SCOPE_TYPES,
  AiOrchestratorAdminChangeReasonCodeSchema,
  AiOrchestratorAdminGlobalPolicySchema,
  AiOrchestratorAdminNonGlobalScopeTypeSchema,
  AiOrchestratorAdminReasonSchema,
  AiOrchestratorAdminScopePolicySchema,
  createAiOrchestratorAdminGenesisPolicy,
  getAiOrchestratorAdminControlTarget,
  type AiOrchestratorAdminChangeReasonCode,
  type AiOrchestratorAdminGlobalPolicy,
  type AiOrchestratorAdminNonGlobalScopeType,
  type AiOrchestratorAdminScopePolicy,
} from './admin-control-policy-v1';
import type {
  AiOrchestratorAdminDesiredPolicySnapshot,
  AiOrchestratorAdminRevisionSnapshot,
} from './admin-control-plane-v1';

export const AI_ORCHESTRATOR_ADMIN_POLICY_CONFIRMATION_PHRASE = 'CONFERMO CONFIGURAZIONE DESIDERATA' as const;
export const AI_ORCHESTRATOR_ADMIN_EMERGENCY_CONFIRMATION_PHRASE = 'CONFERMO ARRESTO DI EMERGENZA' as const;

export const AI_ORCHESTRATOR_ADMIN_UI_RESULT_CODES = Object.freeze([
  'UPDATED',
  'REPLAYED',
  'ACTOR_NOT_AUTHORIZED',
  'CAS_MISMATCH',
  'LEDGER_INTEGRITY_ERROR',
  'NO_CHANGE',
  'REQUEST_ID_COLLISION',
  'TARGET_NOT_FOUND',
  'INVALID_INPUT',
  'TECHNICAL_ERROR',
] as const);

export type AiOrchestratorAdminUiResultCode = typeof AI_ORCHESTRATOR_ADMIN_UI_RESULT_CODES[number];

export const AI_ORCHESTRATOR_ADMIN_HISTORY_MODES = Object.freeze(['all', 'global', 'scope'] as const);
export type AiOrchestratorAdminHistoryMode = typeof AI_ORCHESTRATOR_ADMIN_HISTORY_MODES[number];

const uiResultCodeSchema = z.enum(AI_ORCHESTRATOR_ADMIN_UI_RESULT_CODES);
const historyModeSchema = z.enum(AI_ORCHESTRATOR_ADMIN_HISTORY_MODES);

export const AI_ORCHESTRATOR_ADMIN_UI_RESULT_MESSAGES: Readonly<Record<AiOrchestratorAdminUiResultCode, string>> = Object.freeze({
  UPDATED: 'Configurazione desiderata registrata nel ledger.',
  REPLAYED: 'Richiesta già registrata: nessuna nuova revisione è stata creata.',
  ACTOR_NOT_AUTHORIZED: 'Permessi AI Orchestrator insufficienti per questa modifica.',
  CAS_MISMATCH: 'La configurazione è cambiata in un’altra sessione. Ricaricare e verificare la nuova versione.',
  LEDGER_INTEGRITY_ERROR: 'Verifica di integrità non superata. Le modifiche restano bloccate.',
  NO_CHANGE: 'Nessuna variazione rispetto alla configurazione corrente.',
  REQUEST_ID_COLLISION: 'La chiave della richiesta risulta già associata a un contenuto differente.',
  TARGET_NOT_FOUND: 'Target canonico non disponibile. Le modifiche restano bloccate.',
  INVALID_INPUT: 'Dati della richiesta non validi. Verificare i campi e riprovare.',
  TECHNICAL_ERROR: 'Operazione non completata per un errore tecnico minimizzato.',
});

export function parseAiOrchestratorAdminUiResultCode(value: unknown) {
  const parsed = uiResultCodeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function parseAiOrchestratorAdminHistoryMode(value: unknown): AiOrchestratorAdminHistoryMode {
  const parsed = historyModeSchema.safeParse(value);
  return parsed.success ? parsed.data : 'all';
}

export const AI_ORCHESTRATOR_ADMIN_SCOPE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  GLOBAL: 'Policy globale',
  PROVIDER: 'Provider',
  AGENT: 'Agenti',
  CAPABILITY: 'Capability',
  JOB: 'Job',
  WORKFLOW: 'Workflow',
});

export const AI_ORCHESTRATOR_ADMIN_BLOCK_REASON_LABELS: Readonly<Record<string, string>> = Object.freeze({
  FOUNDATION_LOCKED_V1: 'Foundation v1 bloccata per contratto',
  HUMAN_APPROVAL_BARRIER: 'Barriera di approvazione umana obbligatoria',
  ENVIRONMENT_WORKER_GATE_CLOSED: 'Gate ambiente worker chiuso',
  DATABASE_STATE_MACHINE_GATE_CLOSED: 'Gate database state machine chiuso',
  DATABASE_DISPATCH_GATE_CLOSED: 'Gate database dispatch chiuso',
  PHYSICAL_DISPATCH_BARRIER: 'Barriera fisica PostgreSQL sul dispatch presente',
  NON_MOCK_PROVIDER: 'Provider effettivo non conforme al contratto mock',
  NON_SYNTHETIC_DATA_MODE: 'Modalità dati effettiva non conforme al contratto synthetic-only',
  EXTERNAL_PROVIDERS_NOT_DISABLED: 'Provider esterni non risultano integralmente disabilitati',
  MODEL_ALLOWLIST_NOT_EMPTY: 'Allowlist modelli esterni non vuota',
  CAPABILITY_GATE_OPEN: 'Una o più capability worker risultano abilitate',
  ADMIN_EMERGENCY_STOP: 'Emergency stop amministrativo inserito',
  ADMIN_GLOBAL_KILL_SWITCH: 'Kill switch globale amministrativo inserito',
});

export function labelAiOrchestratorAdminBlockReason(code: string) {
  return AI_ORCHESTRATOR_ADMIN_BLOCK_REASON_LABELS[code] ?? 'Blocco tecnico non classificato';
}

export const AI_ORCHESTRATOR_ADMIN_REASON_CODE_LABELS: Readonly<Record<AiOrchestratorAdminChangeReasonCode, string>> = Object.freeze({
  CONFIGURATION_CHANGE: 'Modifica configurazione',
  ENABLEMENT_CHANGE: 'Richiesta di abilitazione desiderata',
  DISABLEMENT_CHANGE: 'Disabilitazione desiderata',
  LIMIT_CHANGE: 'Modifica limiti',
  OPERATING_WINDOW_CHANGE: 'Modifica finestra operativa',
  KILL_SWITCH_CHANGE: 'Modifica kill switch',
  EMERGENCY_STOP: 'Arresto di emergenza',
  SECURITY_RESPONSE: 'Risposta di sicurezza',
  MAINTENANCE: 'Manutenzione',
});

const uuidV4Schema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const hashSchema = z.string().regex(/^[0-9a-f]{64}$/);
const scopeCodeSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const explicitBooleanSchema = z.enum(['true', 'false']).transform((value) => value === 'true');
const utcTimeSchema = z.union([z.literal(''), z.string().regex(/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/)]);

function integerStringSchema(minimum: number, maximum: number) {
  return z.string().regex(/^(?:0|[1-9][0-9]*)$/).transform(Number).refine(
    (value) => Number.isSafeInteger(value) && value >= minimum && value <= maximum,
    `Valore intero richiesto tra ${minimum} e ${maximum}.`,
  );
}

function utcTimeToMinute(value: string) {
  if (value === '') return null;
  const [hour, minute] = value.split(':').map(Number);
  return (hour * 60) + minute;
}

const commonPolicyFormFields = {
  requestId: uuidV4Schema,
  expectedVersion: integerStringSchema(1, Number.MAX_SAFE_INTEGER),
  expectedRevisionHash: hashSchema,
  reasonCode: AiOrchestratorAdminChangeReasonCodeSchema,
  reason: AiOrchestratorAdminReasonSchema,
  confirmationPhrase: z.literal(AI_ORCHESTRATOR_ADMIN_POLICY_CONFIRMATION_PHRASE),
  confirmationChecked: z.literal('confirmed'),
} as const;

export const AiOrchestratorAdminGlobalPolicyFormSchema = z.object({
  ...commonPolicyFormFields,
  desiredMode: z.enum(['STOPPED', 'PAUSED', 'DRAINING', 'READY']),
  desiredStateMachineEnabled: explicitBooleanSchema,
  emergencyStopEngaged: explicitBooleanSchema,
  globalKillSwitch: explicitBooleanSchema,
  maxConcurrentGlobal: integerStringSchema(0, 1),
  maxConcurrentPerWorkflow: integerStringSchema(0, 1),
  maxConcurrentPerAgent: integerStringSchema(0, 1),
  maxRetryableFailures: integerStringSchema(0, 3),
  leaseDurationMs: integerStringSchema(30_000, 120_000),
  heartbeatIntervalMs: integerStringSchema(10_000, 30_000),
  maxAttemptDurationMs: integerStringSchema(5_000, 600_000),
  dailyJobLimit: integerStringSchema(0, 1_000),
  operatingWindowEnabled: explicitBooleanSchema,
  operatingWindowStartUtc: utcTimeSchema,
  operatingWindowEndUtc: utcTimeSchema,
}).strict().superRefine((form, context) => {
  if (form.operatingWindowEnabled) {
    if (!form.operatingWindowStartUtc) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['operatingWindowStartUtc'], message: 'Orario iniziale UTC obbligatorio.' });
    }
    if (!form.operatingWindowEndUtc) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['operatingWindowEndUtc'], message: 'Orario finale UTC obbligatorio.' });
    }
    if (form.operatingWindowStartUtc === form.operatingWindowEndUtc) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['operatingWindowEndUtc'], message: 'Gli orari UTC devono essere distinti.' });
    }
  } else if (form.operatingWindowStartUtc !== '' || form.operatingWindowEndUtc !== '') {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['operatingWindowEnabled'], message: 'Una finestra disabilitata non accetta orari.' });
  }
});

export const AiOrchestratorAdminScopePolicyFormSchema = z.object({
  ...commonPolicyFormFields,
  scopeType: AiOrchestratorAdminNonGlobalScopeTypeSchema,
  scopeCode: scopeCodeSchema,
  desiredEnabled: explicitBooleanSchema,
  killSwitch: explicitBooleanSchema,
}).strict();

export const AiOrchestratorAdminEmergencyStopFormSchema = z.object({
  requestId: uuidV4Schema,
  reasonCode: z.enum(['EMERGENCY_STOP', 'SECURITY_RESPONSE']),
  reason: AiOrchestratorAdminReasonSchema,
  confirmationPhrase: z.literal(AI_ORCHESTRATOR_ADMIN_EMERGENCY_CONFIRMATION_PHRASE),
  confirmationChecked: z.literal('confirmed'),
}).strict();

export type AiOrchestratorAdminGlobalPolicyForm = z.infer<typeof AiOrchestratorAdminGlobalPolicyFormSchema>;
export type AiOrchestratorAdminScopePolicyForm = z.infer<typeof AiOrchestratorAdminScopePolicyFormSchema>;
export type AiOrchestratorAdminEmergencyStopForm = z.infer<typeof AiOrchestratorAdminEmergencyStopFormSchema>;

export function formDataToStrictRecord(formData: FormData) {
  const record: Record<string, FormDataEntryValue> = {};
  for (const [key, value] of formData.entries()) {
    // React Server Actions add transport metadata in this reserved namespace.
    // It is never interpreted as application input; every other unknown field
    // still reaches the strict Zod object and is rejected.
    if (key.startsWith('$ACTION_')) continue;
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      throw new TypeError('AI_ORCHESTRATOR_ADMIN_DUPLICATE_FORM_KEY');
    }
    record[key] = value;
  }
  return record;
}

export function parseAiOrchestratorAdminGlobalPolicyForm(formData: FormData) {
  return AiOrchestratorAdminGlobalPolicyFormSchema.parse(formDataToStrictRecord(formData));
}

export function parseAiOrchestratorAdminScopePolicyForm(formData: FormData) {
  return AiOrchestratorAdminScopePolicyFormSchema.parse(formDataToStrictRecord(formData));
}

export function parseAiOrchestratorAdminEmergencyStopForm(formData: FormData) {
  return AiOrchestratorAdminEmergencyStopFormSchema.parse(formDataToStrictRecord(formData));
}

export function buildAiOrchestratorAdminGlobalPolicyFromForm(
  form: AiOrchestratorAdminGlobalPolicyForm,
): AiOrchestratorAdminGlobalPolicy {
  return AiOrchestratorAdminGlobalPolicySchema.parse({
    schemaVersion: AI_ORCHESTRATOR_ADMIN_GENESIS_GLOBAL_POLICY.schemaVersion,
    policyCode: AI_ORCHESTRATOR_ADMIN_GENESIS_GLOBAL_POLICY.policyCode,
    policyVersion: AI_ORCHESTRATOR_ADMIN_GENESIS_GLOBAL_POLICY.policyVersion,
    activationEpoch: AI_ORCHESTRATOR_ADMIN_GENESIS_GLOBAL_POLICY.activationEpoch,
    foundationLocked: true,
    desiredMode: form.desiredMode,
    desiredStateMachineEnabled: form.desiredStateMachineEnabled,
    desiredDispatchEnabled: false,
    emergencyStopEngaged: form.emergencyStopEngaged,
    globalKillSwitch: form.globalKillSwitch,
    provider: 'mock',
    syntheticDataOnly: true,
    limits: {
      maxConcurrentGlobal: form.maxConcurrentGlobal,
      maxConcurrentPerWorkflow: form.maxConcurrentPerWorkflow,
      maxConcurrentPerAgent: form.maxConcurrentPerAgent,
      maxRetryableFailures: form.maxRetryableFailures,
      leaseDurationMs: form.leaseDurationMs,
      heartbeatIntervalMs: form.heartbeatIntervalMs,
      maxAttemptDurationMs: form.maxAttemptDurationMs,
      dailyJobLimit: form.dailyJobLimit,
    },
    operatingWindow: {
      enabled: form.operatingWindowEnabled,
      timezone: 'UTC',
      startMinuteUtc: utcTimeToMinute(form.operatingWindowStartUtc),
      endMinuteUtc: utcTimeToMinute(form.operatingWindowEndUtc),
    },
  });
}

export function buildAiOrchestratorAdminScopePolicyFromForm(
  form: AiOrchestratorAdminScopePolicyForm,
): AiOrchestratorAdminScopePolicy {
  const target = getAiOrchestratorAdminControlTarget(form.scopeType, form.scopeCode);
  if (!target || target.scopeType === 'GLOBAL') {
    throw new TypeError('AI_ORCHESTRATOR_ADMIN_SCOPE_TARGET_INVALID');
  }
  const genesis = createAiOrchestratorAdminGenesisPolicy(target);
  if (genesis.policyCode !== 'AI_ORCHESTRATOR_ADMIN_SCOPE_POLICY') {
    throw new TypeError('AI_ORCHESTRATOR_ADMIN_SCOPE_POLICY_INVALID');
  }
  return AiOrchestratorAdminScopePolicySchema.parse({
    ...genesis,
    desiredEnabled: form.desiredEnabled,
    killSwitch: form.killSwitch,
  });
}

export interface AiOrchestratorAdminReadRevisionView {
  readonly scopeType: string;
  readonly scopeCode: string;
  readonly targetDefinitionHash: string;
  readonly version: number;
  readonly policy: AiOrchestratorAdminGlobalPolicy | AiOrchestratorAdminScopePolicy;
  readonly policyHash: string;
  readonly revisionHash: string;
  readonly createdAt: Date;
}

export function projectAiOrchestratorAdminReadRevision(
  revision: AiOrchestratorAdminDesiredPolicySnapshot | AiOrchestratorAdminRevisionSnapshot,
): AiOrchestratorAdminReadRevisionView {
  return Object.freeze({
    scopeType: revision.scopeType,
    scopeCode: revision.scopeCode,
    targetDefinitionHash: revision.targetDefinitionHash,
    version: revision.version,
    policy: revision.policy,
    policyHash: revision.policyHash,
    revisionHash: revision.revisionHash,
    createdAt: revision.createdAt,
  });
}

export interface AiOrchestratorAdminAuditRevisionView extends AiOrchestratorAdminReadRevisionView {
  readonly operationCode: string;
  readonly actorUserId: string | null;
  readonly actorRole: string | null;
  readonly reasonCode: string;
  readonly reason: string;
  readonly confirmed: boolean;
}

export function projectAiOrchestratorAdminAuditRevision(
  revision: AiOrchestratorAdminRevisionSnapshot,
): AiOrchestratorAdminAuditRevisionView {
  return Object.freeze({
    ...projectAiOrchestratorAdminReadRevision(revision),
    operationCode: revision.operationCode,
    actorUserId: revision.actorUserId,
    actorRole: revision.actorRole,
    reasonCode: revision.reasonCode,
    reason: revision.reason,
    confirmed: revision.confirmed,
  });
}

export interface AiOrchestratorAdminUiPermissions {
  readonly canRead: boolean;
  readonly canAudit: boolean;
  readonly canConfigure: boolean;
  readonly canEmergencyStop: boolean;
  readonly canEnable: boolean;
  readonly canDisable: boolean;
  readonly canManageLimits: boolean;
  readonly canManageRetry: boolean;
  readonly canManageAgents: boolean;
}

export function getAiOrchestratorAdminUiPermissions(
  effectivePermissions: readonly Permission[],
): AiOrchestratorAdminUiPermissions {
  const permissions = new Set<Permission>(effectivePermissions);
  return Object.freeze({
    canRead: permissions.has('ai.orchestrator.read'),
    canAudit: permissions.has('ai.orchestrator.audit'),
    canConfigure: permissions.has('ai.orchestrator.configure'),
    canEmergencyStop: permissions.has('ai.orchestrator.kill'),
    canEnable: permissions.has('ai.orchestrator.enable'),
    canDisable: permissions.has('ai.orchestrator.disable'),
    canManageLimits: permissions.has('ai.orchestrator.limits'),
    canManageRetry: permissions.has('ai.orchestrator.retry'),
    canManageAgents: permissions.has('ai.orchestrator.agents'),
  });
}

export function resolveAiOrchestratorAdminScopeSelection(input: {
  scopeType?: unknown;
  scopeCode?: unknown;
}) {
  if (typeof input.scopeType !== 'string' || typeof input.scopeCode !== 'string') return null;
  const scopeType = AiOrchestratorAdminNonGlobalScopeTypeSchema.safeParse(input.scopeType);
  const scopeCode = scopeCodeSchema.safeParse(input.scopeCode);
  if (!scopeType.success || !scopeCode.success) return null;
  const target = getAiOrchestratorAdminControlTarget(scopeType.data, scopeCode.data);
  return target && target.scopeType !== 'GLOBAL' ? target : null;
}

export function minuteUtcToTime(value: number | null) {
  if (value === null) return '';
  const hour = Math.floor(value / 60).toString().padStart(2, '0');
  const minute = (value % 60).toString().padStart(2, '0');
  return `${hour}:${minute}`;
}

// Compile-time checks keep the UI select catalogs tied to the canonical domain.
void AI_ORCHESTRATOR_ADMIN_CHANGE_REASON_CODES;
void AI_ORCHESTRATOR_ADMIN_NON_GLOBAL_SCOPE_TYPES;
