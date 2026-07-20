import { z } from 'zod';
import { canonicalJson, canonicalSha256, sha256 } from '../canonical-json';
import { FAI_AUDIT_JOB_CODES, FAI_AUDIT_JOB_DEFINITION_HASHES, type FaiAuditJobCode } from './job-catalog-v1';
import { AI_ORCHESTRATOR_WORKER_CAPABILITY_HASHES, AI_ORCHESTRATOR_WORKER_RUNTIME_POLICY_HASH, getAiOrchestratorWorkerCapability } from './worker-runtime-policy-v1';

export const AI_RESULT_CONTRACT_VERSION = '1.0' as const;
export const AI_RESULT_CONTRACT_CATALOG_CODE = 'FAI-AUDIT-RESULT-ARTIFACT-CONTRACT-CATALOG' as const;
export const AI_RESULT_LIMITS = Object.freeze({
  maxArtifacts: 8,
  maxArtifactBytes: 16 * 1024,
  maxResultBytes: 64 * 1024,
  maxSourceReferences: 16,
  maxJsonDepth: 8,
  maxJsonNodes: 512,
  maxStringBytes: 4096,
  maxCodeBytes: 120,
} as const);

const HASH_RE = /^[0-9a-f]{64}$/;
const UPPER_CODE_RE = /^[A-Z0-9_]{1,120}$/;
const CANONICAL_IDENTITY_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_.:_-]{0,199}$/;
const FORBIDDEN = /(<\/?[a-z][\s\S]*>|https?:\/\/|file:\/\/|\b(prompt|secret|password|token|api[_-]?key|crm real|cliente reale)\b)/i;

const upperCode = z.string().regex(UPPER_CODE_RE).superRefine((value, ctx) => {
  if (Buffer.byteLength(value, 'utf8') > AI_RESULT_LIMITS.maxCodeBytes) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'AI_RESULT_CODE_TOO_LARGE' });
});
const identityCode = z.string().regex(CANONICAL_IDENTITY_CODE_RE);
const logicalKey = z.string().regex(/^[A-Za-z0-9_.:-]{1,120}$/);
const syntheticText = z.string().superRefine((value, ctx) => {
  if (Buffer.byteLength(value, 'utf8') > AI_RESULT_LIMITS.maxStringBytes) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'AI_RESULT_STRING_TOO_LARGE' });
  if (FORBIDDEN.test(value)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'AI_RESULT_FORBIDDEN_CONTENT_REDACTED' });
});
const score = z.number().min(0).max(1).finite();
const base = z.object({ synthetic: z.literal(true), summary: syntheticText }).strict();
const review = base.extend({ passed: z.boolean(), issues: z.array(syntheticText).max(16) }).strict();

const artifactSchemas = Object.freeze({
  DOCUMENT_MANIFEST: base.extend({ documentCount: z.number().int().min(0).max(100) }).strict(),
  DOCUMENT_CLASSIFICATION: base.extend({ classes: z.array(syntheticText).max(16) }).strict(),
  EVIDENCE_SET: base.extend({ evidenceItems: z.array(syntheticText).max(64) }).strict(),
  FINANCIAL_ANALYSIS: base.extend({ indicators: z.array(z.object({ code: syntheticText, value: z.number().finite() }).strict()).max(32) }).strict(),
  CREDIT_ANALYSIS: base.extend({ rating: syntheticText, confidence: score }).strict(),
  CALCULATION_SET: base.extend({ calculations: z.array(z.object({ code: syntheticText, value: z.number().finite() }).strict()).max(64) }).strict(),
  FINDINGS_DRAFT: base.extend({ findings: z.array(syntheticText).max(32) }).strict(),
  REPORT_DRAFT: base.extend({ sections: z.array(syntheticText).max(32) }).strict(),
  SCHEMA_REVIEW_REPORT: review,
  NUMERIC_REVIEW_REPORT: review,
  SOURCE_REVIEW_REPORT: review,
  RED_TEAM_REVIEW_REPORT: review,
  CORRECTED_REPORT: base.extend({ correctedSections: z.array(syntheticText).max(32) }).strict(),
  CORRECTION_MANIFEST: base.extend({ correctionReasons: z.array(syntheticText).max(32), supersededArtifactHashes: z.array(z.string().regex(HASH_RE)).max(16) }).strict(),
});
type ArtifactType = keyof typeof artifactSchemas;

