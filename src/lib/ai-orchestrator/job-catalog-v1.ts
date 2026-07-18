import { canonicalSha256 } from '../canonical-json';
import {
  FAI_AUDIT_WORKFLOW_KEY,
  type FaiAuditTransitionCode,
} from './audit-workflow-v1-1';

export const FAI_AUDIT_JOB_CATALOG_CODE = 'FAI-AUDIT-JOB-CATALOG' as const;
export const FAI_AUDIT_JOB_CATALOG_VERSION = '1.0' as const;
export const FAI_AUDIT_JOB_CATALOG_KEY = `${FAI_AUDIT_JOB_CATALOG_CODE}@${FAI_AUDIT_JOB_CATALOG_VERSION}` as const;
export const FAI_AUDIT_EXECUTOR_BINDING_VERSION = '1.0' as const;

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

export interface FaiAuditExecutorBinding {
  readonly bindingVersion: typeof FAI_AUDIT_EXECUTOR_BINDING_VERSION;
  readonly jobCode: FaiAuditJobCode;
  readonly executorAgentCode: string;
  readonly executorAgentConfigVersion: 1;
  readonly executorAgentConfigHash: string;
}

function defineExecutor(
  jobCode: FaiAuditJobCode,
  executorAgentCode: string,
  executorAgentConfigHash: string,
): Readonly<FaiAuditExecutorBinding> {
  return Object.freeze({
    bindingVersion: FAI_AUDIT_EXECUTOR_BINDING_VERSION,
    jobCode,
    executorAgentCode,
    executorAgentConfigVersion: 1,
    executorAgentConfigHash,
  });
}

/** Canonical, versioned job -> immutable executor config mapping. */
export const FAI_AUDIT_JOB_EXECUTOR_BINDINGS = Object.freeze([
  defineExecutor('DOCUMENT_INGESTION', 'verifica_ai_preliminare_fai', '99ae44b882e1cd1f52c04b8ec2ab5aa4ef2e54cb09ae0b2aecdd16587c0b4f67'),
  defineExecutor('DOCUMENT_CLASSIFICATION', 'verifica_ai_preliminare_fai', '99ae44b882e1cd1f52c04b8ec2ab5aa4ef2e54cb09ae0b2aecdd16587c0b4f67'),
  defineExecutor('EVIDENCE_EXTRACTION', 'pre_analisi_ai_ammissibilita_fai', '3b5902fb767a64e7710d5bd71cc283102d0df3a4a6184d8786e6a5f06510ef5c'),
  defineExecutor('FINANCIAL_ANALYSIS', 'business_plan_fai', '48baa1112ed62a6cba09f35dea87557adf43df7304feefb5693f9379a8340e3e'),
  defineExecutor('CREDIT_ANALYSIS', 'audit_ai_bancabilita_fai', 'e575e630bbd7daeb92e281619a374fff8afd064c18adb5d833af177fe7ebbb4c'),
  defineExecutor('CALCULATIONS', 'business_plan_fai', '48baa1112ed62a6cba09f35dea87557adf43df7304feefb5693f9379a8340e3e'),
  defineExecutor('FINDINGS_DRAFTING', 'pre_analisi_ai_ammissibilita_fai', '3b5902fb767a64e7710d5bd71cc283102d0df3a4a6184d8786e6a5f06510ef5c'),
  defineExecutor('REPORT_COMPOSITION', 'dossier_strategico_fai', 'd9c6dc5418e2beb0ac1468770cfa7f629b870ef2312df2f8ca20f53f5135af49'),
  defineExecutor('SCHEMA_REVIEW', 'revisore_ai_fai', '6336bbc6c1e44fc90b70a409dfc43778020bae4565b19abe573ae7ef101dd18f'),
  defineExecutor('NUMERIC_REVIEW', 'revisore_ai_fai', '6336bbc6c1e44fc90b70a409dfc43778020bae4565b19abe573ae7ef101dd18f'),
  defineExecutor('SOURCE_REVIEW', 'revisore_ai_fai', '6336bbc6c1e44fc90b70a409dfc43778020bae4565b19abe573ae7ef101dd18f'),
  defineExecutor('RED_TEAM_REVIEW', 'revisore_ai_fai', '6336bbc6c1e44fc90b70a409dfc43778020bae4565b19abe573ae7ef101dd18f'),
  defineExecutor('CORRECTION', 'ottimizzazione_ai_progetto_fai', '2b213d8a828c55a16eb14be27b18a90812e530ecd522a073576d8e36e33a58ff'),
] as const satisfies readonly FaiAuditExecutorBinding[]);

