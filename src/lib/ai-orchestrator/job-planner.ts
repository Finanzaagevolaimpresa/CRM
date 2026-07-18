import { canonicalSha256 } from '../canonical-json';
import type { FaiAuditState, FaiAuditTransitionCode } from './audit-workflow-v1-1';
import {
  FAI_AUDIT_EXECUTOR_BINDING_VERSION,
  FAI_AUDIT_JOB_CATALOG_CODE,
  FAI_AUDIT_JOB_CATALOG_HASH,
  FAI_AUDIT_JOB_CATALOG_KEY,
  FAI_AUDIT_JOB_CATALOG_VERSION,
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