const resultSchemas = Object.freeze({
  ...artifactSchemas,
  CORRECTION_RESULT: base.extend({ correctedReportHash: z.string().regex(HASH_RE), correctionManifestHash: z.string().regex(HASH_RE) }).strict(),
});
type ResultSchemaCode = keyof typeof resultSchemas;

const contractDefs = Object.freeze({
  DOCUMENT_INGESTION: { resultSchema: 'DOCUMENT_MANIFEST', artifacts: ['DOCUMENT_MANIFEST'] },
  DOCUMENT_CLASSIFICATION: { resultSchema: 'DOCUMENT_CLASSIFICATION', artifacts: ['DOCUMENT_CLASSIFICATION'] },
  EVIDENCE_EXTRACTION: { resultSchema: 'EVIDENCE_SET', artifacts: ['EVIDENCE_SET'] },
  FINANCIAL_ANALYSIS: { resultSchema: 'FINANCIAL_ANALYSIS', artifacts: ['FINANCIAL_ANALYSIS'] },
  CREDIT_ANALYSIS: { resultSchema: 'CREDIT_ANALYSIS', artifacts: ['CREDIT_ANALYSIS'] },
  CALCULATIONS: { resultSchema: 'CALCULATION_SET', artifacts: ['CALCULATION_SET'] },
  FINDINGS_DRAFTING: { resultSchema: 'FINDINGS_DRAFT', artifacts: ['FINDINGS_DRAFT'] },
  REPORT_COMPOSITION: { resultSchema: 'REPORT_DRAFT', artifacts: ['REPORT_DRAFT'] },
  SCHEMA_REVIEW: { resultSchema: 'SCHEMA_REVIEW_REPORT', artifacts: ['SCHEMA_REVIEW_REPORT'] },
  NUMERIC_REVIEW: { resultSchema: 'NUMERIC_REVIEW_REPORT', artifacts: ['NUMERIC_REVIEW_REPORT'] },
  SOURCE_REVIEW: { resultSchema: 'SOURCE_REVIEW_REPORT', artifacts: ['SOURCE_REVIEW_REPORT'] },
  RED_TEAM_REVIEW: { resultSchema: 'RED_TEAM_REVIEW_REPORT', artifacts: ['RED_TEAM_REVIEW_REPORT'] },
  CORRECTION: { resultSchema: 'CORRECTION_RESULT', artifacts: ['CORRECTED_REPORT', 'CORRECTION_MANIFEST'] },
} satisfies Record<FaiAuditJobCode, { resultSchema: ResultSchemaCode; artifacts: readonly ArtifactType[] }>);

