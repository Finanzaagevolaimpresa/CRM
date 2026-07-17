export const FAI_AUDIT_WORKFLOW_ID = 'FAI-AUDIT-WORKFLOW' as const;
export const FAI_AUDIT_WORKFLOW_VERSION = '1.1' as const;
export const FAI_AUDIT_WORKFLOW_KEY = 'FAI-AUDIT-WORKFLOW@1.1' as const;

import { createHash } from 'node:crypto';

export const FAI_AUDIT_STATES = Object.freeze([
  'CREATED',
  'WAITING_FOR_PAYMENT',
  'WAITING_FOR_AUTHORITY',
  'NEEDS_DOCUMENTS',
  'DATA_VALIDATION',
  'READY_FOR_ANALYSIS',
  'AI_DRAFT',
  'INDEPENDENT_REVIEW',
  'NEEDS_CORRECTION',
  'NEEDS_CLARIFICATION',
  'HUMAN_APPROVAL',
  'APPROVED',
  'RELEASED',
  'SUPERSEDED',
  'CLOSED',
  'DELETION_PENDING',
] as const);

export type FaiAuditState = (typeof FAI_AUDIT_STATES)[number];

export const FAI_AUDIT_TRANSITION_CODES = Object.freeze([
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
  'WF-018',
  'WF-019',
  'WF-020',
  'WF-021',
  'WF-022',
  'WF-023',
] as const);

export type FaiAuditTransitionCode = (typeof FAI_AUDIT_TRANSITION_CODES)[number];

export const WORKFLOW_ACTOR_KINDS = Object.freeze(['HUMAN', 'AGENT', 'SYSTEM'] as const);
export type WorkflowActorKind = (typeof WORKFLOW_ACTOR_KINDS)[number];

export const WORKFLOW_EXECUTION_MODES = Object.freeze(['INTERACTIVE', 'WORKER', 'SYSTEM'] as const);
export type WorkflowExecutionMode = (typeof WORKFLOW_EXECUTION_MODES)[number];

export type WorkflowTransitionEffect = 'STATE_CHANGE' | 'STEP_COMPLETION';
export type WorkflowWorkerDirective = 'CONTINUE' | 'STOP_AT_HUMAN_APPROVAL' | 'STOP_NO_AUTOMATION';
export type FaiAuditRequiredPermission = 'ai.run' | 'ai.review' | 'ai.approve';
export const FAI_AUDIT_MAX_CORRECTION_CYCLES = 2 as const;

export const FAI_AUDIT_WORKFLOW_POLICY = Object.freeze({
  agentProvider: 'mock' as const,
  automaticDispatchAuthorized: false as const,
  externalProvidersMustBeDisabled: true as const,
  maxCorrectionCycles: FAI_AUDIT_MAX_CORRECTION_CYCLES,
  actorExecutionModes: Object.freeze({
    HUMAN: Object.freeze(['INTERACTIVE'] as const),
    AGENT: Object.freeze(['WORKER'] as const),
    SYSTEM: Object.freeze(['WORKER', 'SYSTEM'] as const),
  }),
});

export interface FaiAuditTransitionDefinition {
  readonly transitionCode: FaiAuditTransitionCode;
  readonly sequence: number;
  readonly event: string;
  readonly from: FaiAuditState;
  readonly to: FaiAuditState;
  readonly gate: string;
  readonly actorKind: WorkflowActorKind;
  readonly preconditions: readonly string[];
  readonly effect: WorkflowTransitionEffect;
  readonly requiredPermission: FaiAuditRequiredPermission | null;
  readonly incrementsCorrectionCycle: boolean;
  readonly reasonCodeRequired: boolean;
  readonly mockProviderRequired: boolean;
  readonly manualReleaseOnly: boolean;
}

function defineTransition(
  definition: Omit<
    FaiAuditTransitionDefinition,
    | 'effect'
    | 'requiredPermission'
    | 'incrementsCorrectionCycle'
    | 'reasonCodeRequired'
    | 'mockProviderRequired'
    | 'manualReleaseOnly'
  >,
): FaiAuditTransitionDefinition {
  let requiredPermission: FaiAuditRequiredPermission | null = null;
  if (definition.actorKind === 'HUMAN') {
    if (['WF-001', 'WF-002', 'WF-003', 'WF-004', 'WF-009', 'WF-010'].includes(definition.transitionCode)) {
      requiredPermission = 'ai.run';
    } else if (definition.transitionCode === 'WF-017') {
      requiredPermission = 'ai.review';
    } else {
      requiredPermission = 'ai.approve';
    }
  }
  return Object.freeze({
    ...definition,
    preconditions: Object.freeze([...definition.preconditions]),
    effect: definition.from === definition.to ? 'STEP_COMPLETION' : 'STATE_CHANGE',
    requiredPermission,
    incrementsCorrectionCycle: ['WF-015', 'WF-019'].includes(definition.transitionCode),
    reasonCodeRequired: ['WF-015', 'WF-019', 'WF-021', 'WF-023'].includes(definition.transitionCode),
    mockProviderRequired: definition.actorKind === 'AGENT',
    manualReleaseOnly: definition.to === 'RELEASED',
  });
}

