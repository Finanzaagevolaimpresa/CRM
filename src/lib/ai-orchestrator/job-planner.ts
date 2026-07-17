import { canonicalSha256 } from '../canonical-json';
import type { FaiAuditState, FaiAuditTransitionCode } from './audit-workflow-v1-1';
import {
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

export interface FaiAuditJobPlanInput {
  readonly workflowInstanceId: string;
  readonly workflowCode: string;
  readonly workflowVersion: string;
  readonly sourceCommandIdempotencyKey: string;
  readonly sourceTransitionCode: FaiAuditTransitionCode;
  readonly sourceTransitionSequence: number;
  readonly correlationId: string;
  readonly correctionCycle: number;
  readonly fromState: FaiAuditState;
  readonly toState: FaiAuditState;
}

export interface FaiAuditJobIntent {
  readonly catalogCode: typeof FAI_AUDIT_JOB_CATALOG_CODE;
  readonly catalogVersion: typeof FAI_AUDIT_JOB_CATALOG_VERSION;
  readonly catalogHash: string;
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
    schemaVersion: 1,
    catalogKey: FAI_AUDIT_JOB_CATALOG_KEY,
    catalogHash: FAI_AUDIT_JOB_CATALOG_HASH,
    workflowInstanceId: input.workflowInstanceId,
    sourceCommandIdempotencyKey: input.sourceCommandIdempotencyKey,
    sourceTransitionCode: input.sourceTransitionCode,
    sourceTransitionSequence: input.sourceTransitionSequence,
    correctionCycle: input.correctionCycle,
  };
}

export function createFaiAuditJobPlan(input: FaiAuditJobPlanInput): FaiAuditJobPlan {
  const rule = getFaiAuditJobPlanningRule(input.sourceTransitionCode);
  const planningIdentity = canonicalPlanningIdentity(input);
  const jobs = (rule?.jobCodes ?? []).map((jobCode, index): FaiAuditJobIntent => {
    const definition = getFaiAuditJobDefinition(jobCode);
    if (!definition) throw new Error(`Definizione job mancante per ${jobCode}.`);
    const slotKey = `${String(index + 1).padStart(2, '0')}:${jobCode}`;
    const bundleKey = canonicalSha256({
      ...planningIdentity,
      bundleCode: definition.bundleCode,
    });
    const dedupeKey = canonicalSha256({
      ...planningIdentity,
      jobKey: `${definition.jobCode}@${definition.jobVersion}`,
      slotKey,
    });
    const payload = Object.freeze({
      schemaVersion: 1,
      catalogKey: FAI_AUDIT_JOB_CATALOG_KEY,
      catalogHash: FAI_AUDIT_JOB_CATALOG_HASH,
      workflow: {
        workflowCode: input.workflowCode,
        workflowVersion: input.workflowVersion,
        workflowInstanceId: input.workflowInstanceId,
        dataMode: definition.dataMode,
      },
      sourceTransition: {
        transitionCode: input.sourceTransitionCode,
        sequence: input.sourceTransitionSequence,
        idempotencyKey: input.sourceCommandIdempotencyKey,
        correlationId: input.correlationId,
        fromState: input.fromState,
        toState: input.toState,
        correctionCycle: input.correctionCycle,
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
      },
    });
    return Object.freeze({
      catalogCode: FAI_AUDIT_JOB_CATALOG_CODE,
      catalogVersion: FAI_AUDIT_JOB_CATALOG_VERSION,
      catalogHash: FAI_AUDIT_JOB_CATALOG_HASH,
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
      payload,
      payloadHash: canonicalSha256(payload),
    });
  });
  const planHash = canonicalSha256({
    ...planningIdentity,
    jobs: jobs.map((job) => ({
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