const schemaDescriptions = Object.freeze({
  DOCUMENT_MANIFEST: { synthetic: 'literal:true', summary: 'syntheticText', documentCount: 'int:0..100' },
  DOCUMENT_CLASSIFICATION: { synthetic: 'literal:true', summary: 'syntheticText', classes: 'syntheticText[]<=16' },
  EVIDENCE_SET: { synthetic: 'literal:true', summary: 'syntheticText', evidenceItems: 'syntheticText[]<=64' },
  FINANCIAL_ANALYSIS: { synthetic: 'literal:true', summary: 'syntheticText', indicators: '{code,value}[]<=32' },
  CREDIT_ANALYSIS: { synthetic: 'literal:true', summary: 'syntheticText', rating: 'syntheticText', confidence: 'number:0..1' },
  CALCULATION_SET: { synthetic: 'literal:true', summary: 'syntheticText', calculations: '{code,value}[]<=64' },
  FINDINGS_DRAFT: { synthetic: 'literal:true', summary: 'syntheticText', findings: 'syntheticText[]<=32' },
  REPORT_DRAFT: { synthetic: 'literal:true', summary: 'syntheticText', sections: 'syntheticText[]<=32' },
  SCHEMA_REVIEW_REPORT: { synthetic: 'literal:true', summary: 'syntheticText', passed: 'boolean', issues: 'syntheticText[]<=16' },
  NUMERIC_REVIEW_REPORT: { synthetic: 'literal:true', summary: 'syntheticText', passed: 'boolean', issues: 'syntheticText[]<=16' },
  SOURCE_REVIEW_REPORT: { synthetic: 'literal:true', summary: 'syntheticText', passed: 'boolean', issues: 'syntheticText[]<=16' },
  RED_TEAM_REVIEW_REPORT: { synthetic: 'literal:true', summary: 'syntheticText', passed: 'boolean', issues: 'syntheticText[]<=16' },
  CORRECTED_REPORT: { synthetic: 'literal:true', summary: 'syntheticText', correctedSections: 'syntheticText[]<=32' },
  CORRECTION_MANIFEST: { synthetic: 'literal:true', summary: 'syntheticText', correctionReasons: 'syntheticText[]<=32', supersededArtifactHashes: 'sha256[]<=16' },
  CORRECTION_RESULT: { synthetic: 'literal:true', summary: 'syntheticText', correctedReportHash: 'sha256', correctionManifestHash: 'sha256' },
} satisfies Record<ResultSchemaCode, Record<string, string>>);

export const AiResultProvenanceSchema = z.object({
  runtimeId: z.string().min(1),
  jobId: z.string().min(1),
  attemptId: z.string().min(1),
  attemptSequence: z.number().int().min(1),
  fencingToken: z.string().regex(/^\d+$/),
  workerInstanceId: z.string().min(1).max(200),
  workerBuildHash: z.string().regex(HASH_RE),
  runtimePolicyHash: z.string().regex(HASH_RE),
  capabilityCode: upperCode,
  capabilityVersion: z.literal('1.0'),
  capabilityHash: z.string().regex(HASH_RE),
  handlerCode: identityCode,
  handlerVersion: z.literal('1.0'),
  jobPayloadHash: z.string().regex(HASH_RE),
  workflowInstanceId: z.string().min(1),
  workflowDefinitionHash: z.string().regex(HASH_RE),
  phaseCode: upperCode,
  phaseEntrySequence: z.number().int().min(1),
  correctionCycle: z.number().int().min(0),
  executorAgentId: z.string().min(1),
  executorAgentCode: identityCode,
  executorAgentConfigVersion: z.number().int().min(1),
  executorAgentConfigHash: z.string().regex(HASH_RE),
  provider: z.literal('mock'),
  dataMode: z.literal('synthetic'),
}).strict();
export type AiResultProvenance = z.infer<typeof AiResultProvenanceSchema>;

export const AiResultArtifactDraftSchema = z.object({
  resultPayload: z.unknown(),
  artifacts: z.array(z.object({
    ordinal: z.number().int().min(0),
    slotCode: upperCode,
    logicalKey,
    artifactType: upperCode,
    artifactVersion: z.literal('1.0'),
    mediaType: z.literal('application/json'),
    payload: z.unknown(),
    supersedesArtifactId: z.string().cuid().optional(),
  }).strict()).max(AI_RESULT_LIMITS.maxArtifacts),
  sourceReferences: z.array(z.object({ sourceArtifactId: z.string().cuid(), sourceArtifactHash: z.string().regex(HASH_RE), role: upperCode, ordinal: z.number().int().min(0) }).strict()).max(AI_RESULT_LIMITS.maxSourceReferences).default([]),
  retention: z.object({ policyCode: z.literal('AI_RESULT_ARTIFACT_RETENTION_V1'), policyVersion: z.literal('1.0'), retentionClass: z.enum(['AUDIT_SYNTHETIC', 'TEMPORARY_SYNTHETIC']), retainUntil: z.string().datetime({ offset: true }).optional() }).strict(),
}).strict();
export type AiResultArtifactDraft = z.infer<typeof AiResultArtifactDraftSchema>;