export const FAI_AUDIT_TRANSITIONS: readonly FaiAuditTransitionDefinition[] = Object.freeze([
  defineTransition({
    transitionCode: 'WF-001',
    sequence: 1,
    event: 'CASE_STARTED',
    from: 'CREATED',
    to: 'WAITING_FOR_PAYMENT',
    gate: 'G0_ORDER',
    actorKind: 'HUMAN',
    preconditions: ['ORDER_ACTIVE', 'CONTRACT_COHERENT'],
  }),
  defineTransition({
    transitionCode: 'WF-002',
    sequence: 2,
    event: 'PAYMENT_VERIFIED',
    from: 'WAITING_FOR_PAYMENT',
    to: 'WAITING_FOR_AUTHORITY',
    gate: 'G0_PAYMENT',
    actorKind: 'HUMAN',
    preconditions: ['PAYMENT_CONFIRMED'],
  }),
  defineTransition({
    transitionCode: 'WF-003',
    sequence: 3,
    event: 'AUTHORITY_VERIFIED',
    from: 'WAITING_FOR_AUTHORITY',
    to: 'NEEDS_DOCUMENTS',
    gate: 'G1_AUTHORITY',
    actorKind: 'HUMAN',
    preconditions: ['AUTHORITY_VALID', 'AI_USE_AUTHORIZED', 'DATA_SCOPE_VALID'],
  }),
  defineTransition({
    transitionCode: 'WF-004',
    sequence: 4,
    event: 'CHECKLIST_RESOLVED',
    from: 'NEEDS_DOCUMENTS',
    to: 'DATA_VALIDATION',
    gate: 'G2_COMPLETENESS',
    actorKind: 'HUMAN',
    preconditions: ['CORE_DOCUMENTS_COMPLETE', 'CONDITIONAL_DOCUMENTS_RESOLVED'],
  }),
  defineTransition({
    transitionCode: 'WF-005',
    sequence: 5,
    event: 'DOCUMENT_INGESTED',
    from: 'DATA_VALIDATION',
    to: 'DATA_VALIDATION',
    gate: 'G3_INGEST',
    actorKind: 'AGENT',
    preconditions: ['FILES_SAFE', 'FILES_READABLE', 'CHECKSUMS_RECORDED'],
  }),
  defineTransition({
    transitionCode: 'WF-006',
    sequence: 6,
    event: 'DOCUMENT_CLASSIFIED',
    from: 'DATA_VALIDATION',
    to: 'DATA_VALIDATION',
    gate: 'G4_CLASSIFY',
    actorKind: 'AGENT',
    preconditions: [
      'DOCUMENT_TYPES_CONFIRMED',
      'SUBJECTS_CONFIRMED',
      'PERIODS_CONFIRMED',
      'DATA_ZONES_CONFIRMED',
    ],
  }),
  defineTransition({
    transitionCode: 'WF-007',
    sequence: 7,
    event: 'EVIDENCE_EXTRACTED',
    from: 'DATA_VALIDATION',
    to: 'DATA_VALIDATION',
    gate: 'G4_EXTRACT',
    actorKind: 'AGENT',
    preconditions: ['SOURCE_ANCHORS_PRESENT', 'EXTRACTION_TYPED'],
  }),
  defineTransition({
    transitionCode: 'WF-008',
    sequence: 8,
    event: 'BLOCKING_CONFLICT_DETECTED',
    from: 'DATA_VALIDATION',
    to: 'NEEDS_CLARIFICATION',
    gate: 'G5_DATA_CONFLICT',
    actorKind: 'SYSTEM',
    preconditions: ['MATERIAL_CONFLICT_PRESENT'],
  }),
  defineTransition({
    transitionCode: 'WF-009',
    sequence: 9,
    event: 'CLARIFICATION_RESOLVED',
    from: 'NEEDS_CLARIFICATION',
    to: 'DATA_VALIDATION',
    gate: 'G5_CLARIFICATION',
    actorKind: 'HUMAN',
    preconditions: ['CLARIFICATION_RESOLVED'],
  }),
  defineTransition({
    transitionCode: 'WF-010',
    sequence: 10,
    event: 'DATASET_READY',
    from: 'DATA_VALIDATION',
    to: 'READY_FOR_ANALYSIS',
    gate: 'G5_DATA_QUALITY',
    actorKind: 'HUMAN',
    preconditions: ['IDENTITY_RECONCILED', 'PERIODS_RECONCILED', 'UNITS_RECONCILED', 'CORE_DATA_COMPLETE'],
  }),
  defineTransition({
    transitionCode: 'WF-011',
    sequence: 11,
    event: 'ANALYSIS_BUNDLE_COMPLETED',
    from: 'READY_FOR_ANALYSIS',
    to: 'AI_DRAFT',
    gate: 'G6_ANALYSIS_JOIN',
    actorKind: 'SYSTEM',
    preconditions: ['FINANCIAL_ANALYSIS_COMPLETE', 'CREDIT_ANALYSIS_COMPLETE', 'CALCULATIONS_COMPLETE'],
  }),
  defineTransition({
    transitionCode: 'WF-012',
    sequence: 12,
    event: 'FINDINGS_DRAFTED',
    from: 'AI_DRAFT',
    to: 'AI_DRAFT',
    gate: 'G6_FINDINGS',
    actorKind: 'AGENT',
    preconditions: ['CLAIMS_HAVE_EVIDENCE', 'NO_SINGLE_SCORE'],
  }),
  defineTransition({
    transitionCode: 'WF-013',
    sequence: 13,
    event: 'REPORT_DRAFTED',
    from: 'AI_DRAFT',
    to: 'INDEPENDENT_REVIEW',
    gate: 'G6_COMPOSE',
    actorKind: 'AGENT',
    preconditions: ['REPORT_SECTIONS_COMPLETE', 'LIMITATIONS_EXPLICIT', 'DISCLAIMER_PRESENT'],
  }),
  defineTransition({
    transitionCode: 'WF-014',
    sequence: 14,
    event: 'REVIEW_BUNDLE_COMPLETED',
    from: 'INDEPENDENT_REVIEW',
    to: 'INDEPENDENT_REVIEW',
    gate: 'G7_REVIEW_JOIN',
    actorKind: 'SYSTEM',
    preconditions: ['SCHEMA_REVIEW_COMPLETE', 'NUMERIC_REVIEW_COMPLETE', 'SOURCE_REVIEW_COMPLETE', 'RED_TEAM_REVIEW_COMPLETE'],
  }),
  defineTransition({
    transitionCode: 'WF-015',
    sequence: 15,
    event: 'CORRECTION_OPENED',
    from: 'INDEPENDENT_REVIEW',
    to: 'NEEDS_CORRECTION',
    gate: 'G7_CORRECTION_REQUIRED',
    actorKind: 'SYSTEM',
    preconditions: ['OPEN_CRITICAL_OR_MAJOR_FINDINGS'],
  }),
  defineTransition({
    transitionCode: 'WF-016',
    sequence: 16,
    event: 'CORRECTION_COMPLETED',
    from: 'NEEDS_CORRECTION',
    to: 'INDEPENDENT_REVIEW',
    gate: 'G7_CORRECT',
    actorKind: 'AGENT',
    preconditions: ['NEW_ARTIFACT_VERSION_CREATED', 'FINDINGS_LINKED', 'SOURCES_IMMUTABLE'],
  }),
  defineTransition({
    transitionCode: 'WF-017',
    sequence: 17,
    event: 'REVIEW_GATE_PASSED',
    from: 'INDEPENDENT_REVIEW',
    to: 'HUMAN_APPROVAL',
    gate: 'G7_PASS',
    actorKind: 'HUMAN',
    preconditions: ['ZERO_OPEN_CRITICAL_MAJOR', 'ALL_REVIEWS_PASS', 'TARGET_VERSION_HASHED'],
  }),
  defineTransition({
    transitionCode: 'WF-018',
    sequence: 18,
    event: 'REPORT_APPROVED',
    from: 'HUMAN_APPROVAL',
    to: 'APPROVED',
    gate: 'G8_APPROVAL',
    actorKind: 'HUMAN',
    preconditions: [
      'APPROVER_AUTHORIZED',
      'APPROVER_SEPARATION_VALID',
      'TARGET_VERSION_UNCHANGED',
      'APPROVAL_RECORDED',
    ],
  }),
  defineTransition({
    transitionCode: 'WF-019',
    sequence: 19,
    event: 'APPROVAL_CHANGES_REQUESTED',
    from: 'HUMAN_APPROVAL',
    to: 'NEEDS_CORRECTION',
    gate: 'G8_CHANGES_REQUESTED',
    actorKind: 'HUMAN',
    preconditions: ['APPROVER_AUTHORIZED', 'CHANGE_REQUEST_RECORDED'],
  }),
  defineTransition({
    transitionCode: 'WF-020',
    sequence: 20,
    event: 'DELIVERABLE_RELEASED',
    from: 'APPROVED',
    to: 'RELEASED',
    gate: 'G8_RELEASE',
    actorKind: 'HUMAN',
    preconditions: [
      'DUAL_CONTROL_CONFIRMED',
      'RECIPIENT_VERIFIED',
      'ARTIFACT_CHECKSUM_MATCHES',
      'DELIVERY_LOG_READY',
    ],
  }),
  defineTransition({
    transitionCode: 'WF-021',
    sequence: 21,
    event: 'VERSION_SUPERSEDED',
    from: 'APPROVED',
    to: 'SUPERSEDED',
    gate: 'G8_SUPERSEDE',
    actorKind: 'HUMAN',
    preconditions: ['SUPERSEDING_VERSION_APPROVED', 'SUPERSEDE_REASON_RECORDED'],
  }),
  defineTransition({
    transitionCode: 'WF-022',
    sequence: 22,
    event: 'CASE_CLOSED',
    from: 'RELEASED',
    to: 'CLOSED',
    gate: 'G8_CLOSE',
    actorKind: 'HUMAN',
    preconditions: ['DELIVERY_RECORDED', 'RETENTION_CLASS_ASSIGNED', 'NO_OPEN_REQUESTS'],
  }),
  defineTransition({
    transitionCode: 'WF-023',
    sequence: 23,
    event: 'DELETION_REQUESTED',
    from: 'CLOSED',
    to: 'DELETION_PENDING',
    gate: 'G9_RETENTION',
    actorKind: 'HUMAN',
    preconditions: ['RETENTION_EXPIRED', 'LEGAL_HOLD_CLEAR', 'DELETION_AUTHORIZED'],
  }),
]);

