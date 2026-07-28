import { canonicalSha256 } from '../canonical-json';
import { z } from 'zod';
import { FAI_AUDIT_STATES, FAI_AUDIT_TRANSITION_CODES, type FaiAuditState, type FaiAuditTransitionCode } from './audit-workflow-v1-1';
import {
  FAI_AUDIT_EXECUTOR_BINDING_VERSION,
  FAI_AUDIT_JOB_CATALOG_CODE,
  FAI_AUDIT_JOB_CATALOG_HASH,
  FAI_AUDIT_JOB_CATALOG_KEY,
  FAI_AUDIT_JOB_CATALOG_VERSION,
  FAI_AUDIT_JOB_CODES,
  FAI_AUDIT_JOB_DEFINITION_HASHES,
  getFaiAuditJobDefinition,
  getFaiAuditJobPlanningRule,
  type FaiAuditJobBundleCode,
  type FaiAuditJobCode,
} from './job-catalog-v1';

export interface ResolvedFaiAuditJobExecutor {
  readonly jobCode: FaiAuditJobCode;
  readonly executorAgentId: string;
  readonly executorAgentCode: string;
  readonly executorAgentConfigVersion: number;
  readonly executorAgentConfigHash: string;
}

export interface FaiAuditJobPlanInput {
  readonly workflowInstanceId: string;
  readonly workflowCode: string;
  readonly workflowVersion: string;
  readonly workflowDefinitionHash: string;
  readonly phaseCode: FaiAuditState;
  readonly phaseEntrySequence: number;
  readonly sourceCommandIdempotencyKey: string;
  readonly sourceTransitionCode: FaiAuditTransitionCode;
  readonly sourceTransitionSequence: number;
  readonly sourceState: FaiAuditState;
  readonly sourceStateVersion: number;
  readonly targetState: FaiAuditState;
  readonly correlationId: string;
  readonly correctionCycle: number;
  readonly availableAt: string;
  readonly resolvedExecutors: readonly ResolvedFaiAuditJobExecutor[];
}

export interface FaiAuditJobIntent {
  readonly catalogCode: typeof FAI_AUDIT_JOB_CATALOG_CODE;
  readonly catalogVersion: typeof FAI_AUDIT_JOB_CATALOG_VERSION;
  readonly catalogHash: string;
  readonly workflowDefinitionHash: string;
  readonly phaseCode: FaiAuditState;
  readonly phaseEntrySequence: number;
  readonly sourceState: FaiAuditState;
  readonly sourceStateVersion: number;
  readonly correctionCycle: number;
  readonly executorAgentId: string;
  readonly executorAgentCode: string;
  readonly executorAgentConfigVersion: number;
  readonly executorAgentConfigHash: string;
  readonly jobCode: FaiAuditJobCode;
  readonly jobVersion: '1.0';
  readonly jobDefinitionHash: string;
  readonly completionTransitionCode: FaiAuditTransitionCode;
  readonly completionMode: 'SINGLE' | 'ALL_OF_BUNDLE';
  readonly slotKey: string;
  readonly bundleCode: FaiAuditJobBundleCode;
  readonly bundleKey: string;
  readonly dedupeKey: string;
  readonly provider: 'mock';
  readonly dataMode: 'synthetic';
  readonly automaticDispatchAllowed: false;
  readonly availableAt: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly payloadHash: string;
}

export interface FaiAuditJobPlan {
  readonly catalogKey: typeof FAI_AUDIT_JOB_CATALOG_KEY;
  readonly catalogHash: string;
  readonly planHash: string;
  readonly jobs: readonly FaiAuditJobIntent[];
}