function freezeDeep<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    Object.values(value).forEach(freezeDeep);
  }
  return value as Readonly<T>;
}
function schemaHash(schemaCode: ResultSchemaCode) { return canonicalSha256({ domain: 'ai.schema.v1', schemaCode, version: '1.0', schema: schemaDescriptions[schemaCode] }); }
const contractEntries = FAI_AUDIT_JOB_CODES.map((jobCode) => {
  const capability = getAiOrchestratorWorkerCapability(jobCode)!;
  const def = contractDefs[jobCode];
  const artifactSchemaMetadata = Object.fromEntries(def.artifacts.map((artifactType) => [artifactType, { artifactSchemaCode: `${artifactType}_SCHEMA`, artifactSchemaVersion: '1.0', artifactSchemaHash: schemaHash(artifactType), description: schemaDescriptions[artifactType] }]));
  const resultSchemaMetadata = { resultSchemaCode: def.resultSchema, resultSchemaVersion: '1.0', resultSchemaHash: schemaHash(def.resultSchema), description: schemaDescriptions[def.resultSchema] };
  const identity = { schemaVersion: 1, catalogCode: AI_RESULT_CONTRACT_CATALOG_CODE, resultContractCode: `FAI_AUDIT_${jobCode}_RESULT`, resultContractVersion: AI_RESULT_CONTRACT_VERSION, jobCode, jobDefinitionHash: FAI_AUDIT_JOB_DEFINITION_HASHES[jobCode], capabilityHash: AI_ORCHESTRATOR_WORKER_CAPABILITY_HASHES[jobCode], handlerCode: capability.handlerCode, handlerVersion: capability.handlerVersion, runtimePolicyHash: AI_ORCHESTRATOR_WORKER_RUNTIME_POLICY_HASH, resultSchema: resultSchemaMetadata, artifactSchemas: artifactSchemaMetadata, supersessionAllowed: jobCode === 'CORRECTION' };
  return [jobCode, freezeDeep({ ...identity, resultContractHash: canonicalSha256({ domain: 'ai.resultContract.v1', ...identity }), requiredArtifactTypes: [...def.artifacts] })] as const;
});
const CONTRACTS = freezeDeep(Object.fromEntries(contractEntries) as unknown as Record<FaiAuditJobCode, Readonly<{ resultContractCode: string; resultContractVersion: '1.0'; resultContractHash: string; resultSchema: { resultSchemaCode: ResultSchemaCode; resultSchemaVersion: '1.0'; resultSchemaHash: string; description: Record<string, string> }; requiredArtifactTypes: readonly ArtifactType[]; artifactSchemas: Readonly<Record<string, { artifactSchemaCode: string; artifactSchemaVersion: '1.0'; artifactSchemaHash: string; description: Record<string, string> }>>; supersessionAllowed: boolean }>>);
const CONTRACT_BY_JOB = new Map<string, typeof CONTRACTS[FaiAuditJobCode]>(Object.entries(CONTRACTS));
export function getAiResultContract(jobCode: string) { return CONTRACT_BY_JOB.get(jobCode) ?? null; }
export function listAiResultContracts() { return Object.values(CONTRACTS); }
export const AI_RESULT_CONTRACT_CATALOG_HASH = canonicalSha256({ domain: 'ai.resultContractCatalog.v1', contracts: Object.fromEntries(Object.entries(CONTRACTS).map(([k, v]) => [k, { resultContractCode: v.resultContractCode, resultContractVersion: v.resultContractVersion, resultContractHash: v.resultContractHash, resultSchema: v.resultSchema, requiredArtifactTypes: v.requiredArtifactTypes, artifactSchemas: v.artifactSchemas, supersessionAllowed: v.supersessionAllowed }])) });