export const FAI_AUDIT_TERMINAL_STATES: readonly FaiAuditState[] = Object.freeze([
  'SUPERSEDED',
  'DELETION_PENDING',
]);

export const FAI_AUDIT_AUTOMATION_STOP_STATE = 'HUMAN_APPROVAL' as const;

type CanonicalJson = null | boolean | number | string | readonly CanonicalJson[] | { readonly [key: string]: CanonicalJson };

function canonicalJson(value: CanonicalJson): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError('Valore non rappresentabile nel manifest workflow canonico');
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const objectValue = value as Readonly<Record<string, CanonicalJson>>;
  return `{${Object.keys(objectValue)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(objectValue[key] as CanonicalJson)}`)
    .join(',')}}`;
}

function auditWorkflowDefinitionHashInput(): CanonicalJson {
  return {
    automationStopState: FAI_AUDIT_AUTOMATION_STOP_STATE,
    initialState: 'CREATED',
    states: [...FAI_AUDIT_STATES],
    terminalStates: [...FAI_AUDIT_TERMINAL_STATES],
    transitions: FAI_AUDIT_TRANSITIONS.map((transition) => ({
      actorKind: transition.actorKind,
      effect: transition.effect,
      event: transition.event,
      from: transition.from,
      gate: transition.gate,
      manualReleaseOnly: transition.manualReleaseOnly,
      mockProviderRequired: transition.mockProviderRequired,
      incrementsCorrectionCycle: transition.incrementsCorrectionCycle,
      preconditions: [...transition.preconditions],
      reasonCodeRequired: transition.reasonCodeRequired,
      requiredPermission: transition.requiredPermission,
      sequence: transition.sequence,
      to: transition.to,
      transitionCode: transition.transitionCode,
    })),
    version: FAI_AUDIT_WORKFLOW_VERSION,
    workflowId: FAI_AUDIT_WORKFLOW_ID,
    policy: {
      actorExecutionModes: FAI_AUDIT_WORKFLOW_POLICY.actorExecutionModes,
      agentProvider: FAI_AUDIT_WORKFLOW_POLICY.agentProvider,
      automaticDispatchAuthorized: FAI_AUDIT_WORKFLOW_POLICY.automaticDispatchAuthorized,
      externalProvidersMustBeDisabled: FAI_AUDIT_WORKFLOW_POLICY.externalProvidersMustBeDisabled,
      maxCorrectionCycles: FAI_AUDIT_WORKFLOW_POLICY.maxCorrectionCycles,
    },
  };
}

export function createAuditWorkflowDefinitionHash(): string {
  return createHash('sha256').update(canonicalJson(auditWorkflowDefinitionHashInput()), 'utf8').digest('hex');
}

export const FAI_AUDIT_WORKFLOW_DEFINITION_HASH = createAuditWorkflowDefinitionHash();

export const FAI_AUDIT_WORKFLOW_DEFINITION = Object.freeze({
  workflowId: FAI_AUDIT_WORKFLOW_ID,
  version: FAI_AUDIT_WORKFLOW_VERSION,
  key: FAI_AUDIT_WORKFLOW_KEY,
  definitionHash: FAI_AUDIT_WORKFLOW_DEFINITION_HASH,
  initialState: 'CREATED' as const,
  states: FAI_AUDIT_STATES,
  terminalStates: FAI_AUDIT_TERMINAL_STATES,
  automationStopState: FAI_AUDIT_AUTOMATION_STOP_STATE,
  policy: FAI_AUDIT_WORKFLOW_POLICY,
  transitions: FAI_AUDIT_TRANSITIONS,
});

export interface AuditWorkflowTransitionRequest {
  readonly workflowId?: string;
  readonly workflowVersion?: string;
  readonly definitionHash?: string;
  readonly transitionCode: string;
  readonly currentState: string;
  readonly actor?: {
    readonly actorId?: string | null;
    readonly kind: string;
    readonly executionMode: string;
  } | null;
  readonly gateResults?: Readonly<Record<string, string | undefined>>;
  readonly preconditions?: Readonly<Record<string, boolean | undefined>>;
  readonly grantedPermissions?: readonly string[];
  readonly provider?: string | null;
  readonly externalProvidersEnabled?: boolean;
  readonly correctionCycle?: number;
  readonly manualReleaseConfirmed?: boolean;
  readonly reasonCode?: string | null;
}

export type AuditWorkflowDenialCode =
  | 'WORKFLOW_ID_MISMATCH'
  | 'WORKFLOW_VERSION_MISMATCH'
  | 'DEFINITION_HASH_MISMATCH'
  | 'UNKNOWN_STATE'
  | 'UNKNOWN_TRANSITION'
  | 'STATE_MISMATCH'
  | 'ACTOR_REQUIRED'
  | 'UNKNOWN_ACTOR_KIND'
  | 'ACTOR_NOT_ALLOWED'
  | 'ACTOR_CONTEXT_INVALID'
  | 'WORKER_STOP_REQUIRED'
  | 'PERMISSION_NOT_GRANTED'
  | 'GATE_NOT_PASSED'
  | 'PRECONDITION_NOT_MET'
  | 'EXTERNAL_PROVIDER_STATUS_UNKNOWN'
  | 'EXTERNAL_PROVIDERS_ENABLED'
  | 'MOCK_PROVIDER_REQUIRED'
  | 'CORRECTION_CYCLE_INVALID'
  | 'CORRECTION_LIMIT_REACHED'
  | 'REASON_CODE_REQUIRED'
  | 'MANUAL_RELEASE_REQUIRED';

export interface AuditWorkflowTransitionDenied {
  readonly allowed: false;
  readonly code: AuditWorkflowDenialCode;
  readonly reason: string;
  readonly transition?: FaiAuditTransitionDefinition;
  readonly missingPrecondition?: string;
}

export interface AuditWorkflowTransitionAllowed {
  readonly allowed: true;
  readonly transition: FaiAuditTransitionDefinition;
  readonly nextState: FaiAuditState;
  readonly effect: WorkflowTransitionEffect;
  readonly stateChanged: boolean;
  readonly workerDirective: WorkflowWorkerDirective;
  readonly automaticDispatchAllowed: boolean;
}

export type AuditWorkflowTransitionEvaluation =
  | AuditWorkflowTransitionDenied
  | AuditWorkflowTransitionAllowed;

const stateSet = new Set<string>(FAI_AUDIT_STATES);
const actorKindSet = new Set<string>(WORKFLOW_ACTOR_KINDS);
const executionModeSet = new Set<string>(WORKFLOW_EXECUTION_MODES);
const transitionByCode = new Map<string, FaiAuditTransitionDefinition>(
  FAI_AUDIT_TRANSITIONS.map((transition) => [transition.transitionCode, transition]),
);

export function getAuditWorkflowTransition(
  transitionCode: string,
): FaiAuditTransitionDefinition | undefined {
  return transitionByCode.get(transitionCode);
}

function denied(
  code: AuditWorkflowDenialCode,
  reason: string,
  transition?: FaiAuditTransitionDefinition,
  missingPrecondition?: string,
): AuditWorkflowTransitionDenied {
  return { allowed: false, code, reason, transition, missingPrecondition };
}

function actorContextIsValid(kind: WorkflowActorKind, executionMode: WorkflowExecutionMode) {
  return (FAI_AUDIT_WORKFLOW_POLICY.actorExecutionModes[kind] as readonly string[]).includes(executionMode);
}

function workerDirectiveFor(to: FaiAuditState): WorkflowWorkerDirective {
  if (to === FAI_AUDIT_AUTOMATION_STOP_STATE) return 'STOP_AT_HUMAN_APPROVAL';
  if (to === 'APPROVED' || to === 'RELEASED' || to === 'CLOSED' || FAI_AUDIT_TERMINAL_STATES.includes(to)) {
    return 'STOP_NO_AUTOMATION';
  }
  return 'CONTINUE';
}

export function evaluateAuditWorkflowTransition(
  request: AuditWorkflowTransitionRequest,
): AuditWorkflowTransitionEvaluation {
  if (request.workflowId !== FAI_AUDIT_WORKFLOW_ID) {
    return denied(
      'WORKFLOW_ID_MISMATCH',
      `Workflow atteso ${FAI_AUDIT_WORKFLOW_ID}, ricevuto ${request.workflowId ?? '<missing>'}`,
    );
  }
  if (request.workflowVersion !== FAI_AUDIT_WORKFLOW_VERSION) {
    return denied(
      'WORKFLOW_VERSION_MISMATCH',
      `Versione workflow attesa ${FAI_AUDIT_WORKFLOW_VERSION}, ricevuta ${request.workflowVersion ?? '<missing>'}`,
    );
  }
  if (request.definitionHash !== FAI_AUDIT_WORKFLOW_DEFINITION_HASH) {
    return denied(
      'DEFINITION_HASH_MISMATCH',
      'La definizione richiesta non coincide con il manifest workflow canonico',
    );
  }

  if (!stateSet.has(request.currentState)) {
    return denied('UNKNOWN_STATE', `Stato workflow non riconosciuto: ${request.currentState}`);
  }

  const transition = transitionByCode.get(request.transitionCode);
  if (!transition) {
    return denied('UNKNOWN_TRANSITION', `Transizione workflow non riconosciuta: ${request.transitionCode}`);
  }

  if (transition.from !== request.currentState) {
    return denied(
      'STATE_MISMATCH',
      `${transition.transitionCode} richiede lo stato ${transition.from}, non ${request.currentState}`,
      transition,
    );
  }

  const actor = request.actor;
  if (!actor?.actorId?.trim()) {
    return denied('ACTOR_REQUIRED', 'Ogni transizione richiede un attore identificato', transition);
  }
  if (!actorKindSet.has(actor.kind)) {
    return denied('UNKNOWN_ACTOR_KIND', `Tipo attore non riconosciuto: ${actor.kind}`, transition);
  }
  if (!executionModeSet.has(actor.executionMode)) {
    return denied('ACTOR_CONTEXT_INVALID', `Modalità di esecuzione non riconosciuta: ${actor.executionMode}`, transition);
  }

  const actorKind = actor.kind as WorkflowActorKind;
  const executionMode = actor.executionMode as WorkflowExecutionMode;

  if (
    executionMode === 'WORKER'
    && (request.currentState === FAI_AUDIT_AUTOMATION_STOP_STATE || transition.to === 'APPROVED' || transition.to === 'RELEASED')
  ) {
    return denied(
      'WORKER_STOP_REQUIRED',
      'Il worker deve fermarsi al gate umano e non può approvare o rilasciare',
      transition,
    );
  }

  if (actorKind !== transition.actorKind) {
    return denied(
      'ACTOR_NOT_ALLOWED',
      `${transition.transitionCode} richiede un attore ${transition.actorKind}`,
      transition,
    );
  }
  if (!actorContextIsValid(actorKind, executionMode)) {
    return denied(
      'ACTOR_CONTEXT_INVALID',
      `L'attore ${actorKind} non può operare in modalità ${executionMode}`,
      transition,
    );
  }

  if (
    transition.requiredPermission !== null
    && !request.grantedPermissions?.includes(transition.requiredPermission)
  ) {
    return denied(
      'PERMISSION_NOT_GRANTED',
      `La transizione richiede il permesso ${transition.requiredPermission}`,
      transition,
    );
  }

  if (request.gateResults?.[transition.gate] !== 'PASS') {
    return denied(
      'GATE_NOT_PASSED',
      `Il gate ${transition.gate} deve risultare esplicitamente PASS`,
      transition,
    );
  }

  for (const precondition of transition.preconditions) {
    if (request.preconditions?.[precondition] !== true) {
      return denied(
        'PRECONDITION_NOT_MET',
        `Precondizione non soddisfatta: ${precondition}`,
        transition,
        precondition,
      );
    }
  }

  if (FAI_AUDIT_WORKFLOW_POLICY.externalProvidersMustBeDisabled) {
    if (request.externalProvidersEnabled === undefined) {
      return denied(
        'EXTERNAL_PROVIDER_STATUS_UNKNOWN',
        'Lo stato dei provider esterni deve essere esplicitamente disabilitato',
        transition,
      );
    }
    if (FAI_AUDIT_WORKFLOW_POLICY.externalProvidersMustBeDisabled && request.externalProvidersEnabled) {
      return denied(
        'EXTERNAL_PROVIDERS_ENABLED',
        'I provider esterni devono restare disabilitati per il workflow MVP',
        transition,
      );
    }
  }

  if (transition.mockProviderRequired) {
    if (request.provider !== FAI_AUDIT_WORKFLOW_POLICY.agentProvider) {
      return denied('MOCK_PROVIDER_REQUIRED', 'Il workflow MVP consente esclusivamente il provider mock', transition);
    }
  }

  if (transition.incrementsCorrectionCycle) {
    if (!Number.isInteger(request.correctionCycle) || (request.correctionCycle ?? -1) < 0) {
      return denied(
        'CORRECTION_CYCLE_INVALID',
        'Il ciclo corrente deve essere un intero non negativo',
        transition,
      );
    }
    if ((request.correctionCycle ?? 0) >= FAI_AUDIT_MAX_CORRECTION_CYCLES) {
      return denied(
        'CORRECTION_LIMIT_REACHED',
        'Dopo due cicli non si apre una nuova correzione: è richiesta escalation umana',
        transition,
      );
    }
  }

  if (transition.reasonCodeRequired && !/^[A-Z][A-Z0-9_]{2,63}$/.test(request.reasonCode ?? '')) {
    return denied(
      'REASON_CODE_REQUIRED',
      `${transition.transitionCode} richiede un reason code stabile e non libero`,
      transition,
    );
  }

  if (transition.transitionCode === 'WF-016') {
    if (
      !Number.isInteger(request.correctionCycle)
      || (request.correctionCycle ?? 0) < 1
      || (request.correctionCycle ?? 0) > FAI_AUDIT_MAX_CORRECTION_CYCLES
    ) {
      return denied(
        'CORRECTION_CYCLE_INVALID',
        'La correzione deve appartenere al primo o al secondo ciclo',
        transition,
      );
    }
  }

  if (transition.manualReleaseOnly && request.manualReleaseConfirmed !== true) {
    return denied(
      'MANUAL_RELEASE_REQUIRED',
      'Il rilascio richiede una conferma manuale esplicita e nominativa',
      transition,
    );
  }

  const workerDirective = workerDirectiveFor(transition.to);
  return {
    allowed: true,
    transition,
    nextState: transition.to,
    effect: transition.effect,
    stateChanged: transition.effect === 'STATE_CHANGE',
    workerDirective,
    // PR1 defines possible next work but never authorizes dispatch. The future
    // dispatcher must re-evaluate its own feature gate, policy and capability.
    automaticDispatchAllowed: FAI_AUDIT_WORKFLOW_POLICY.automaticDispatchAuthorized,
  };
}

