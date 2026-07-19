import { z } from 'zod';
import { canonicalJson, canonicalSha256, sha256 } from '../canonical-json';
import { FAI_AUDIT_JOB_CODES, FAI_AUDIT_JOB_DEFINITION_HASHES, type FaiAuditJobCode } from './job-catalog-v1';
import { AI_ORCHESTRATOR_WORKER_CAPABILITY_HASHES, AI_ORCHESTRATOR_WORKER_RUNTIME_POLICY_HASH, getAiOrchestratorWorkerCapability } from './worker-runtime-policy-v1';

export const AI_RESULT_CONTRACT_VERSION = '1.0' as const;
export const AI_RESULT_CONTRACT_CATALOG_CODE = 'FAI-AUDIT-RESULT-ARTIFACT-CONTRACT-CATALOG' as const;
export const AI_RESULT_LIMITS = Object.freeze({ maxArtifacts: 8, maxArtifactBytes: 16 * 1024, maxResultBytes: 64 * 1024, maxSourceReferences: 16, maxJsonDepth: 8, maxJsonNodes: 512, maxStringBytes: 4096 } as const);
const FORBIDDEN = /(<\/?[a-z][\s\S]*>|https?:\/\/|file:\/\/|\b(prompt|secret|password|token|api[_-]?key|crm real|cliente reale)\b)/i;

const syntheticText = z.string().superRefine((value, ctx) => {
  if (Buffer.byteLength(value, 'utf8') > AI_RESULT_LIMITS.maxStringBytes) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'AI_RESULT_STRING_TOO_LARGE' });
  if (FORBIDDEN.test(value)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'AI_RESULT_FORBIDDEN_CONTENT_REDACTED' });
});
const score = z.number().min(0).max(1).finite();
const base = z.object({ synthetic: z.literal(true), summary: syntheticText }).strict();
const review = base.extend({ passed: z.boolean(), issues: z.array(syntheticText).max(16) }).strict();
const contracts = {
  DOCUMENT_INGESTION: { artifacts: ['DOCUMENT_MANIFEST'], schema: base.extend({ documentCount: z.number().int().min(0).max(100) }).strict() },
  DOCUMENT_CLASSIFICATION: { artifacts: ['DOCUMENT_CLASSIFICATION'], schema: base.extend({ classes: z.array(syntheticText).max(16) }).strict() },
  EVIDENCE_EXTRACTION: { artifacts: ['EVIDENCE_SET'], schema: base.extend({ evidenceItems: z.array(syntheticText).max(64) }).strict() },
  FINANCIAL_ANALYSIS: { artifacts: ['FINANCIAL_ANALYSIS'], schema: base.extend({ indicators: z.array(z.object({ code: syntheticText, value: z.number().finite() }).strict()).max(32) }).strict() },
  CREDIT_ANALYSIS: { artifacts: ['CREDIT_ANALYSIS'], schema: base.extend({ rating: syntheticText, confidence: score }).strict() },
  CALCULATIONS: { artifacts: ['CALCULATION_SET'], schema: base.extend({ calculations: z.array(z.object({ code: syntheticText, value: z.number().finite() }).strict()).max(64) }).strict() },
  FINDINGS_DRAFTING: { artifacts: ['FINDINGS_DRAFT'], schema: base.extend({ findings: z.array(syntheticText).max(32) }).strict() },
  REPORT_COMPOSITION: { artifacts: ['REPORT_DRAFT'], schema: base.extend({ sections: z.array(syntheticText).max(32) }).strict() },
  SCHEMA_REVIEW: { artifacts: ['SCHEMA_REVIEW_REPORT'], schema: review },
  NUMERIC_REVIEW: { artifacts: ['NUMERIC_REVIEW_REPORT'], schema: review },
  SOURCE_REVIEW: { artifacts: ['SOURCE_REVIEW_REPORT'], schema: review },
  RED_TEAM_REVIEW: { artifacts: ['RED_TEAM_REVIEW_REPORT'], schema: review },
  CORRECTION: { artifacts: ['CORRECTED_REPORT', 'CORRECTION_MANIFEST'], schema: base.extend({ correctedSections: z.array(syntheticText).max(32), correctionReasons: z.array(syntheticText).max(32) }).strict() },
} satisfies Record<FaiAuditJobCode, { artifacts: readonly string[]; schema: z.ZodTypeAny }>;