const executorBindingByJobCode = new Map<FaiAuditJobCode, Readonly<FaiAuditExecutorBinding>>(
  FAI_AUDIT_JOB_EXECUTOR_BINDINGS.map((binding) => [binding.jobCode, binding]),
);

export interface FaiAuditJobDefinition {
  readonly jobCode: FaiAuditJobCode;
  readonly jobVersion: '1.0';
  readonly bundleCode: FaiAuditJobBundleCode;
  readonly completionMode: 'SINGLE' | 'ALL_OF_BUNDLE';
  readonly completionTransitionCode: FaiAuditTransitionCode;
  readonly executorBindingVersion: typeof FAI_AUDIT_EXECUTOR_BINDING_VERSION;
  readonly executorAgentCode: string;
  readonly executorAgentConfigVersion: 1;
  readonly executorAgentConfigHash: string;
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
  const executor = executorBindingByJobCode.get(jobCode);
  if (!executor) throw new Error(`Binding executor mancante per ${jobCode}.`);
  return Object.freeze({
    jobCode,
    jobVersion: '1.0',
    bundleCode,
    completionMode,
    completionTransitionCode,
    executorBindingVersion: executor.bindingVersion,
    executorAgentCode: executor.executorAgentCode,
    executorAgentConfigVersion: executor.executorAgentConfigVersion,
    executorAgentConfigHash: executor.executorAgentConfigHash,
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

export function getFaiAuditExecutorBinding(jobCode: FaiAuditJobCode) {
  return executorBindingByJobCode.get(jobCode) ?? null;
}

export function getFaiAuditJobPlanningRule(transitionCode: FaiAuditTransitionCode) {
  return jobPlanningRuleByTransition.get(transitionCode) ?? null;
}

export function createFaiAuditJobDefinitionHash(definition: FaiAuditJobDefinition) {
  return canonicalSha256({
    schemaVersion: 2,
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
    schemaVersion: 2,
    catalogCode: FAI_AUDIT_JOB_CATALOG_CODE,
    catalogVersion: FAI_AUDIT_JOB_CATALOG_VERSION,
    workflowKey: FAI_AUDIT_WORKFLOW_KEY,
    executorBindingVersion: FAI_AUDIT_EXECUTOR_BINDING_VERSION,
    executorBindings: FAI_AUDIT_JOB_EXECUTOR_BINDINGS,
    definitions: FAI_AUDIT_JOB_DEFINITIONS,
    planningRules: FAI_AUDIT_JOB_PLANNING_RULES,
  });
}

export const FAI_AUDIT_JOB_CATALOG_HASH = createFaiAuditJobCatalogHash();

export function getFaiAuditJobCatalogInvariantErrors() {
  const errors: string[] = [];
  const definitionCodes = FAI_AUDIT_JOB_DEFINITIONS.map(({ jobCode }) => jobCode);
  const executorCodes = FAI_AUDIT_JOB_EXECUTOR_BINDINGS.map(({ jobCode }) => jobCode);
  const ruleTransitions = FAI_AUDIT_JOB_PLANNING_RULES.map(({ sourceTransitionCode }) => sourceTransitionCode);
  if (new Set(definitionCodes).size !== definitionCodes.length) errors.push('Job code duplicato nel catalogo.');
  if (new Set(executorCodes).size !== executorCodes.length) errors.push('Binding executor duplicato nel catalogo.');
  if (new Set(ruleTransitions).size !== ruleTransitions.length) errors.push('Transizione duplicata nelle regole di planning.');
  if (definitionCodes.length !== FAI_AUDIT_JOB_CODES.length) errors.push('Il catalogo non definisce tutti i job canonici.');
  if (executorCodes.length !== FAI_AUDIT_JOB_CODES.length) errors.push('Il catalogo non lega tutti i job a un executor.');
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
    const executor = executorBindingByJobCode.get(definition.jobCode);
    if (
      !executor
      || executor.executorAgentCode !== definition.executorAgentCode
      || executor.executorAgentConfigVersion !== definition.executorAgentConfigVersion
      || executor.executorAgentConfigHash !== definition.executorAgentConfigHash
      || !/^[0-9a-f]{64}$/.test(definition.executorAgentConfigHash)
    ) errors.push(`${definition.jobCode} ha un binding executor incoerente.`);
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
