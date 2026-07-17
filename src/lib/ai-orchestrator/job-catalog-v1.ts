import { canonicalSha256 } from '../canonical-json';
import {
  FAI_AUDIT_WORKFLOW_KEY,
  type FaiAuditTransitionCode,
} from './audit-workflow-v1-1';

export const FAI_AUDIT_JOB_CATALOG_CODE = 'FAI-AUDIT-JOB-CATALOG' as const;
export const FAI_AUDIT_JOB_CATALOG_VERSION = '1.0' as const;
export const FAI_AUDIT_JOB_CATALOG_KEY = `${FAI_AUDIT_JOB_CATALOG_CODE}@${FAI_AUDIT_JOB_CATALOG_VERSION}` as const;

export const FAI_AUDIT_JOB_CODES = Object.freeze([
  'DOCUMENT_INGESTION',
  'DOCUMENT_CLASSIFICATION',
  'EVIDENCE_EXTRACTION',
  'FINANCIAL_ANALYSIS',
  'CREDIT_ANALYSIS',
  'CALCULATIONS',
  'FINDINGS_DRAFTING',
  'REPORT_COMPOSITION',
  'SCHEMA_REVIEW',
  'NUMERIC_REVIEW',
  'SOURCE_REVIEW',
  'RED_TEAM_REVIEW',
  'CORRECTION',
] as const);

export type FaiAuditJobCode = typeof FAI_AUDIT_JOB_CODES[number];
export type FaiAuditJobStatus = 'PLANNED' | 'BLOCKED';
export type FaiAuditJobBundleCode =
  | 'DOCUMENT_PIPELINE'
  | 'ANALYSIS_BUNDLE'
  | 'DRAFTING_PIPELINE'
  | 'REVIEW_BUNDLE'
  | 'CORRECTION_PIPELINE';

export interface FaiAuditJobDefinition {
  readonly jobCode: FaiAuditJobCode;
  readonly jobVersion: '1.0';
  readonly bundleCode: FaiAuditJobBundleCode;
  readonly completionMode: 'SINGLE' | 'ALL_OF_BUNDLE';
  readonly completionTransitionCode: FaiAuditTransitionCode;
  readonly provider: 'mock';
  readonly dataMode: 'synthetic';
  readonly automaticDispatchAllowed: false;
}

function defineJob(
  jobCode: FaiAuditJobCode,
  bundleCode: FaiAuditJobBundleCode,
  completionTransitionCode: FaiAuditTransitionCode,
  completionMode: FaiAuditJobDefinition['completionMode'] = 'SINGLE',
): Readonly<FaiAuditJobDefinition> {
  return Object.freeze({
    jobCode,
    jobVersion: '1.0',
    bundleCode,
    completionMode,
    completionTransitionCode,
    provider: 'mock',
    dataMode: 'synthetic',
    automaticDispatchAllowed: false,
  });
}

export const FAI_AUDIT_JOB_DEFINITIONS = Object.freeze([
  defineJob('DOCUMENT_INGESTION', 'DOCUMENT_PIPELINE', 'WF-005'),
  defineJob('DOCUMENT_CLASSIFICATION', 'DOCUMENT_PIPELINE', 'WF-006'),
  defineJob('EVIDENCE_EXTRACTION', 'DOCUMENT_PIPELINE', 'WF-007'),
  defineJob('FINANCIAL_ANALYSIS', 'ANALYSIS_BUNDLE', 'WF-011', 'ALL_OF_BUNDLE'),
  defineJob('CREDIT_ANALYSIS', 'ANALYSIS_BUNDLE', 'WF-011', 'ALL_OF_BUNDLE'),
  defineJob('CALCULATIONS', 'ANALYSIS_BUNDLE', 'WF-011', 'ALL_OF_BUNDLE'),
  defineJob('FINDINGS_DRAFTING', 'DRAFTING_PIPELINE', 'WF-012'),
  defineJob('REPORT_COMPOSITION', 'DRAFTING_PIPELINE', 'WF-013'),
  defineJob('SCHEMA_REVIEW', 'REVIEW_BUNDLE', 'WF-014', 'ALL_OF_BUNDLE'),
  defineJob('NUMERIC_REVIEW', 'REVIEW_BUNDLE', 'WF-014', 'ALL_OF_BUNDLE'),
  defineJob('SOURCE_REVIEW', 'REVIEW_BUNDLE', 'WF-014', 'ALL_OF_BUNDLE'),
  defineJob('RED_TEAM_REVIEW', 'REVIEW_BUNDLE', 'WF-014', 'ALL_OF_BUNDLE'),
  defineJob('CORRECTION', 'CORRECTION_PIPELINE', 'WF-016'),
] as const satisfies readonly FaiAuditJobDefinition[]);

export interface FaiAuditJobPlanningRule {
  readonly sourceTransitionCode: FaiAuditTransitionCode;
  readonly jobCodes: readonly FaiAuditJobCode[];
}

function defineRule(
  sourceTransitionCode: FaiAuditTransitionCode,
  jobCodes: readonly FaiAuditJobCode[],
): Readonly<FaiAuditJobPlanningRule> {
  return Object.freeze({ sourceTransitionCode, jobCodes: Object.freeze([...jobCodes]) });
}