export type AiResultArtifactDraft = z.infer<typeof AiResultArtifactDraftSchema>;
export const AiResultArtifactDraftSchema = z.object({
  resultPayload: z.unknown(),
  artifacts: z.array(z.object({ ordinal: z.number().int().min(0), slotCode: z.string().regex(/^[A-Z0-9_]+$/), logicalKey: z.string().regex(/^[A-Za-z0-9_.:-]{1,120}$/), artifactType: z.string().regex(/^[A-Z0-9_]+$/), artifactVersion: z.string().regex(/^1\.0$/), mediaType: z.literal('application/json'), payload: z.unknown(), supersedesArtifactId: z.string().cuid().optional() }).strict()).max(AI_RESULT_LIMITS.maxArtifacts),
  sourceReferences: z.array(z.object({ sourceArtifactId: z.string().cuid(), sourceArtifactHash: z.string().regex(/^[0-9a-f]{64}$/), role: z.string().regex(/^[A-Z0-9_]+$/), ordinal: z.number().int().min(0) }).strict()).max(AI_RESULT_LIMITS.maxSourceReferences).default([]),
  retention: z.object({ policyCode: z.literal('AI_RESULT_ARTIFACT_RETENTION_V1'), policyVersion: z.literal('1.0'), retentionClass: z.enum(['AUDIT_SYNTHETIC', 'TEMPORARY_SYNTHETIC']), retainUntil: z.string().datetime().optional() }).strict(),
}).strict();

export const AI_RESULT_CONTRACTS = Object.freeze(Object.fromEntries(FAI_AUDIT_JOB_CODES.map((jobCode) => {
  const capability = getAiOrchestratorWorkerCapability(jobCode)!;
  const c = contracts[jobCode];
  const identity = { schemaVersion: 1, catalogCode: AI_RESULT_CONTRACT_CATALOG_CODE, resultContractCode: `FAI_AUDIT_${jobCode}_RESULT`, resultContractVersion: AI_RESULT_CONTRACT_VERSION, jobCode, jobDefinitionHash: FAI_AUDIT_JOB_DEFINITION_HASHES[jobCode], capabilityHash: AI_ORCHESTRATOR_WORKER_CAPABILITY_HASHES[jobCode], handlerCode: capability.handlerCode, handlerVersion: capability.handlerVersion, runtimePolicyHash: AI_ORCHESTRATOR_WORKER_RUNTIME_POLICY_HASH, artifactTypes: c.artifacts };
  return [jobCode, Object.freeze({ ...identity, resultContractHash: canonicalSha256({ domain: 'ai.resultContract.v1', ...identity }), schema: c.schema, requiredArtifactTypes: c.artifacts })];
})) as unknown as Record<FaiAuditJobCode, Readonly<{ resultContractCode: string; resultContractVersion: '1.0'; resultContractHash: string; requiredArtifactTypes: readonly string[]; schema: z.ZodTypeAny }>>);
export const AI_RESULT_CONTRACT_BY_JOB = new Map(Object.entries(AI_RESULT_CONTRACTS));
export const AI_RESULT_CONTRACT_CATALOG_HASH = canonicalSha256({ domain: 'ai.resultContractCatalog.v1', contracts: Object.fromEntries(Object.entries(AI_RESULT_CONTRACTS).map(([k, v]) => [k, { resultContractCode: v.resultContractCode, resultContractVersion: v.resultContractVersion, resultContractHash: v.resultContractHash, requiredArtifactTypes: v.requiredArtifactTypes }])) });