function inspectJson(value: unknown, depth = 1): { nodes: number; maxDepth: number } {
  if (depth > AI_RESULT_LIMITS.maxJsonDepth) throw new TypeError('AI_RESULT_JSON_TOO_DEEP');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return { nodes: 1, maxDepth: depth };
  if (typeof value === 'number') { if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) throw new TypeError('AI_RESULT_UNSAFE_NUMBER'); return { nodes: 1, maxDepth: depth }; }
  if (Array.isArray(value)) return value.reduce<{ nodes: number; maxDepth: number }>((a, v) => { const r = inspectJson(v, depth + 1); return { nodes: a.nodes + r.nodes, maxDepth: Math.max(a.maxDepth, r.maxDepth) }; }, { nodes: 1, maxDepth: depth });
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) return Object.values(value as Record<string, unknown>).reduce<{ nodes: number; maxDepth: number }>((a, v) => { const r = inspectJson(v, depth + 1); return { nodes: a.nodes + r.nodes, maxDepth: Math.max(a.maxDepth, r.maxDepth) }; }, { nodes: 1, maxDepth: depth });
  throw new TypeError('AI_RESULT_NON_JSON');
}
function assertPayload(value: unknown, limit: number) {
  const canonical = canonicalJson(value);
  const bytes = Buffer.byteLength(canonical, 'utf8');
  const i = inspectJson(value);
  if (i.nodes > AI_RESULT_LIMITS.maxJsonNodes) throw new TypeError('AI_RESULT_JSON_TOO_LARGE');
  if (bytes > limit) throw new TypeError('AI_RESULT_BYTES_TOO_LARGE');
  if (FORBIDDEN.test(canonical)) throw new TypeError('AI_RESULT_FORBIDDEN_CONTENT_REDACTED');
  return { canonical, bytes, payloadHash: sha256(`ai.payload.v1\n${canonical}`) };
}
function normalizeRetention(retention: AiResultArtifactDraft['retention']) {
  const retainUntil = retention.retainUntil ? new Date(retention.retainUntil) : null;
  if (retainUntil && Number.isNaN(retainUntil.getTime())) throw new TypeError('AI_RESULT_RETENTION_INVALID');
  const normalizedRetainUntil = retainUntil ? new Date(Math.trunc(retainUntil.getTime())).toISOString() : null;
  const normalized = { policyCode: retention.policyCode, policyVersion: retention.policyVersion, retentionClass: retention.retentionClass, retainUntil: normalizedRetainUntil };
  return { ...normalized, retentionPolicyHash: canonicalSha256({ domain: 'ai.retentionPolicy.v1', ...normalized }) };
}
function artifactHash(input: { artifactType: ArtifactType; ordinal: number; slotCode: string; logicalKey: string; artifactVersion: '1.0'; mediaType: 'application/json'; artifactSchemaHash: string; payloadHash: string; supersedesArtifactId: string | null }) {
  return canonicalSha256({ domain: 'ai.artifact.v1', ...input });
}
function parseArtifact(contract: NonNullable<ReturnType<typeof getAiResultContract>>, artifact: AiResultArtifactDraft['artifacts'][number], index: number) {
  if (artifact.ordinal !== index) throw new TypeError('AI_RESULT_ARTIFACT_ORDER_INVALID');
  const artifactType = artifact.artifactType as ArtifactType;
  const schemaMeta = contract.artifactSchemas[artifactType];
  if (!schemaMeta) throw new TypeError('AI_RESULT_ARTIFACT_NOT_ALLOWED');
  if (artifact.supersedesArtifactId && !contract.supersessionAllowed) throw new TypeError('AI_RESULT_SUPERSESSION_NOT_ALLOWED');
  if (contract.supersessionAllowed && artifact.artifactType === 'CORRECTION_MANIFEST' && artifact.supersedesArtifactId) throw new TypeError('AI_RESULT_SUPERSESSION_SLOT_INVALID');
  const parsedPayload = artifactSchemas[artifactType].parse(artifact.payload);
  const h = assertPayload(parsedPayload, AI_RESULT_LIMITS.maxArtifactBytes);
  return { ...artifact, artifactType, payload: parsedPayload, payloadBytes: h.bytes, payloadHash: h.payloadHash, artifactSchemaCode: schemaMeta.artifactSchemaCode, artifactSchemaVersion: schemaMeta.artifactSchemaVersion, artifactSchemaHash: schemaMeta.artifactSchemaHash, artifactHash: artifactHash({ artifactType, ordinal: artifact.ordinal, slotCode: artifact.slotCode, logicalKey: artifact.logicalKey, artifactVersion: artifact.artifactVersion, mediaType: artifact.mediaType, artifactSchemaHash: schemaMeta.artifactSchemaHash, payloadHash: h.payloadHash, supersedesArtifactId: artifact.supersedesArtifactId ?? null }) };
}