export const FAI_AUDIT_JOB_PLANNING_RULES = Object.freeze([
  defineRule('WF-004', ['DOCUMENT_INGESTION']),
  defineRule('WF-005', ['DOCUMENT_CLASSIFICATION']),
  defineRule('WF-006', ['EVIDENCE_EXTRACTION']),
  defineRule('WF-009', ['DOCUMENT_INGESTION']),
  defineRule('WF-010', ['FINANCIAL_ANALYSIS', 'CREDIT_ANALYSIS', 'CALCULATIONS']),
  defineRule('WF-011', ['FINDINGS_DRAFTING']),
  defineRule('WF-012', ['REPORT_COMPOSITION']),
  defineRule('WF-013', ['SCHEMA_REVIEW', 'NUMERIC_REVIEW', 'SOURCE_REVIEW', 'RED_TEAM_REVIEW']),
  defineRule('WF-015', ['CORRECTION']),
  defineRule('WF-016', ['SCHEMA_REVIEW', 'NUMERIC_REVIEW', 'SOURCE_REVIEW', 'RED_TEAM_REVIEW']),
] as const satisfies readonly FaiAuditJobPlanningRule[]);

const jobDefinitionByCode = new Map<FaiAuditJobCode, Readonly<FaiAuditJobDefinition>>(
  FAI_AUDIT_JOB_DEFINITIONS.map((definition) => [definition.jobCode, definition]),
);
const jobPlanningRuleByTransition = new Map<FaiAuditTransitionCode, Readonly<FaiAuditJobPlanningRule>>(
  FAI_AUDIT_JOB_PLANNING_RULES.map((rule) => [rule.sourceTransitionCode, rule]),
);

export function getFaiAuditJobDefinition(jobCode: FaiAuditJobCode) {
  return jobDefinitionByCode.get(jobCode) ?? null;
}

export function getFaiAuditJobPlanningRule(transitionCode: FaiAuditTransitionCode) {
  return jobPlanningRuleByTransition.get(transitionCode) ?? null;
}

export function createFaiAuditJobDefinitionHash(definition: FaiAuditJobDefinition) {
  return canonicalSha256({
    schemaVersion: 1,
    catalogKey: FAI_AUDIT_JOB_CATALOG_KEY,
    definition,
  });
}

export const FAI_AUDIT_JOB_DEFINITION_HASHES = Object.freeze(Object.fromEntries(
  FAI_AUDIT_JOB_DEFINITIONS.map((definition) => [
    definition.jobCode,
    createFaiAuditJobDefinitionHash(definition),
  ]),
) as Readonly<Record<FaiAuditJobCode, string>>);

export function createFaiAuditJobCatalogHash() {
  return canonicalSha256({
    schemaVersion: 1,
    catalogCode: FAI_AUDIT_JOB_CATALOG_CODE,
    catalogVersion: FAI_AUDIT_JOB_CATALOG_VERSION,
    workflowKey: FAI_AUDIT_WORKFLOW_KEY,
    definitions: FAI_AUDIT_JOB_DEFINITIONS,
    planningRules: FAI_AUDIT_JOB_PLANNING_RULES,
  });
}

export const FAI_AUDIT_JOB_CATALOG_HASH = createFaiAuditJobCatalogHash();

export function getFaiAuditJobCatalogInvariantErrors() {
  const errors: string[] = [];
  const definitionCodes = FAI_AUDIT_JOB_DEFINITIONS.map(({ jobCode }) => jobCode);
  const ruleTransitions = FAI_AUDIT_JOB_PLANNING_RULES.map(({ sourceTransitionCode }) => sourceTransitionCode);
  if (new Set(definitionCodes).size !== definitionCodes.length) errors.push('Job code duplicato nel catalogo.');
  if (new Set(ruleTransitions).size !== ruleTransitions.length) errors.push('Transizione duplicata nelle regole di planning.');
  if (definitionCodes.length !== FAI_AUDIT_JOB_CODES.length) errors.push('Il catalogo non definisce tutti i job canonici.');
  for (const rule of FAI_AUDIT_JOB_PLANNING_RULES) {
    if (Number(rule.sourceTransitionCode.slice(3)) >= 17) {
      errors.push(`${rule.sourceTransitionCode} non può pianificare job oltre la barriera Foundation.`);
    }
    if (rule.jobCodes.length === 0) errors.push(`${rule.sourceTransitionCode} ha una regola vuota.`);
    for (const jobCode of rule.jobCodes) {
      if (!jobDefinitionByCode.has(jobCode)) errors.push(`${jobCode} non è definito nel catalogo.`);
    }
  }
  for (const definition of FAI_AUDIT_JOB_DEFINITIONS) {
    if (
      definition.provider !== 'mock'
      || definition.dataMode !== 'synthetic'
      || definition.automaticDispatchAllowed !== false
    ) errors.push(`${definition.jobCode} viola la policy fail-closed.`);
    if (Number(definition.completionTransitionCode.slice(3)) >= 17) {
      errors.push(`${definition.jobCode} punta oltre la barriera HUMAN_APPROVAL.`);
    }
  }
  return errors;
}