function inspectJson(value: unknown, depth = 1): { nodes: number; maxDepth: number } {
  if (depth > AI_RESULT_LIMITS.maxJsonDepth) throw new TypeError('AI_RESULT_JSON_TOO_DEEP');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return { nodes: 1, maxDepth: depth };
  if (typeof value === 'number') { if (!Number.isFinite(value) || !Number.isSafeInteger(value) && Number.isInteger(value)) throw new TypeError('AI_RESULT_UNSAFE_NUMBER'); return { nodes: 1, maxDepth: depth }; }
  if (Array.isArray(value)) return value.reduce<{ nodes: number; maxDepth: number }>((a, v) => { const r = inspectJson(v, depth + 1); return { nodes: a.nodes + r.nodes, maxDepth: Math.max(a.maxDepth, r.maxDepth) }; }, { nodes: 1, maxDepth: depth });
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) return Object.values(value as Record<string, unknown>).reduce<{ nodes: number; maxDepth: number }>((a, v) => { const r = inspectJson(v, depth + 1); return { nodes: a.nodes + r.nodes, maxDepth: Math.max(a.maxDepth, r.maxDepth) }; }, { nodes: 1, maxDepth: depth });
  throw new TypeError('AI_RESULT_NON_JSON');
}
function assertPayload(value: unknown, limit: number) { const canonical = canonicalJson(value); const bytes = Buffer.byteLength(canonical, 'utf8'); const i = inspectJson(value); if (i.nodes > AI_RESULT_LIMITS.maxJsonNodes) throw new TypeError('AI_RESULT_JSON_TOO_LARGE'); if (bytes > limit) throw new TypeError('AI_RESULT_BYTES_TOO_LARGE'); if (FORBIDDEN.test(canonical)) throw new TypeError('AI_RESULT_FORBIDDEN_CONTENT_REDACTED'); return { canonical, bytes, payloadHash: sha256(`ai.payload.v1\n${canonical}`) }; }
export function validateAndHashAiResultDraft(jobCode: string, draftInput: unknown, provenance: Record<string, unknown>) {
  const contract = AI_RESULT_CONTRACT_BY_JOB.get(jobCode); if (!contract) throw new TypeError('AI_RESULT_CONTRACT_NOT_FOUND');
  const draft = AiResultArtifactDraftSchema.parse(draftInput); const resultPayload = contract.schema.parse(draft.resultPayload);
  const expected = [...contract.requiredArtifactTypes].sort(); const actual = draft.artifacts.map((a) => a.artifactType).sort(); if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new TypeError('AI_RESULT_ARTIFACT_CARDINALITY_INVALID');
  const seen = new Set<string>(); const artifacts = [...draft.artifacts].sort((a, b) => a.ordinal - b.ordinal).map((a, index) => { if (a.ordinal !== index) throw new TypeError('AI_RESULT_ARTIFACT_ORDER_INVALID'); if (seen.has(a.slotCode)) throw new TypeError('AI_RESULT_ARTIFACT_SLOT_DUPLICATE'); seen.add(a.slotCode); const p = contract.schema.parse(a.payload); const h = assertPayload(p, AI_RESULT_LIMITS.maxArtifactBytes); return { ...a, payload: p, payloadBytes: h.bytes, payloadHash: h.payloadHash, artifactSchemaCode: `${a.artifactType}_SCHEMA`, artifactSchemaVersion: '1.0', artifactSchemaHash: canonicalSha256({ domain: 'ai.artifactSchema.v1', artifactType: a.artifactType, version: '1.0' }), artifactHash: canonicalSha256({ domain: 'ai.artifact.v1', ordinal: a.ordinal, slotCode: a.slotCode, logicalKey: a.logicalKey, artifactType: a.artifactType, artifactVersion: a.artifactVersion, mediaType: a.mediaType, payloadHash: h.payloadHash, supersedesArtifactId: a.supersedesArtifactId ?? null }) }; });
  const rp = assertPayload(resultPayload, AI_RESULT_LIMITS.maxResultBytes); const sourceReferences = [...draft.sourceReferences].sort((a, b) => a.ordinal - b.ordinal); sourceReferences.forEach((s, i) => { if (s.ordinal !== i) throw new TypeError('AI_RESULT_SOURCE_ORDER_INVALID'); });
  const retentionPolicyHash = canonicalSha256({ domain: 'ai.retentionPolicy.v1', ...draft.retention });
  const manifestHash = canonicalSha256({ domain: 'ai.manifest.v1', artifactHashes: artifacts.map((a) => a.artifactHash), sourceReferences, retention: { ...draft.retention, retentionPolicyHash } });
  const resultHash = canonicalSha256({ domain: 'ai.result.v1', provenance, resultContractHash: contract.resultContractHash, resultPayloadHash: rp.payloadHash, manifestHash, artifactHashes: artifacts.map((a) => a.artifactHash), sourceReferences });
  return { contract, resultPayload, resultPayloadHash: rp.payloadHash, resultPayloadBytes: rp.bytes, artifacts, sourceReferences, retention: { ...draft.retention, retentionPolicyHash }, manifestHash, resultHash, resultContractHash: contract.resultContractHash };
}