export function validateAndHashAiResultDraft(jobCode: string, draftInput: unknown, provenanceInput: unknown) {
  const contract = getAiResultContract(jobCode); if (!contract) throw new TypeError('AI_RESULT_CONTRACT_NOT_FOUND');
  const provenance = AiResultProvenanceSchema.parse(provenanceInput);
  const draft = AiResultArtifactDraftSchema.parse(draftInput);
  const expected = [...contract.requiredArtifactTypes].sort();
  const actual = draft.artifacts.map((a) => a.artifactType).sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new TypeError('AI_RESULT_ARTIFACT_CARDINALITY_INVALID');
  const seen = new Set<string>();
  const artifacts = [...draft.artifacts].sort((a, b) => a.ordinal - b.ordinal).map((artifact, index) => {
    if (seen.has(artifact.slotCode)) throw new TypeError('AI_RESULT_ARTIFACT_SLOT_DUPLICATE');
    seen.add(artifact.slotCode);
    return parseArtifact(contract, artifact, index);
  });
  const resultPayload = resultSchemas[contract.resultSchema.resultSchemaCode].parse(draft.resultPayload);
  const rp = assertPayload(resultPayload, AI_RESULT_LIMITS.maxResultBytes);
  if (artifacts.length === 1 && canonicalJson(resultPayload) !== canonicalJson(artifacts[0].payload)) throw new TypeError('AI_RESULT_PAYLOAD_ARTIFACT_MISMATCH');
  if (contract.resultSchema.resultSchemaCode === 'CORRECTION_RESULT') {
    const corrected = artifacts.find((a) => a.artifactType === 'CORRECTED_REPORT');
    const manifest = artifacts.find((a) => a.artifactType === 'CORRECTION_MANIFEST');
    const correctionPayload = resultPayload as { correctedReportHash: string; correctionManifestHash: string };
    if (!corrected || !manifest || correctionPayload.correctedReportHash !== corrected.artifactHash || correctionPayload.correctionManifestHash !== manifest.artifactHash) throw new TypeError('AI_RESULT_CORRECTION_HASH_MISMATCH');
    const superseded = artifacts.map((a) => a.supersedesArtifactId).filter(Boolean);
    const manifestSuperseded = (manifest.payload as { supersededArtifactHashes: string[] }).supersededArtifactHashes;
    if (superseded.length !== manifestSuperseded.length) throw new TypeError('AI_RESULT_CORRECTION_SUPERSESSION_MISMATCH');
  }
  const sourceReferences = [...draft.sourceReferences].sort((a, b) => a.ordinal - b.ordinal);
  sourceReferences.forEach((s, i) => { if (s.ordinal !== i) throw new TypeError('AI_RESULT_SOURCE_ORDER_INVALID'); });
  const retention = normalizeRetention(draft.retention);
  const totalPayloadBytes = rp.bytes + artifacts.reduce((n, a) => n + a.payloadBytes, 0);
  if (totalPayloadBytes > AI_RESULT_LIMITS.maxResultBytes) throw new TypeError('AI_RESULT_TOTAL_BYTES_TOO_LARGE');
  const manifestHash = canonicalSha256({ domain: 'ai.manifest.v1', artifactHashes: artifacts.map((a) => a.artifactHash), sourceReferences, retention });
  const resultHash = canonicalSha256({ domain: 'ai.result.v1', provenance, resultContractHash: contract.resultContractHash, resultPayloadHash: rp.payloadHash, manifestHash, artifactHashes: artifacts.map((a) => a.artifactHash), sourceReferences });
  return { contract, provenance, resultPayload, resultPayloadHash: rp.payloadHash, resultPayloadBytes: rp.bytes, artifacts, sourceReferences, retention, manifestHash, resultHash, resultContractHash: contract.resultContractHash, totalPayloadBytes };
}