export interface AuditWorkflowDefinitionInvariantReport {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly stateCount: number;
  readonly transitionCount: number;
  readonly reachableStates: readonly FaiAuditState[];
  readonly unreachableStates: readonly FaiAuditState[];
}

export function getAuditWorkflowDefinitionInvariantReport(): AuditWorkflowDefinitionInvariantReport {
  const errors: string[] = [];
  const states = [...FAI_AUDIT_STATES];
  const transitions = [...FAI_AUDIT_TRANSITIONS];

  if (states.length !== 16) errors.push(`Sono richiesti 16 stati, trovati ${states.length}`);
  if (new Set(states).size !== states.length) errors.push('Gli stati devono essere univoci');
  if (transitions.length !== 23) errors.push(`Sono richieste 23 transizioni, trovate ${transitions.length}`);
  if (!/^[a-f0-9]{64}$/.test(FAI_AUDIT_WORKFLOW_DEFINITION_HASH)) {
    errors.push('La definizione deve avere un hash SHA-256 lowercase valido');
  }
  if (FAI_AUDIT_WORKFLOW_DEFINITION_HASH !== createAuditWorkflowDefinitionHash()) {
    errors.push('L hash della definizione non coincide con il manifest canonico');
  }

  const codes = transitions.map((transition) => transition.transitionCode);
  const events = transitions.map((transition) => transition.event);
  if (new Set(codes).size !== transitions.length) errors.push('I codici transizione devono essere univoci');
  if (new Set(events).size !== transitions.length) errors.push('Gli eventi transizione devono essere univoci');

  transitions.forEach((transition, index) => {
    const expectedSequence = index + 1;
    const expectedCode = `WF-${String(expectedSequence).padStart(3, '0')}`;
    if (transition.sequence !== expectedSequence) {
      errors.push(`${transition.transitionCode}: sequenza attesa ${expectedSequence}`);
    }
    if (transition.transitionCode !== expectedCode) {
      errors.push(`Codice atteso ${expectedCode}, trovato ${transition.transitionCode}`);
    }
    if (!stateSet.has(transition.from) || !stateSet.has(transition.to)) {
      errors.push(`${transition.transitionCode}: stato sorgente o destinazione non definito`);
    }
    if (!transition.gate || transition.preconditions.length === 0) {
      errors.push(`${transition.transitionCode}: gate e precondizioni sono obbligatori`);
    }
    if (transition.effect !== (transition.from === transition.to ? 'STEP_COMPLETION' : 'STATE_CHANGE')) {
      errors.push(`${transition.transitionCode}: effetto incoerente con la coppia from/to`);
    }
    if (transition.mockProviderRequired !== (transition.actorKind === 'AGENT')) {
      errors.push(`${transition.transitionCode}: policy provider incoerente con il tipo attore`);
    }
    if ((transition.actorKind === 'HUMAN') !== (transition.requiredPermission !== null)) {
      errors.push(`${transition.transitionCode}: mapping permesso incoerente con il tipo attore`);
    }
    if (transition.incrementsCorrectionCycle !== ['WF-015', 'WF-019'].includes(transition.transitionCode)) {
      errors.push(`${transition.transitionCode}: policy del ciclo di correzione incoerente`);
    }
    if (transition.reasonCodeRequired !== ['WF-015', 'WF-019', 'WF-021', 'WF-023'].includes(transition.transitionCode)) {
      errors.push(`${transition.transitionCode}: policy reason code incoerente`);
    }
  });

  const outgoingFromTerminal = transitions.filter((transition) => FAI_AUDIT_TERMINAL_STATES.includes(transition.from));
  if (outgoingFromTerminal.length > 0) errors.push('Gli stati terminali non possono avere transizioni in uscita');

  const releaseTransitions = transitions.filter((transition) => transition.to === 'RELEASED');
  if (
    releaseTransitions.length !== 1
    || releaseTransitions[0]?.transitionCode !== 'WF-020'
    || releaseTransitions[0]?.actorKind !== 'HUMAN'
    || !releaseTransitions[0]?.manualReleaseOnly
  ) {
    errors.push('RELEASED deve essere raggiungibile solo da WF-020, con attore umano e rilascio manuale');
  }

  for (const protectedState of ['APPROVED', 'RELEASED'] as const) {
    if (transitions.some((transition) => transition.to === protectedState && transition.actorKind !== 'HUMAN')) {
      errors.push(`${protectedState} non può essere raggiunto da AGENT o SYSTEM`);
    }
  }

  const reachable = new Set<FaiAuditState>([FAI_AUDIT_WORKFLOW_DEFINITION.initialState]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const transition of transitions) {
      if (reachable.has(transition.from) && !reachable.has(transition.to)) {
        reachable.add(transition.to);
        changed = true;
      }
    }
  }
  const reachableStates = states.filter((state) => reachable.has(state));
  const unreachableStates = states.filter((state) => !reachable.has(state));
  if (unreachableStates.length > 0) {
    errors.push(`Stati irraggiungibili da CREATED: ${unreachableStates.join(', ')}`);
  }

  return Object.freeze({
    valid: errors.length === 0,
    errors: Object.freeze(errors),
    stateCount: states.length,
    transitionCount: transitions.length,
    reachableStates: Object.freeze(reachableStates),
    unreachableStates: Object.freeze(unreachableStates),
  });
}

export function assertAuditWorkflowDefinitionInvariants(): void {
  const report = getAuditWorkflowDefinitionInvariantReport();
  if (!report.valid) {
    throw new Error(`Definizione ${FAI_AUDIT_WORKFLOW_KEY} non valida: ${report.errors.join('; ')}`);
  }
}