const persistedJobIntentSchema = z.object({
  catalogCode: z.literal(FAI_AUDIT_JOB_CATALOG_CODE),
  catalogVersion: z.literal(FAI_AUDIT_JOB_CATALOG_VERSION),
  catalogHash: z.literal(FAI_AUDIT_JOB_CATALOG_HASH),
  workflowDefinitionHash: z.string().regex(/^[0-9a-f]{64}$/),
  phaseCode: z.enum(FAI_AUDIT_STATES), phaseEntrySequence: z.number().int().min(1),
  sourceState: z.enum(FAI_AUDIT_STATES), sourceStateVersion: z.number().int().min(1),
  correctionCycle: z.number().int().min(0),
  executorAgentId: z.string().min(1), executorAgentCode: z.string().min(1),
  executorAgentConfigVersion: z.number().int().min(1), executorAgentConfigHash: z.string().regex(/^[0-9a-f]{64}$/),
  jobCode: z.enum(FAI_AUDIT_JOB_CODES),
  jobVersion: z.literal('1.0'), jobDefinitionHash: z.string().regex(/^[0-9a-f]{64}$/),
  completionTransitionCode: z.enum(FAI_AUDIT_TRANSITION_CODES), completionMode: z.enum(['SINGLE', 'ALL_OF_BUNDLE']),
  slotKey: z.string().min(1), bundleCode: z.custom<FaiAuditJobBundleCode>((value) => typeof value === 'string'), bundleKey: z.string().regex(/^[0-9a-f]{64}$/),
  dedupeKey: z.string().regex(/^[0-9a-f]{64}$/), provider: z.literal('mock'), dataMode: z.literal('synthetic'),
  automaticDispatchAllowed: z.literal(false), availableAt: z.string().datetime({ offset: true }),
  payload: z.record(z.unknown()), payloadHash: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

/** Strictly validates a persisted row and recomputes all canonical v2 planning identities. */
export function parsePersistedFaiAuditJobIntent(input: unknown): FaiAuditJobIntent {
  const parsed = persistedJobIntentSchema.parse(input);
  const intent: FaiAuditJobIntent = {
    catalogCode: FAI_AUDIT_JOB_CATALOG_CODE, catalogVersion: FAI_AUDIT_JOB_CATALOG_VERSION,
    catalogHash: FAI_AUDIT_JOB_CATALOG_HASH, workflowDefinitionHash: parsed.workflowDefinitionHash,
    phaseCode: parsed.phaseCode, phaseEntrySequence: parsed.phaseEntrySequence,
    sourceState: parsed.sourceState, sourceStateVersion: parsed.sourceStateVersion,
    correctionCycle: parsed.correctionCycle, executorAgentId: parsed.executorAgentId,
    executorAgentCode: parsed.executorAgentCode, executorAgentConfigVersion: parsed.executorAgentConfigVersion,
    executorAgentConfigHash: parsed.executorAgentConfigHash, jobCode: parsed.jobCode,
    jobVersion: parsed.jobVersion, jobDefinitionHash: parsed.jobDefinitionHash,
    completionTransitionCode: parsed.completionTransitionCode, completionMode: parsed.completionMode,
    slotKey: parsed.slotKey, bundleCode: parsed.bundleCode, bundleKey: parsed.bundleKey,
    dedupeKey: parsed.dedupeKey, provider: parsed.provider, dataMode: parsed.dataMode,
    automaticDispatchAllowed: parsed.automaticDispatchAllowed, availableAt: parsed.availableAt,
    payload: parsed.payload, payloadHash: parsed.payloadHash,
  };
  const payload = intent.payload as Record<string, unknown>;
  const workflow = payload.workflow as Record<string, unknown> | undefined;
  const phase = payload.phase as Record<string, unknown> | undefined;
  const transition = payload.sourceTransition as Record<string, unknown> | undefined;
  const executor = payload.executor as Record<string, unknown> | undefined;
  const job = payload.job as Record<string, unknown> | undefined;
  if (
    Object.keys(payload).sort().join(',') !== 'catalogHash,catalogKey,executor,job,phase,schemaVersion,sourceTransition,workflow'
    || payload.schemaVersion !== 2 || payload.catalogKey !== FAI_AUDIT_JOB_CATALOG_KEY
    || payload.catalogHash !== FAI_AUDIT_JOB_CATALOG_HASH || !workflow || !phase || !transition || !executor || !job
  ) throw new TypeError('AI_PERSISTED_JOB_PAYLOAD_INVALID');
  const definition = getFaiAuditJobDefinition(intent.jobCode);
  const transitionCode = FAI_AUDIT_TRANSITION_CODES.find((code) => code === transition.transitionCode);
  const rule = transitionCode ? getFaiAuditJobPlanningRule(transitionCode) : null;
  const index = rule?.jobCodes.indexOf(intent.jobCode) ?? -1;
  const planningIdentity = {
    schemaVersion: 2, catalogKey: FAI_AUDIT_JOB_CATALOG_KEY, catalogHash: FAI_AUDIT_JOB_CATALOG_HASH,
    workflowInstanceId: workflow.workflowInstanceId, workflowDefinitionHash: workflow.workflowDefinitionHash,
    phaseCode: phase.phaseCode, phaseEntrySequence: phase.phaseEntrySequence,
    sourceCommandIdempotencyKey: transition.idempotencyKey, sourceTransitionCode: transition.transitionCode,
    sourceTransitionSequence: transition.sequence, sourceState: transition.sourceState,
    sourceStateVersion: transition.sourceStateVersion, correctionCycle: phase.correctionCycle,
  };
  const executorIdentity = {
    executorAgentId: executor.agentId, executorAgentCode: executor.agentCode,
    executorAgentConfigVersion: executor.configVersion, executorAgentConfigHash: executor.configHash,
  };
  const expectedSlot = `${String(index + 1).padStart(2, '0')}:${intent.jobCode}`;
  if (
    !definition || index < 0 || canonicalSha256(payload) !== intent.payloadHash
    || intent.jobDefinitionHash !== FAI_AUDIT_JOB_DEFINITION_HASHES[intent.jobCode]
    || intent.completionTransitionCode !== definition.completionTransitionCode
    || intent.completionMode !== definition.completionMode || intent.bundleCode !== definition.bundleCode
    || intent.slotKey !== expectedSlot
    || canonicalSha256({ ...planningIdentity, bundleCode: definition.bundleCode }) !== intent.bundleKey
    || canonicalSha256({ ...planningIdentity, ...executorIdentity, jobKey: `${intent.jobCode}@${intent.jobVersion}`, slotKey: expectedSlot }) !== intent.dedupeKey
    || intent.workflowDefinitionHash !== workflow.workflowDefinitionHash || intent.phaseCode !== phase.phaseCode
    || intent.phaseEntrySequence !== phase.phaseEntrySequence || intent.sourceState !== transition.sourceState
    || intent.sourceStateVersion !== transition.sourceStateVersion || intent.correctionCycle !== phase.correctionCycle
    || intent.executorAgentId !== executor.agentId || intent.executorAgentCode !== executor.agentCode
    || intent.executorAgentConfigVersion !== executor.configVersion || intent.executorAgentConfigHash !== executor.configHash
    || job.jobCode !== intent.jobCode || job.jobVersion !== intent.jobVersion || job.jobDefinitionHash !== intent.jobDefinitionHash
    || job.slotKey !== intent.slotKey || job.bundleCode !== intent.bundleCode || job.bundleKey !== intent.bundleKey
    || job.provider !== 'mock' || job.automaticDispatchAllowed !== false || workflow.dataMode !== 'synthetic'
  ) throw new TypeError('AI_PERSISTED_JOB_IDENTITY_MISMATCH');
  return Object.freeze(intent);
}

function canonicalPlanningIdentity(input: FaiAuditJobPlanInput) {
  return {
    schemaVersion: 2,
    catalogKey: FAI_AUDIT_JOB_CATALOG_KEY,
    catalogHash: FAI_AUDIT_JOB_CATALOG_HASH,
    workflowInstanceId: input.workflowInstanceId,
    workflowDefinitionHash: input.workflowDefinitionHash,
    phaseCode: input.phaseCode,
    phaseEntrySequence: input.phaseEntrySequence,
    sourceCommandIdempotencyKey: input.sourceCommandIdempotencyKey,
    sourceTransitionCode: input.sourceTransitionCode,
    sourceTransitionSequence: input.sourceTransitionSequence,
    sourceState: input.sourceState,
    sourceStateVersion: input.sourceStateVersion,
    correctionCycle: input.correctionCycle,
  };
}

export function createFaiAuditJobPlan(input: FaiAuditJobPlanInput): FaiAuditJobPlan {
  if (!Number.isInteger(input.phaseEntrySequence) || input.phaseEntrySequence < 1) {
    throw new Error('Identità di ingresso nella fase non valida.');
  }
  if (!Number.isInteger(input.sourceStateVersion) || input.sourceStateVersion < 1) {
    throw new Error('Versione dello stato sorgente non valida.');
  }
  const availableAt = new Date(input.availableAt);
  if (Number.isNaN(availableAt.getTime()) || availableAt.toISOString() !== input.availableAt) {
    throw new Error('Disponibilità temporale job non canonica.');
  }

  const rule = getFaiAuditJobPlanningRule(input.sourceTransitionCode);
  const planningIdentity = canonicalPlanningIdentity(input);
  const executorByJobCode = new Map(input.resolvedExecutors.map((executor) => [executor.jobCode, executor]));
  const jobs = (rule?.jobCodes ?? []).map((jobCode, index): FaiAuditJobIntent => {
    const definition = getFaiAuditJobDefinition(jobCode);
    const executor = executorByJobCode.get(jobCode);
    if (!definition) throw new Error(`Definizione job mancante per ${jobCode}.`);
    if (
      !executor
      || executor.executorAgentCode !== definition.executorAgentCode
      || executor.executorAgentConfigVersion !== definition.executorAgentConfigVersion
      || executor.executorAgentConfigHash !== definition.executorAgentConfigHash
    ) throw new Error(`Executor canonico non risolto per ${jobCode}.`);

    const slotKey = `${String(index + 1).padStart(2, '0')}:${jobCode}`;
    const bundleKey = canonicalSha256({
      ...planningIdentity,
      bundleCode: definition.bundleCode,
    });
    const executorIdentity = {
      executorAgentId: executor.executorAgentId,
      executorAgentCode: executor.executorAgentCode,
      executorAgentConfigVersion: executor.executorAgentConfigVersion,
      executorAgentConfigHash: executor.executorAgentConfigHash,
    };
    const dedupeKey = canonicalSha256({
      ...planningIdentity,
      ...executorIdentity,
      jobKey: `${definition.jobCode}@${definition.jobVersion}`,
      slotKey,
    });
    const payload = Object.freeze({
      schemaVersion: 2,
      catalogKey: FAI_AUDIT_JOB_CATALOG_KEY,
      catalogHash: FAI_AUDIT_JOB_CATALOG_HASH,
      workflow: {
        workflowCode: input.workflowCode,
        workflowVersion: input.workflowVersion,
        workflowDefinitionHash: input.workflowDefinitionHash,
        workflowInstanceId: input.workflowInstanceId,
        dataMode: definition.dataMode,
      },
      phase: {
        phaseCode: input.phaseCode,
        phaseEntrySequence: input.phaseEntrySequence,
        correctionCycle: input.correctionCycle,
      },
      sourceTransition: {
        transitionCode: input.sourceTransitionCode,
        sequence: input.sourceTransitionSequence,
        idempotencyKey: input.sourceCommandIdempotencyKey,
        correlationId: input.correlationId,
        sourceState: input.sourceState,
        sourceStateVersion: input.sourceStateVersion,
        targetState: input.targetState,
      },
      executor: {
        bindingVersion: FAI_AUDIT_EXECUTOR_BINDING_VERSION,
        agentId: executor.executorAgentId,
        agentCode: executor.executorAgentCode,
        configVersion: executor.executorAgentConfigVersion,
        configHash: executor.executorAgentConfigHash,
      },
      job: {
        jobCode: definition.jobCode,
        jobVersion: definition.jobVersion,
        jobDefinitionHash: FAI_AUDIT_JOB_DEFINITION_HASHES[definition.jobCode],
        completionTransitionCode: definition.completionTransitionCode,
        completionMode: definition.completionMode,
        slotKey,
        bundleCode: definition.bundleCode,
        bundleKey,
        provider: definition.provider,
        automaticDispatchAllowed: false,
        availableAt: input.availableAt,
      },
    });
    return Object.freeze({
      catalogCode: FAI_AUDIT_JOB_CATALOG_CODE,
      catalogVersion: FAI_AUDIT_JOB_CATALOG_VERSION,
      catalogHash: FAI_AUDIT_JOB_CATALOG_HASH,
      workflowDefinitionHash: input.workflowDefinitionHash,
      phaseCode: input.phaseCode,
      phaseEntrySequence: input.phaseEntrySequence,
      sourceState: input.sourceState,
      sourceStateVersion: input.sourceStateVersion,
      correctionCycle: input.correctionCycle,
      ...executorIdentity,
      jobCode: definition.jobCode,
      jobVersion: definition.jobVersion,
      jobDefinitionHash: FAI_AUDIT_JOB_DEFINITION_HASHES[definition.jobCode],
      completionTransitionCode: definition.completionTransitionCode,
      completionMode: definition.completionMode,
      slotKey,
      bundleCode: definition.bundleCode,
      bundleKey,
      dedupeKey,
      provider: definition.provider,
      dataMode: definition.dataMode,
      automaticDispatchAllowed: false,
      availableAt: input.availableAt,
      payload,
      payloadHash: canonicalSha256(payload),
    });
  });
  const planHash = canonicalSha256({
    ...planningIdentity,
    jobs: jobs.map((job) => ({
      executorAgentId: job.executorAgentId,
      executorAgentCode: job.executorAgentCode,
      executorAgentConfigVersion: job.executorAgentConfigVersion,
      executorAgentConfigHash: job.executorAgentConfigHash,
      jobCode: job.jobCode,
      jobVersion: job.jobVersion,
      jobDefinitionHash: job.jobDefinitionHash,
      slotKey: job.slotKey,
      bundleKey: job.bundleKey,
      dedupeKey: job.dedupeKey,
      payloadHash: job.payloadHash,
    })),
  });
  return Object.freeze({
    catalogKey: FAI_AUDIT_JOB_CATALOG_KEY,
    catalogHash: FAI_AUDIT_JOB_CATALOG_HASH,
    planHash,
    jobs: Object.freeze(jobs),
  });
}