export function createSyntheticAiResultDraft(jobCode: FaiAuditJobCode | string): AiResultArtifactDraft {
  const contract = getAiResultContract(jobCode)!;
  const payloadFor = (type: ArtifactType) => {
    switch (type) {
      case 'DOCUMENT_MANIFEST': return { synthetic: true, summary: 'synthetic summary', documentCount: 1 };
      case 'DOCUMENT_CLASSIFICATION': return { synthetic: true, summary: 'synthetic summary', classes: ['synthetic class'] };
      case 'EVIDENCE_SET': return { synthetic: true, summary: 'synthetic summary', evidenceItems: ['synthetic evidence'] };
      case 'FINANCIAL_ANALYSIS': return { synthetic: true, summary: 'synthetic summary', indicators: [{ code: 'SYN', value: 1 }] };
      case 'CREDIT_ANALYSIS': return { synthetic: true, summary: 'synthetic summary', rating: 'synthetic rating', confidence: 1 };
      case 'CALCULATION_SET': return { synthetic: true, summary: 'synthetic summary', calculations: [{ code: 'SYN', value: 1 }] };
      case 'FINDINGS_DRAFT': return { synthetic: true, summary: 'synthetic summary', findings: ['synthetic finding'] };
      case 'REPORT_DRAFT': return { synthetic: true, summary: 'synthetic summary', sections: ['synthetic section'] };
      case 'SCHEMA_REVIEW_REPORT': case 'NUMERIC_REVIEW_REPORT': case 'SOURCE_REVIEW_REPORT': case 'RED_TEAM_REVIEW_REPORT': return { synthetic: true, summary: 'synthetic summary', passed: true, issues: [] };
      case 'CORRECTED_REPORT': return { synthetic: true, summary: 'synthetic summary', correctedSections: ['synthetic section'] };
      case 'CORRECTION_MANIFEST': return { synthetic: true, summary: 'synthetic summary', correctionReasons: ['synthetic reason'], supersededArtifactHashes: [] };
    }
  };
  const artifacts = contract.requiredArtifactTypes.map((artifactType, ordinal) => ({ ordinal, slotCode: artifactType, logicalKey: `synthetic.${artifactType.toLowerCase()}`, artifactType, artifactVersion: '1.0' as const, mediaType: 'application/json' as const, payload: payloadFor(artifactType) }));
  const resultPayload = artifacts.length === 1 ? artifacts[0].payload : (() => {
    const parsed = artifacts.map((artifact, index) => parseArtifact(contract, artifact, index));
    return { synthetic: true, summary: 'synthetic summary', correctedReportHash: parsed.find((a) => a.artifactType === 'CORRECTED_REPORT')!.artifactHash, correctionManifestHash: parsed.find((a) => a.artifactType === 'CORRECTION_MANIFEST')!.artifactHash };
  })();
  return { resultPayload, artifacts, sourceReferences: [], retention: { policyCode: 'AI_RESULT_ARTIFACT_RETENTION_V1', policyVersion: '1.0', retentionClass: 'AUDIT_SYNTHETIC' } };
}
